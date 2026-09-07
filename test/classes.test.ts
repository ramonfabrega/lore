import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, pollShape, requestClass, rollup, taskRef } from '../src/classes'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { listPolls } from '../src/polls'
import { getTrace } from '../src/trace'

const TASK = '/private/tmp/claude-501/-Users-rf-studio-code-fun-attrition--claude-worktrees-att-capture/5fa6074c/tasks/bmvcpbo6a.output'

describe('classify', () => {
  test('a read of a task output file is a poll; a loop around a sleep in one call is a wait', () => {
    expect(classify('Bash', JSON.stringify({ command: `cat ${TASK}` }))).toBe('poll')
    expect(classify('Bash', JSON.stringify({ command: `tail -20 ${TASK} | grep done` }))).toBe('poll')
    // The attrition shape that passes by construction: until … do sleep … done, then a read.
    expect(classify('Bash', JSON.stringify({ command: `until ! pgrep -f glscan.sh >/dev/null; do sleep 15; done; cat ${TASK}` }))).toBe('wait')
    expect(classify('Bash', JSON.stringify({ command: 'while [ ! -f out ]; do\n  sleep 5\ndone' }))).toBe('wait')
    expect(classify('Bash', JSON.stringify({ command: 'sleep 30' }))).toBe('wait')
    // A sleep then a read of the task file is still the per-turn poll.
    expect(classify('Bash', JSON.stringify({ command: `sleep 5; cat ${TASK}` }))).toBe('poll')
    expect(classify('Bash', JSON.stringify({ command: 'cat docs/ORACLE.md | head' }))).toBe('shell')
    expect(classify('Bash', JSON.stringify({ command: 'cargo test' }))).toBe('shell')
  })

  test('the other tools class by name; TaskOutput by whether it blocks', () => {
    expect(classify('TaskOutput', '{"task_id":"b1","block":false}')).toBe('poll')
    expect(classify('TaskOutput', '{"task_id":"b1","block":true}')).toBe('wait')
    expect(classify('Monitor', '{"cmd":"…"}')).toBe('wait')
    expect(classify('Read', '{"file_path":"/u/a.rs"}')).toBe('read')
    expect(classify('Grep', '{}')).toBe('read')
    expect(classify('Edit', '{}')).toBe('write')
    expect(classify('Agent', '{}')).toBe('spawn')
    expect(classify('SendMessage', '{}')).toBe('relay')
    expect(classify('Skill', '{}')).toBe('other')
  })

  test('taskRef names the task a poll read', () => {
    expect(taskRef('Bash', JSON.stringify({ command: `cat ${TASK}` }))).toBe('bmvcpbo6a')
    expect(taskRef('TaskOutput', '{"task_id":"b1wb1psec"}')).toBe('b1wb1psec')
    expect(taskRef('Bash', '{"command":"ls"}')).toBeNull()
    expect(taskRef('Read', '{}')).toBeNull()
  })

  test('a request with several calls takes the highest class, poll first', () => {
    expect(requestClass(['read', 'poll'])).toBe('poll')
    expect(requestClass(['read', 'shell'])).toBe('shell')
    expect(requestClass(['wait', 'read'])).toBe('read')
    expect(requestClass([])).toBe('text')
  })
})

describe('rollup', () => {
  test('per class: requests, output, spend and share; unpriced poisons the class and the shares', () => {
    const rows = rollup(
      [
        { requestId: 'a', output: 10, listUsd: 1 },
        { requestId: 'b', output: 20, listUsd: 1 },
        { requestId: 'c', output: 30, listUsd: 2 },
        { requestId: 'd', output: 5, listUsd: 0.5 },
      ],
      new Map([
        ['a', 'poll'],
        ['b', 'poll'],
        ['c', 'read'],
      ]),
    )
    expect(rows).toEqual([
      { class: 'poll', requests: 2, output: 30, listUsd: 2, share: 0.444 },
      { class: 'read', requests: 1, output: 30, listUsd: 2, share: 0.444 },
      { class: 'text', requests: 1, output: 5, listUsd: 0.5, share: 0.111 },
    ])
    const unpriced = rollup([{ requestId: 'a', output: 1, listUsd: null }, { requestId: 'b', output: 1, listUsd: 1 }], new Map([['a', 'poll'], ['b', 'read']]))
    expect(unpriced.map((r) => [r.class, r.listUsd, r.share])).toEqual([
      ['read', 1, null],
      ['poll', null, null],
    ])
  })
})

