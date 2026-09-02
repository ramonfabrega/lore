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

// What arrives while the turn runs: an `attachment` hung off the last tool
// result, never a user record, and with no promptId of its own.
function queued(ts: string, a: object) {
  return JSON.stringify({
    type: 'attachment', timestamp: ts, session_id: JOB, sessionId: 'sess-1', parentUuid: 'x',
    attachment: { type: 'queued_command', commandMode: 'prompt', source_uuid: 'q', timestamp: ts, ...a },
  })
}
function queuedRelay(ts: string, from: string, body: string) {
  return queued(ts, {
    prompt: `<cross-session-message from="uds:/tmp/cc-socks/61989.sock" from-name="${from}" from-mode="prompting">\n${body}\n</cross-session-message>`,
    isMeta: true,
    origin: { kind: 'peer', name: from, from: 'uds:/tmp/cc-socks/61989.sock', body },
  })
}
function bridge(ts: string) {
  return JSON.stringify({ type: 'bridge-session', timestamp: ts, sessionId: 'sess-1', bridgeSessionId: 'cse_01RGFNuvyhAq1Mzs6ZcVX7r2' })
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

  // The lore↔ccc thread of 2026-09-02, in miniature: ccc's turn ran 44
  // minutes and lore answered six times INTO it. None of those six opened a
  // turn — they were read at the next tool result — and until v16 none of
  // them, nor the user's own mid-turn words, existed on the page at all.
  test('a message read mid-turn sits inside the turn at its position; it opens nothing', async () => {
    const db = openDb(':memory:')
    const projectsDir = seed([
      prompt('2026-09-02T08:13:33.000Z', 'p1', 'merge it into master and start v1'),
      bridge('2026-09-02T08:13:34.000Z'),
      assistant('2026-09-02T08:13:40.000Z', 'm1', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'swift build' } }], 20),
      result('2026-09-02T08:14:00.000Z', 'p1', 'tu_1', 'ok'),
      queuedRelay('2026-09-02T08:14:20.000Z', 'lore', 'Verified 0e7d316 and then stress-tested the rest.'),
      queued('2026-09-02T08:23:52.000Z', { prompt: 'i think we want to give ghostty a solid shot', origin: { kind: 'human' } }),
      assistant('2026-09-02T08:24:00.000Z', 'm2', [{ type: 'tool_use', id: 'tu_2', name: 'Edit', input: { file_path: '/u/Pane.swift' } }], 30),
      result('2026-09-02T08:24:01.000Z', 'p1', 'tu_2', 'ok'),
      assistant('2026-09-02T08:24:05.000Z', 'm3', [{ type: 'tool_use', id: 'tu_3', name: 'SendMessage', input: { to: 'af80d234d489e766f', summary: 'Fix bold glyph drop', message: 'Follow-up on your renderer.' } }], 30),
      result('2026-09-02T08:24:06.000Z', 'p1', 'tu_3', '{"success":true}'),
      queued('2026-09-02T08:26:36.000Z', { commandMode: 'task-notification', prompt: '<task-notification>\n<task-id>af80d234d489e766f</task-id>\n<status>completed</status>\n<summary>Agent "Metal renderer" finished</summary>\n</task-notification>' }),
      assistant('2026-09-02T08:27:00.000Z', 'm4', [{ type: 'text', text: 'v1 pane is live.' }], 40, 'end_turn'),
    ])
    await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })
    // The session's own spawn, as the observatory would have indexed it.
    db.prepare("INSERT INTO spawns(well_dir, session_id, agent_id, agent_type, description, size, mtime_ms) VALUES('w', 'sess-1', 'af80d234d489e766f', 'lean', 'Metal cell-grid renderer + glyph atlas', 0, 0)").run()
    // A job that has respawned: state.json still names the FIRST root, which
    // matches nothing here; the bridge id is the join that holds.
    db.prepare("INSERT INTO jobs(job_id, session_id, bridge_key, name) VALUES('b3919c35', 'first-root-of-july', '01RGFNuvyhAq1Mzs6ZcVX7r2', 'ccc')").run()

    const t = getTrace(db, 'sess-1', { limit: 10 })
    expect(t.session.name).toBe('ccc')
    // One turn. The six things that arrived did not open any.
    expect(t.transactions.map((x) => x.kind)).toEqual(['prompt'])
    expect(t.totals.transactions).toBe(1)
    const x = t.transactions[0]!
    expect(x.instructions.map((i) => i.tool)).toEqual(['Bash', 'Edit', 'SendMessage'])
    // Placed at the instruction cursor, envelope off, sender attributed:
    // after Bash (at 1), after Bash still (at 1), after the SendMessage (at 3).
    expect(x.received).toEqual([
      { at: 1, ts: '2026-09-02T08:14:20.000Z', kind: 'relay', tag: 'lore', text: 'Verified 0e7d316 and then stress-tested the rest.' },
      { at: 1, ts: '2026-09-02T08:23:52.000Z', kind: 'prompt', tag: null, text: 'i think we want to give ghostty a solid shot' },
      { at: 3, ts: '2026-09-02T08:26:36.000Z', kind: 'meta', tag: 'task', text: 'Agent "Metal renderer" finished' },
    ])
    // The follow-up went to the session's own spawn, not to a peer.
    expect(x.sent).toEqual([{ to: 'af80d234d489e766f', name: null, agent: 'Metal cell-grid renderer + glyph atlas', summary: 'Fix bold glyph drop' }])
    expect(x.instructions[2]!.toAgent).toBe('Metal cell-grid renderer + glyph atlas')
    expect(x.reply).toBe('v1 pane is live.')
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
