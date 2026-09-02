import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { getTrace } from '../src/trace'

// A two-transaction session in the real record shapes (2026-09-01, an
// autonomous loop session): the user prompt carries promptId; the assistant's request is ONE
// LINE PER CONTENT BLOCK sharing message.id (text line, then tool_use line,
// usage repeated on both); the tool_result comes back on a user record with
// the same promptId and tool_use_id; a later request closes with text.
const JOB = 'job-1111'
function prompt(ts: string, promptId: string, text: string) {
  return JSON.stringify({ type: 'user', timestamp: ts, promptId, session_id: JOB, sessionId: 'sess-1', message: { role: 'user', content: text } })
}
function command(ts: string, promptId: string, name: string) {
  return JSON.stringify({
    type: 'user', timestamp: ts, promptId, session_id: JOB, sessionId: 'sess-1',
    message: { role: 'user', content: `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>` },
  })
}
function relay(ts: string, promptId: string, from: string, body: string) {
  return JSON.stringify({
    type: 'user', timestamp: ts, promptId, session_id: JOB, sessionId: 'sess-1',
    origin: { kind: 'peer', name: from },
    message: {
      role: 'user',
      content: `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/85001.sock" from-name="${from}" from-mode="prompting">\n${body}\n</cross-session-message>\n\nThis came from another Claude session — not typed by your user.`,
    },
  })
}
function taskNotification(ts: string, promptId: string, summary: string) {
  return JSON.stringify({
    type: 'user', timestamp: ts, promptId, session_id: JOB, sessionId: 'sess-1',
    isMeta: true, origin: { kind: 'task-notification' },
    message: { role: 'user', content: `<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>` },
  })
}
function assistant(ts: string, id: string, content: unknown[], output: number, stop = 'tool_use') {
  return JSON.stringify({
    type: 'assistant', timestamp: ts, effort: 'high', session_id: JOB, sessionId: 'sess-1',
    message: {
      id, model: 'claude-opus-5', role: 'assistant', stop_reason: stop, content,
      usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 100000, output_tokens: output, output_tokens_details: { thinking_tokens: 5 } },
    },
  })
}
function result(ts: string, promptId: string, toolUseId: string, text: string, isError = false) {
  return JSON.stringify({
    type: 'user', timestamp: ts, promptId, session_id: JOB, sessionId: 'sess-1', sourceToolAssistantUUID: 'x',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }] },
  })
}

function seed(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'lore-trace-'))
  const well = join(dir, '-u-code-fun-app')
  mkdirSync(well, { recursive: true })
  writeFileSync(join(well, 'sess-1.jsonl'), `${lines.join('\n')}\n`)
  return dir
}

const LINES = [
  prompt('2026-09-01T10:00:00.000Z', 'p1', 'fix the failing test'),
  assistant('2026-09-01T10:00:05.000Z', 'msg_1', [{ type: 'text', text: 'Looking.' }], 20),
  assistant('2026-09-01T10:00:05.500Z', 'msg_1', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'cargo test' } }], 50),
  result('2026-09-01T10:00:35.000Z', 'p1', 'tu_1', 'error: test failed', true),
  assistant('2026-09-01T10:00:40.000Z', 'msg_2', [{ type: 'tool_use', id: 'tu_2', name: 'Edit', input: { file_path: '/u/a.rs' } }], 80),
  result('2026-09-01T10:00:41.000Z', 'p1', 'tu_2', 'ok'),
  assistant('2026-09-01T10:00:50.000Z', 'msg_3', [{ type: 'text', text: 'Fixed the off-by-one.' }], 120, 'end_turn'),
  command('2026-09-01T10:05:00.000Z', 'p2', 'clear'),
  prompt('2026-09-01T10:06:00.000Z', 'p3', 'continue'),
  assistant('2026-09-01T10:06:10.000Z', 'msg_4', [{ type: 'text', text: 'Done.' }], 10, 'end_turn'),
]