describe('pollShape', () => {
  const at = (s: number) => `2026-09-07T01:00:${String(s).padStart(2, '0')}.000Z`
  test('consecutive same-file reads form runs of three or more; a check of one or two does not', () => {
    const p = pollShape([
      { ref: 'a', ts: at(0) },
      { ref: 'a', ts: at(5) },
      { ref: 'a', ts: at(9) },
      { ref: 'a', ts: at(14) },
      { ref: null, ts: at(20) }, // any other instruction breaks the run
      { ref: 'a', ts: at(25) },
      { ref: 'a', ts: at(30) },
      { ref: 'b', ts: at(40) },
    ])
    expect(p).toEqual({ reads: 7, files: 2, rereads: 5, runs: 1, longest: 4, inRuns: 4, medianGapS: 5 })
  })

  test('two jobs watched alternately never run — the lint still sees the re-reads', () => {
    const p = pollShape([
      { ref: 'a', ts: at(0) },
      { ref: 'b', ts: at(4) },
      { ref: 'a', ts: at(8) },
      { ref: 'b', ts: at(12) },
      { ref: 'a', ts: at(16) },
      { ref: 'b', ts: at(20) },
    ])
    expect(p).toEqual({ reads: 6, files: 2, rereads: 4, runs: 0, longest: 1, inRuns: 0, medianGapS: null })
  })

  test('nothing read is all zeros, not nulls — measured, none', () => {
    expect(pollShape([{ ref: null, ts: at(0) }])).toEqual({ reads: 0, files: 0, rereads: 0, runs: 0, longest: 0, inRuns: 0, medianGapS: null })
  })
})

// One seeded session in the real record shapes (trace.test.ts): a lane that
// starts a scan, polls its task file three turns in a row, reads a doc, then
// polls twice more — and a second session that never touched a task file.
const JOB = 'job-2222'
function prompt(sess: string, ts: string, promptId: string, text: string) {
  return JSON.stringify({ type: 'user', timestamp: ts, promptId, session_id: JOB, sessionId: sess, message: { role: 'user', content: text } })
}
function call(sess: string, ts: string, id: string, toolId: string, name: string, input: unknown, output = 50) {
  return JSON.stringify({
    type: 'assistant', timestamp: ts, session_id: JOB, sessionId: sess,
    message: {
      id, model: 'claude-opus-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolId, name, input }],
      usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 100000, output_tokens: output },
    },
  })
}
function result(sess: string, ts: string, promptId: string, toolId: string, text: string) {
  return JSON.stringify({
    type: 'user', timestamp: ts, promptId, session_id: JOB, sessionId: sess, sourceToolAssistantUUID: 'x',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: text, is_error: false }] },
  })
}
function done(sess: string, ts: string, id: string) {
  return JSON.stringify({
    type: 'assistant', timestamp: ts, session_id: JOB, sessionId: sess,
    message: { id, model: 'claude-opus-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Scan landed.' }], usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 100000, output_tokens: 10 } },
  })
}
const T = (s: number) => `2026-09-07T02:00:${String(s).padStart(2, '0')}.000Z`
const A = 'lane-1'
const B = 'quiet-1'
const LANE = [
  prompt(A, T(0), 'p1', 'run the scan'),
  call(A, T(1), 'm1', 't1', 'Bash', { command: 'zsh tools/glscan.sh &' }),
  result(A, T(2), 'p1', 't1', 'started'),
  call(A, T(5), 'm2', 't2', 'Bash', { command: `cat ${TASK}` }),
  result(A, T(6), 'p1', 't2', ''),
  call(A, T(10), 'm3', 't3', 'Bash', { command: `cat ${TASK}` }),
  result(A, T(11), 'p1', 't3', ''),
  call(A, T(15), 'm4', 't4', 'Bash', { command: `cat ${TASK}` }),
  result(A, T(16), 'p1', 't4', ''),
  call(A, T(20), 'm5', 't5', 'Read', { file_path: '/u/docs/ORACLE.md' }),
  result(A, T(21), 'p1', 't5', 'the oracle'),
  call(A, T(25), 'm6', 't6', 'Bash', { command: `cat ${TASK}` }),
  result(A, T(26), 'p1', 't6', ''),
  call(A, T(30), 'm7', 't7', 'Bash', { command: `cat ${TASK}` }),
  result(A, T(31), 'p1', 't7', 'done'),
  done(A, T(35), 'm8'),
]
const QUIET = [
  prompt(B, T(0), 'q1', 'read the doc'),
  call(B, T(1), 'n1', 'u1', 'Read', { file_path: '/u/docs/ORACLE.md' }),
  result(B, T(2), 'q1', 'u1', 'the oracle'),
  done(B, T(3), 'n2'),
]

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'lore-classes-'))
  const well = join(dir, '-u-code-fun-app')
  mkdirSync(well, { recursive: true })
  writeFileSync(join(well, `${A}.jsonl`), `${LANE.join('\n')}\n`)
  writeFileSync(join(well, `${B}.jsonl`), `${QUIET.join('\n')}\n`)
  return dir
}

