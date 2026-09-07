import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, idleShape, pollShape, requestClass, rollup, taskRef } from '../src/classes'
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

  test('a command that runs nothing is idle, and the test is narrow on purpose', () => {
    // lane-286's loop, verbatim from its transcript.
    expect(classify('Bash', JSON.stringify({ command: 'true' }))).toBe('idle')
    expect(classify('Bash', JSON.stringify({ command: 'echo waiting' }))).toBe('idle')
    expect(classify('Bash', JSON.stringify({ command: ':' }))).toBe('idle')
    expect(classify('Bash', JSON.stringify({ command: 'true;' }))).toBe('idle')
    expect(classify('Bash', JSON.stringify({ command: '' }))).toBe('idle')
    expect(classify('Bash', JSON.stringify({ command: '  ' }))).toBe('idle')
    expect(classify('Bash', JSON.stringify({ command: 'echo -n done' }))).toBe('idle')
    expect(classify('Bash', JSON.stringify({ command: 'echo "still here"' }))).toBe('idle')
    // loop-258's spelling, 275 of them: the reason this matches a literal
    // echo at all, and the reason a scan for `true` alone found 5 not 282.
    expect(classify('Bash', JSON.stringify({ command: 'echo .' }))).toBe('idle')

    // Everything that does something falls through to `shell`. A false
    // positive here accuses a lane of waste, so the doubt goes that way.
    expect(classify('Bash', JSON.stringify({ command: 'echo $PWD' }))).toBe('shell')
    expect(classify('Bash', JSON.stringify({ command: 'echo "$(date)"' }))).toBe('shell')
    expect(classify('Bash', JSON.stringify({ command: 'echo hi | wc -l' }))).toBe('shell')
    expect(classify('Bash', JSON.stringify({ command: 'echo hi > marker' }))).toBe('shell')
    expect(classify('Bash', JSON.stringify({ command: 'echo start; cargo test' }))).toBe('shell')
    expect(classify('Bash', JSON.stringify({ command: 'true && cargo test' }))).toBe('shell')
    expect(classify('Bash', JSON.stringify({ command: 'truename --version' }))).toBe('shell')
    // A bare sleep is still the cheap, honest wait: one request, not 107.
    expect(classify('Bash', JSON.stringify({ command: 'sleep 30' }))).toBe('wait')
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
    // And idle ranks last above text: a turn that ran `true` AND something
    // real did something, so only an all-nothing turn is idle.
    expect(requestClass(['idle', 'shell'])).toBe('shell')
    expect(requestClass(['idle'])).toBe('idle')
    expect(requestClass(['idle', 'text'])).toBe('idle')
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

describe('idleShape', () => {
  const at = (s: number) => `2026-09-07T20:29:${String(s).padStart(2, '0')}.000Z`

  test('a stretch of nothing is counted from the FIRST — there is no honest idle turn', () => {
    expect(
      idleShape([
        { idle: false, ts: at(0) },
        { idle: true, ts: at(2) },
        { idle: true, ts: at(4) },
        { idle: true, ts: at(6) },
      ]),
    ).toEqual({ idles: 3, longestIdle: 3, medianIdleGapS: 2 })
  })

  test('real work breaks the stretch but does not forgive it', () => {
    expect(
      idleShape([
        { idle: true, ts: at(0) },
        { idle: true, ts: at(2) },
        { idle: false, ts: at(10) },
        { idle: true, ts: at(20) },
      ]),
    ).toEqual({ idles: 3, longestIdle: 2, medianIdleGapS: 2 })
  })

  test('a session that idled never is all zeros', () => {
    expect(idleShape([{ idle: false, ts: at(0) }])).toEqual({ idles: 0, longestIdle: 0, medianIdleGapS: null })
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
// lane-286's shape (09-07): the wait IS backgrounded — the canon rule
// obeyed to the letter — and then the turn is held open on nothing while
// the notification the harness already owes it is on its way. It never
// reads the task file, so the polling shape stays at zero and only the
// idle shape sees it. That is the whole reason this lane is in the fixture.
const C = 'idle-1'
const IDLE = [
  prompt(C, T(0), 'r1', 'run the capture'),
  call(C, T(1), 'i1', 'v1', 'Bash', { command: 'until grep -q done log; do sleep 10; done', run_in_background: true }),
  result(C, T(2), 'r1', 'v1', 'Command running in background with ID: bq1'),
  call(C, T(4), 'i2', 'v2', 'Bash', { command: 'echo waiting' }),
  result(C, T(5), 'r1', 'v2', 'waiting'),
  call(C, T(6), 'i3', 'v3', 'Bash', { command: 'true' }),
  result(C, T(7), 'r1', 'v3', ''),
  call(C, T(8), 'i4', 'v4', 'Bash', { command: 'true' }),
  result(C, T(9), 'r1', 'v4', ''),
  call(C, T(10), 'i5', 'v5', 'Bash', { command: ':' }),
  result(C, T(11), 'r1', 'v5', ''),
  call(C, T(20), 'i6', 'v6', 'Bash', { command: 'cargo test' }),
  result(C, T(21), 'r1', 'v6', 'ok'),
  done(C, T(25), 'i7'),
]

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'lore-classes-'))
  const well = join(dir, '-u-code-fun-app')
  mkdirSync(well, { recursive: true })
  writeFileSync(join(well, `${A}.jsonl`), `${LANE.join('\n')}\n`)
  writeFileSync(join(well, `${B}.jsonl`), `${QUIET.join('\n')}\n`)
  writeFileSync(join(well, `${C}.jsonl`), `${IDLE.join('\n')}\n`)
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

    expect(t.idle).toEqual({ idles: 0, longestIdle: 0, medianIdleGapS: null })

    const quiet = getTrace(db, B, { limit: 10 })
    expect(quiet.classes.map((c) => c.class)).toEqual(['read', 'text'])
    expect(quiet.polls.reads).toBe(0)
    expect(quiet.idle.idles).toBe(0)
  })

  test('the idle lane read no task file, so only the idle shape sees it', () => {
    const db = openDb(':memory:')
    const projectsDir = seed()
    return buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') }).then(() => {
      const t = getTrace(db, C, { limit: 10 })
      // The four no-ops are the session's biggest class by spend — more
      // than the wait it backgrounded and the test it eventually ran.
      expect(t.classes[0]).toMatchObject({ class: 'idle', requests: 4 })
      expect(t.classes.map((c) => c.class).sort()).toEqual(['idle', 'shell', 'text', 'wait'])
      // Zero polls: it never read the task file. The old lint saw nothing.
      expect(t.polls.reads).toBe(0)
      expect(t.idle).toEqual({ idles: 4, longestIdle: 4, medianIdleGapS: 2 })
    })
  })

  test('lore polls lists the sessions that polled, worst first, priced, and leaves the quiet one out', async () => {
    const db = openDb(':memory:')
    const projectsDir = seed()
    await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })

    const p = listPolls(db, { limit: 10 })
    // Two rows now: the poller and the idler. The quiet session, which
    // neither read a task file nor idled, is still out.
    expect(p.count).toBe(2)
    const row = p.sessions[0]!
    expect(row.sessionId).toBe(A)
    expect([row.reads, row.files, row.rereads, row.runs, row.longest, row.inRuns, row.medianGapS]).toEqual([5, 1, 4, 1, 3, 3, 5])
    expect(row.pollRequests).toBe(5)
    // opus-5: five requests at (2×5 + 1000×6.25 + 100000×0.5 + 50×25) µ$ = 5 × 57,510 → 0.29
    expect(row.pollUsd).toBe(0.29)
    expect([row.idles, row.idleRequests, row.idleUsd]).toEqual([0, 0, 0])
    expect(row.wastedUsd).toBe(0.29)

    // The idler is a row on the strength of its no-ops alone — reads 0,
    // which under the first version of this lint meant `continue`.
    const idler = p.sessions[1]!
    expect(idler.sessionId).toBe(C)
    expect(idler.reads).toBe(0)
    expect([idler.idles, idler.longestIdle, idler.medianIdleGapS]).toEqual([4, 4, 2])
    // Four of the same requests: 4 × 57,510 µ$ → 0.23.
    expect([idler.idleRequests, idler.idleUsd, idler.wastedUsd]).toEqual([4, 0.23, 0.23])

    expect(p.totals).toEqual({
      reads: 5,
      inRuns: 3,
      rereads: 4,
      pollRequests: 5,
      pollUsd: 0.29,
      idles: 4,
      idleRequests: 4,
      idleUsd: 0.23,
      wastedUsd: 0.52,
    })

    // Worst first is worst BY PRICE: the poller leads on 0.29 to 0.23, and
    // would lose the lead the moment the idler ran two more no-ops.
    expect(p.sessions.map((r) => r.wastedUsd)).toEqual([0.29, 0.23])

    // The window filter is activity-based, like `sessions --since`.
    expect(listPolls(db, { since: '2026-09-08', limit: 10 }).count).toBe(0)
    expect(listPolls(db, { well: 'fun-app', limit: 10 }).count).toBe(2)
  })
})