describe('getTrace', () => {
  test('transactions group by prompt id; instructions pair with results; fees come from requests', async () => {
    const db = openDb(':memory:')
    const projectsDir = seed(LINES)
    await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })

    const t = getTrace(db, 'sess', { limit: 10 })
    expect(t.session.jobSessionId).toBe(JOB)
    expect(t.transactions.map((x) => [x.kind, x.tag, x.prompt])).toEqual([
      ['prompt', null, 'fix the failing test'],
      ['command', null, '/clear'],
      ['prompt', null, 'continue'],
    ])
    const first = t.transactions[0]!
    expect(first.steps).toBe(3)
    // Latency runs from the tool_use block's own line (10:00:05.5).
    expect(first.instructions.map((i) => [i.tool, i.ms, i.error])).toEqual([
      ['Bash', 29500, true],
      ['Edit', 1000, false],
    ])
    expect(first.instructions[0]!.input).toBe('{"command":"cargo test"}')
    expect(first.instructions[0]!.result).toBe('error: test failed')
    expect(first.errors).toBe(1)
    expect(first.output).toBe(250)
    expect(first.thinking).toBe(15)
    expect(first.reply).toBe('Fixed the off-by-one.')
    // "Looking." came before any instruction: a note heading phase 1. The
    // closing text is the reply, never also a note. Each instruction knows
    // its step.
    expect(first.notes).toEqual([{ at: 0, ts: '2026-09-01T10:00:05.000Z', text: 'Looking.' }])
    expect(first.instructions.map((i) => i.requestId)).toEqual(['msg_1', 'msg_2'])
    expect(first.thoughts).toEqual([])
    expect(first.ms).toBe(50000)
    // opus-5, per request (2×5 + 1000×6.25 + 100000×0.5 + out×25) µ$: 3×56260 + 25×250 = 175,030 → 0.18
    expect(first.listUsd).toBe(0.18)
    expect(t.totals.transactions).toBe(3)
    expect(t.totals.steps).toBe(4)
    expect(t.totals.instructions).toBe(2)
    expect(t.totals.errors).toBe(1)
    expect(t.totals.listUsd).toBe(0.23) // + msg_4: 56,510 µ$
    expect(t.transactions[1]!.steps).toBe(0)
  })

  // Two agents in one session: a peer relaying in, and the harness reporting
  // a finished background agent. Both arrive as `user` records, and both
  // wear an envelope longer than a spine row — the block view takes it off.
  test('a relay is a turn with its sender; a harness injection is neither numbered nor counted', async () => {
    const db = openDb(':memory:')
    const projectsDir = seed([
      prompt('2026-09-01T11:00:00.000Z', 'q1', 'standby for a brief from @lore'),
      assistant('2026-09-01T11:00:05.000Z', 'm1', [{ type: 'text', text: 'Standing by.' }], 10, 'end_turn'),
      relay('2026-09-01T11:01:00.000Z', 'q2', 'lore', 'Corpus is at ~/.lore/wells-corpus.jsonl.'),
      assistant('2026-09-01T11:01:05.000Z', 'm2', [{ type: 'text', text: 'Taken.' }], 10, 'end_turn'),
      taskNotification('2026-09-01T11:02:00.000Z', 'q3', 'Agent "glyph atlas" finished'),
      assistant('2026-09-01T11:02:05.000Z', 'm3', [{ type: 'text', text: 'Read it.' }], 10, 'end_turn'),
    ])
    await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })

    const t = getTrace(db, 'sess-1', { limit: 10 })
    expect(t.transactions.map((x) => [x.kind, x.tag, x.prompt])).toEqual([
      ['prompt', null, 'standby for a brief from @lore'],
      // The envelope becomes the tag; the message stays the text — no socket
      // path, no standing trailer, and the peer comes off `messages.peer`.
      ['relay', 'lore', 'Corpus is at ~/.lore/wells-corpus.jsonl.'],
      ['meta', 'task', 'Agent "glyph atlas" finished'],
    ])
    // A turn is what somebody OPENED. The notification opened nothing.
    expect(t.totals.transactions).toBe(2)
  })

  // The row is a preview and the body is the message. Carrying the full text
  // only when the row cannot show it keeps a short prompt from being sent
  // twice — and the trigger is truncation or lost paragraphs, NOT a length
  // comparison against the preview, which can never differ from it.
  test('a message the row cannot show is carried in full; a short one is not', async () => {
    const db = openDb(':memory:')
    const long = `${'word '.repeat(60)}\n\nsecond paragraph`
    const projectsDir = seed([
      prompt('2026-09-01T12:00:00.000Z', 'r1', 'short one'),
      assistant('2026-09-01T12:00:05.000Z', 'n1', [{ type: 'text', text: 'ok' }], 10, 'end_turn'),
      prompt('2026-09-01T12:01:00.000Z', 'r2', long),
      assistant('2026-09-01T12:01:05.000Z', 'n2', [{ type: 'text', text: 'ok' }], 10, 'end_turn'),
    ])
    await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })

    const t = getTrace(db, 'sess-1', { limit: 10, head: 60, proseHead: 5000 })
    expect(t.transactions[0]!.prompt).toBe('short one')
    expect(t.transactions[0]!.message).toBeNull()

    const big = t.transactions[1]!
    expect(big.prompt.endsWith('…')).toBe(true)
    expect(big.prompt.length).toBe(60)
    expect(big.message).toContain('second paragraph')
    expect(big.message).toContain('\n\n')
    // proseHead defaults to head, so an unchanged caller sees no growth.
    expect(getTrace(db, 'sess-1', { limit: 10, head: 60 }).transactions[1]!.message!.length).toBeLessThanOrEqual(60)
  })

  test('--steps expands requests; --head trims; --limit pages transactions but not totals', async () => {
    const db = openDb(':memory:')
    const projectsDir = seed(LINES)
    await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })
    const t = getTrace(db, 'sess-1', { limit: 1, steps: true, head: 8 })
    expect(t.transactions).toHaveLength(1)
    expect(t.totals.transactions).toBe(3)
    expect(t.transactions[0]!.prompt).toBe('fix the…')
    expect(t.transactions[0]!.requests?.map((r) => [r.requestId, r.stopReason, r.output])).toEqual([
      ['msg_1', 'tool_use', 50],
      ['msg_2', 'tool_use', 80],
      ['msg_3', 'end_turn', 120],
    ])
  })

  test('v13 columns land on messages', async () => {
    const db = openDb(':memory:')
    const projectsDir = seed(LINES)
    await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })
    const rows = z
      .array(z.object({ lane: z.string(), type: z.string(), prompt_id: z.string().nullable(), tool_use_id: z.string().nullable(), is_error: z.number(), request_id: z.string().nullable() }))
      .parse(db.prepare("SELECT lane, type, prompt_id, tool_use_id, is_error, request_id FROM messages WHERE lane = 'tool' ORDER BY id").all())
    expect(rows).toEqual([
      { lane: 'tool', type: 'assistant', prompt_id: 'p1', tool_use_id: 'tu_1', is_error: 0, request_id: 'msg_1' },
      { lane: 'tool', type: 'user', prompt_id: 'p1', tool_use_id: 'tu_1', is_error: 1, request_id: null },
      { lane: 'tool', type: 'assistant', prompt_id: 'p1', tool_use_id: 'tu_2', is_error: 0, request_id: 'msg_2' },
      { lane: 'tool', type: 'user', prompt_id: 'p1', tool_use_id: 'tu_2', is_error: 0, request_id: null },
    ])
  })
})