describe('trace classes and polls; lore polls', () => {
  test('the trace says what each request was spent on and how the session polled', async () => {
    const db = openDb(':memory:')
    const projectsDir = seed()
    await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })

    const t = getTrace(db, A, { limit: 10 })
    expect(t.classes.map((c) => [c.class, c.requests])).toEqual([
      ['poll', 5],
      ['shell', 1],
      ['read', 1],
      ['text', 1],
    ])
    // Every request here is priced, so shares sum to one.
    expect(t.classes.reduce((s, c) => s + (c.share ?? 0), 0)).toBeCloseTo(1, 2)
    // Three in a row, a Read, then two: one run of three; five reads of one
    // file, four of them re-reads; five seconds between the adjacent ones.
    expect(t.polls).toEqual({ reads: 5, files: 1, rereads: 4, runs: 1, longest: 3, inRuns: 3, medianGapS: 5 })

    const quiet = getTrace(db, B, { limit: 10 })
    expect(quiet.classes.map((c) => c.class)).toEqual(['read', 'text'])
    expect(quiet.polls.reads).toBe(0)
  })

  test('lore polls lists the sessions that polled, worst first, priced, and leaves the quiet one out', async () => {
    const db = openDb(':memory:')
    const projectsDir = seed()
    await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })

    const p = listPolls(db, { limit: 10 })
    expect(p.count).toBe(1)
    const row = p.sessions[0]!
    expect(row.sessionId).toBe(A)
    expect([row.reads, row.files, row.rereads, row.runs, row.longest, row.inRuns, row.medianGapS]).toEqual([5, 1, 4, 1, 3, 3, 5])
    expect(row.pollRequests).toBe(5)
    // opus-5: five requests at (2×5 + 1000×6.25 + 100000×0.5 + 50×25) µ$ = 5 × 57,510 → 0.29
    expect(row.pollUsd).toBe(0.29)
    expect(p.totals).toEqual({ reads: 5, inRuns: 3, rereads: 4, pollRequests: 5, pollUsd: 0.29 })

    // The window filter is activity-based, like `sessions --since`.
    expect(listPolls(db, { since: '2026-09-08', limit: 10 }).count).toBe(0)
    expect(listPolls(db, { well: 'fun-app', limit: 10 }).count).toBe(1)
  })
})
