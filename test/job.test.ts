import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { backfillJobNames, listJobs, resolveJob, spawnEdges } from '../src/job'
import { indexJobs } from '../src/jobs'
import { resolveSide } from '../src/thread'

// Four jobs, one of each shape the corpus has (job.ts): a bridge-keyed job
// the daemon still lists (lore: two sessions, a respawn between them), a
// bridge-keyed job the daemon has DELETED (ccc: no state.json, its name only
// in lore's rows), a root-keyed pre-bridge job (old), and an interactive
// session (solo), which is a job of one.

type Rec = Record<string, unknown>
const line = (r: Rec) => JSON.stringify(r)
const bridge = (sessionId: string, cse: string, ts = '2026-09-02T06:00:00Z') => line({ type: 'bridge-session', timestamp: ts, sessionId, bridgeSessionId: cse })
const prompt = (s: string, ts: string, promptId: string, text: string, root?: string) =>
  line({ type: 'user', timestamp: ts, promptId, sessionId: s, ...(root ? { session_id: root } : {}), cwd: '/u/code/fun/x', message: { role: 'user', content: text } })
const reply = (s: string, ts: string, id: string, text: string, root?: string) =>
  line({
    type: 'assistant', timestamp: ts, sessionId: s, ...(root ? { session_id: root } : {}),
    message: { id: `m_${id}`, model: 'claude-opus-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 10 } },
  })
const send = (s: string, ts: string, id: string, to: string, message: string) =>
  line({
    type: 'assistant', timestamp: ts, sessionId: s,
    message: { id: `m_${id}`, model: 'claude-opus-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, summary: message, message } }], usage: { input_tokens: 1, output_tokens: 1 } },
  })
const ack = (s: string, ts: string, promptId: string, id: string, msgId: string) =>
  line({ type: 'user', timestamp: ts, promptId, sessionId: s, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `{"success":true,"message":"→ peer","msg_id":"${msgId}"}` }] } })
const relayTurn = (s: string, ts: string, promptId: string, from: string, msgId: string, body: string) =>
  line({
    type: 'user', timestamp: ts, promptId, sessionId: s, isMeta: true,
    origin: { kind: 'peer', name: from, from: 'uds:/tmp/cc-socks/1.sock', msg_id: msgId, body },
    message: { role: 'user', content: `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="${from}">\n${body}\n</cross-session-message>` },
  })

function seed(files: Record<string, Record<string, string[]>>) {
  const dir = mkdtempSync(join(tmpdir(), 'lore-job-'))
  for (const [well, sessions] of Object.entries(files)) {
    mkdirSync(join(dir, well), { recursive: true })
    for (const [sid, lines] of Object.entries(sessions)) writeFileSync(join(dir, well, `${sid}.jsonl`), `${lines.join('\n')}\n`)
  }
  return dir
}

async function corpus() {
  const db = openDb(':memory:')
  const projectsDir = seed({
    '-u-code-fun-lore': {
      // The job's FIRST session: it is its own root (no `session_id` pointer —
      // parse.ts sets one only when it differs) and, like every long-lived
      // `--rc` job's, carries no bridge record. Only the state.json row ties
      // it to the job, and it did not until v20 — the whole first incarnation
      // of every commander priced and peered as a separate interactive session.
      'lore-root-1': [prompt('lore-root-1', '2026-07-17T08:00:00Z', 'L00', 'kickoff'), reply('lore-root-1', '2026-07-17T08:00:10Z', 'r00', 'on it')],
      // Pre-bridge: the first incarnation's root, no bridge record. The
      // state.json row ties that root to the bridge, so this is the same job.
      'lore-0': [prompt('lore-0', '2026-07-17T09:00:00Z', 'L0', 'first light', 'lore-root-1'), reply('lore-0', '2026-07-17T09:00:10Z', 'r0', 'hello', 'lore-root-1')],
      'lore-1': [
        bridge('lore-1', 'cse_LORE'),
        prompt('lore-1', '2026-09-02T06:54:36Z', 'L1', 'brief ccc', 'lore-root-1'),
        send('lore-1', '2026-09-02T06:55:01Z', 'tu_k', 'ccc', 'kickoff'),
        ack('lore-1', '2026-09-02T06:55:03Z', 'L1', 'tu_k', 'msg-kick'),
        relayTurn('lore-1', '2026-09-02T06:57:40Z', 'L2', 'ccc', 'msg-conf', 'confirmed'),
        reply('lore-1', '2026-09-02T06:58:00Z', 'r1', 'banked', 'lore-root-1'),
      ],
    },
    // The respawn moved on to a worktree well: a job crosses wells.
    '-u-code-fun-lore--claude-worktrees-jobs': {
      'lore-2': [
        bridge('lore-2', 'cse_LORE', '2026-09-02T07:19:50Z'),
        prompt('lore-2', '2026-09-02T07:20:00Z', 'L3', 'sync', 'lore-root-2'),
        reply('lore-2', '2026-09-02T07:20:10Z', 'r2', 'synced', 'lore-root-2'),
      ],
    },
    '-u-code-fun-ccc': {
      'ccc-1': [
        bridge('ccc-1', 'cse_CCC'),
        prompt('ccc-1', '2026-09-02T06:54:19Z', 'C1', 'standby', 'ccc-root'),
        relayTurn('ccc-1', '2026-09-02T06:55:03Z', 'C2', 'lore', 'msg-kick', 'kickoff'),
        send('ccc-1', '2026-09-02T06:57:38Z', 'tu_c', 'lore', 'confirmed'),
        ack('ccc-1', '2026-09-02T06:57:40Z', 'C2', 'tu_c', 'msg-conf'),
      ],
    },
    '-u-code-work-app': {
      // Pre-bridge: a root and no bridge record.
      'old-1': [prompt('old-1', '2026-08-01T10:00:00Z', 'O1', 'old work', 'old-root'), reply('old-1', '2026-08-01T10:00:10Z', 'r3', 'done', 'old-root')],
      // Interactive: neither.
      'solo-1': [prompt('solo-1', '2026-08-20T10:00:00Z', 'S1', 'quick question'), reply('solo-1', '2026-08-20T10:00:10Z', 'r4', 'answer')],
    },
  })
  await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })
  // Only lore still has a state.json; ccc was deleted.
  db.prepare("INSERT INTO jobs(job_id, session_id, bridge_key, name, cwd, state) VALUES('a18a763f', 'lore-root-1', 'LORE', 'lore', '/u/code/fun/lore', 'working')").run()
  return db
}

describe('backfillJobNames', () => {
  test('a deleted job is named by what its peers called it, and a state.json name is never overwritten', async () => {
    const db = await corpus()
    expect(backfillJobNames(db)).toEqual({ named: 1 })
    const rows = db.prepare('SELECT job_id, bridge_key, name, source FROM jobs ORDER BY source, job_id').all()
    expect(rows).toEqual([
      { job_id: 'peer:CCC', bridge_key: 'CCC', name: 'ccc', source: 'peer' },
      { job_id: 'a18a763f', bridge_key: 'LORE', name: 'lore', source: 'state' },
    ])
    // Re-derived, not accumulated.
    expect(backfillJobNames(db)).toEqual({ named: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 2 })
    // The thread page's sides resolve through it: ccc is a real side now.
    expect(resolveSide(db, 'ccc')).toEqual({ query: 'ccc', name: 'ccc', key: 'CCC', sessions: ['ccc-1'] })
  })
})

describe('listJobs', () => {
  test('one row per job, keyed on the bridge, across sessions, wells and a respawn', async () => {
    const db = await corpus()
    backfillJobNames(db)
    const jobs = listJobs(db, { limit: 10 })
    expect(jobs.map((j) => [j.key, j.kind, j.name, j.nameSource])).toEqual([
      ['LORE', 'bridge', 'lore', 'state'],
      ['CCC', 'bridge', 'ccc', 'peer'],
      ['old-root', 'root', null, null],
    ])
    const lore = jobs[0]!
    // Four sessions: the pre-bridge ones ride on the state row's root — the
    // root session itself included, which has no pointer at all.
    expect(lore).toMatchObject({ jobId: 'a18a763f', state: 'working', sessions: 4, incarnations: 2, first: '2026-07-17T08:00:00Z', last: '2026-09-02T07:20:10Z' })
    expect(lore.wells.sort()).toEqual(['-u-code-fun-lore', '-u-code-fun-lore--claude-worktrees-jobs'])
    expect(lore.models).toEqual([{ model: 'claude-opus-5', requests: 5 }])
    expect(lore.requests).toBe(5)
    expect(lore.peers).toEqual(['ccc'])
    expect(lore.latest).toEqual({ sessionId: 'lore-2', firstPrompt: 'sync', openedBy: null })
    const ccc = jobs[1]!
    // Deleted at the daemon: no id, no state — but a name, and its peer.
    expect(ccc).toMatchObject({ jobId: null, state: null, sessions: 1, incarnations: 1, peers: ['lore'] })
    expect(ccc.latest?.openedBy).toBeNull()
    // A root-keyed job with nobody to name it.
    expect(jobs[2]).toMatchObject({ sessions: 1, incarnations: 1, peers: [], wells: ['-u-code-work-app'] })
  })

  test('interactive sessions are one-session jobs, listed only on request; since and key narrow', async () => {
    const db = await corpus()
    expect(listJobs(db, { limit: 10 }).some((j) => j.kind === 'session')).toBe(false)
    const all = listJobs(db, { all: true, limit: 10 })
    const solo = all.find((j) => j.key === 'solo-1')
    // One incarnation, not zero: a session with no root IS its root.
    expect(solo).toMatchObject({ kind: 'session', name: null, sessions: 1, incarnations: 1, latest: { sessionId: 'solo-1', firstPrompt: 'quick question', openedBy: null } })
    expect(listJobs(db, { since: '2026-09-01', limit: 10 }).map((j) => j.key)).toEqual(['LORE', 'CCC'])
    expect(listJobs(db, { key: 'CCC', limit: 10 }).map((j) => j.key)).toEqual(['CCC'])
    expect(listJobs(db, { key: 'solo-1', limit: 10 }).map((j) => j.kind)).toEqual(['session'])
  })
})

const bash = (s: string, ts: string, id: string, command: string) =>
  line({
    type: 'assistant', timestamp: ts, sessionId: s,
    message: { id: `m_${id}`, model: 'claude-opus-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], usage: { input_tokens: 1, output_tokens: 1 } },
  })
const result = (s: string, ts: string, promptId: string, id: string, content: string) =>
  line({ type: 'user', timestamp: ts, promptId, sessionId: s, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })

describe('spawnEdges', () => {
  test('the edge is read off the RESULT: a spawn past the call text cap still parents its lane', async () => {
    const db = openDb(':memory:')
    // The commander's line, as a canonical run writes it: a push, a reap and
    // the spawn on one command with the brief inline, so "spawn" sits well
    // past the 2000 characters the index keeps of a call.
    const brief = `--brief '${'You are a worker lane on item 588. '.repeat(70)}'`
    const long = `cd /u/code/fun/x && ccc push att-579 --base main ${brief} && ccc spawn --name att-588 --json - < brief.md`
    expect(long.indexOf('spawn')).toBeGreaterThan(2000)
    const short = `ccc spawn --name att-573 --json - < brief.md`
    const projectsDir = seed({
      '-u-code-fun-x': {
        'cmd-1': [
          bridge('cmd-1', 'cse_CMD'),
          prompt('cmd-1', '2026-09-23T08:04:55Z', 'P1', 'continue', 'cmd-root'),
          bash('cmd-1', '2026-09-23T08:07:00Z', 'tu_a', short),
          result('cmd-1', '2026-09-23T08:07:02Z', 'P1', 'tu_a', '{\n  "cwd" : "/u/code/fun/x/.claude/worktrees/att-573",\n  "ref" : "16467cda",\n  "said" : "backgrounded · 16467cda · att-573"\n}'),
          bash('cmd-1', '2026-09-23T10:28:00Z', 'tu_b', long),
          result('cmd-1', '2026-09-23T10:28:03Z', 'P1', 'tu_b', 'pushed main → origin (7 commits)\nremoved 79861292; removed the worktree att-579\n{\n  "cwd" : "/u/code/fun/x/.claude/worktrees/att-588",\n  "ref" : "d4f01fcd",\n  "said" : "backgrounded · d4f01fcd · att-588"\n}'),
          // A result that mentions a ref-shaped thing but is no spawn: nothing to parent.
          bash('cmd-1', '2026-09-23T10:30:00Z', 'tu_c', 'git log -1'),
          result('cmd-1', '2026-09-23T10:30:01Z', 'P1', 'tu_c', 'abc1234 a commit about "ref" counting'),
          // Two lanes on one line, the answers cut to their ref and branch
          // the way the canonical commander wrote it: both are edges.
          bash('cmd-1', '2026-09-23T10:52:00Z', 'tu_d', `ccc spawn --name att-576 --json - < b576.md | grep -E '"ref"|"branch"'; ccc spawn --name att-569 --json - < b569.md | grep -E '"ref"|"branch"'`),
          result('cmd-1', '2026-09-23T10:52:03Z', 'P1', 'tu_d', '  "ref" : "e322c0d0",\n    "branch" : "worktree-att-576",\n  "ref" : "4575981a",\n    "branch" : "worktree-att-569",'),
        ],
      },
      '-u-code-fun-x--claude-worktrees-att-576': {
        'e322c0d0-1111-4d8e-84e5-a40dd25b3401': [bridge('e322c0d0-1111-4d8e-84e5-a40dd25b3401', 'cse_L576'), prompt('e322c0d0-1111-4d8e-84e5-a40dd25b3401', '2026-09-23T10:52:10Z', 'W3', 'You are a worker lane', 'e322c0d0-1111-4d8e-84e5-a40dd25b3401')],
      },
      '-u-code-fun-x--claude-worktrees-att-569': {
        '4575981a-2222-4d8e-84e5-a40dd25b3401': [bridge('4575981a-2222-4d8e-84e5-a40dd25b3401', 'cse_L569'), prompt('4575981a-2222-4d8e-84e5-a40dd25b3401', '2026-09-23T10:52:11Z', 'W4', 'You are a worker lane', '4575981a-2222-4d8e-84e5-a40dd25b3401')],
      },
      '-u-code-fun-x--claude-worktrees-att-573': {
        '16467cda-cc87-4698-a1ee-1eedf5204a1a': [bridge('16467cda-cc87-4698-a1ee-1eedf5204a1a', 'cse_L573'), prompt('16467cda-cc87-4698-a1ee-1eedf5204a1a', '2026-09-23T08:07:10Z', 'W1', 'You are a worker lane', '16467cda-cc87-4698-a1ee-1eedf5204a1a')],
      },
      '-u-code-fun-x--claude-worktrees-att-588': {
        'd4f01fcd-b673-4d8e-84e5-a40dd25b3401': [bridge('d4f01fcd-b673-4d8e-84e5-a40dd25b3401', 'cse_L588'), prompt('d4f01fcd-b673-4d8e-84e5-a40dd25b3401', '2026-09-23T10:28:10Z', 'W2', 'You are a worker lane', 'd4f01fcd-b673-4d8e-84e5-a40dd25b3401')],
      },
    })
    await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })
    expect([...spawnEdges(db)]).toEqual([
      ['L573', { key: 'CMD', sessionId: 'cmd-1', ts: '2026-09-23T08:07:00Z' }],
      ['L588', { key: 'CMD', sessionId: 'cmd-1', ts: '2026-09-23T10:28:00Z' }],
      ['L576', { key: 'CMD', sessionId: 'cmd-1', ts: '2026-09-23T10:52:00Z' }],
      ['L569', { key: 'CMD', sessionId: 'cmd-1', ts: '2026-09-23T10:52:00Z' }],
    ])
    // Narrowed to a session: the same edges when it is the spawner, none otherwise.
    expect([...spawnEdges(db, { sessionId: 'cmd-1' }).keys()]).toEqual(['L573', 'L588', 'L576', 'L569'])
    expect(spawnEdges(db, { sessionId: 'd4f01fcd-b673-4d8e-84e5-a40dd25b3401' }).size).toBe(0)
    const jobs = listJobs(db, { limit: 10 })
    expect(jobs.find((j) => j.key === 'L588')?.parent).toEqual({ key: 'CMD', name: null })
    expect(jobs.find((j) => j.key === 'CMD')?.parent).toBeNull()
  })
})

describe('indexJobs', () => {
  test('a job the daemon no longer lists reads gone; one that comes back wins its state back', async () => {
    const db = openDb(':memory:')
    const claudeDir = mkdtempSync(join(tmpdir(), 'lore-claude-'))
    const state = (id: string, s: Record<string, unknown>) => {
      mkdirSync(join(claudeDir, 'jobs', id), { recursive: true })
      writeFileSync(join(claudeDir, 'jobs', id, 'state.json'), JSON.stringify(s))
    }
    state('3c382923', { sessionId: 'cmd-root', bridgeSessionId: 'cse_CMD', name: 'attrition', state: 'working' })
    state('d4f01fcd', { sessionId: 'd4f01fcd-b673', bridgeSessionId: 'cse_L588', name: 'att-588', state: 'working' })
    expect(await indexJobs(db, { claudeDir })).toMatchObject({ jobs: 2, withBridge: 2, gone: 0 })
    const states = () => Object.fromEntries(db.prepare('SELECT job_id, state FROM jobs ORDER BY job_id').all().map((r: any) => [r.job_id, r.state]))
    expect(states()).toEqual({ '3c382923': 'working', d4f01fcd: 'working' })
    // The commander reaped the lane: its dir is gone, the row stays, the state says so.
    rmSync(join(claudeDir, 'jobs', 'd4f01fcd'), { recursive: true })
    expect(await indexJobs(db, { claudeDir })).toMatchObject({ jobs: 1, gone: 1 })
    expect(states()).toEqual({ '3c382923': 'working', d4f01fcd: 'gone' })
    // Already gone is not counted again; a peer-named row is never touched.
    db.prepare("INSERT INTO jobs(job_id, bridge_key, name, source) VALUES('peer:CCC', 'CCC', 'ccc', 'peer')").run()
    expect(await indexJobs(db, { claudeDir })).toMatchObject({ gone: 0 })
    expect(states()).toEqual({ '3c382923': 'working', d4f01fcd: 'gone', 'peer:CCC': null })
    // Respawned under the same id: the file's word wins the row back.
    state('d4f01fcd', { sessionId: 'd4f01fcd-b673', bridgeSessionId: 'cse_L588', name: 'att-588', state: 'blocked' })
    await indexJobs(db, { claudeDir })
    expect(states().d4f01fcd).toBe('blocked')
  })
})

describe('resolveJob', () => {
  test('a name, a bridge id in any spelling, the daemon id, a root or a session id all land on the job', async () => {
    const db = await corpus()
    backfillJobNames(db)
    const LORE = { key: 'LORE', kind: 'bridge' as const }
    expect(resolveJob(db, 'lore')).toEqual(LORE)
    expect(resolveJob(db, 'LORE')).toEqual(LORE)
    expect(resolveJob(db, 'session_LORE')).toEqual(LORE)
    expect(resolveJob(db, 'cse_LORE')).toEqual(LORE)
    expect(resolveJob(db, 'a18a763f')).toEqual(LORE)
    // A root under a bridge is the bridge — the old /job/<root> links hold.
    expect(resolveJob(db, 'lore-root-2')).toEqual(LORE)
    expect(resolveJob(db, 'lore-2')).toEqual(LORE)
    // The pre-bridge session and its root, through the state row.
    expect(resolveJob(db, 'lore-0')).toEqual(LORE)
    expect(resolveJob(db, 'lore-root-1')).toEqual(LORE)
    expect(resolveJob(db, 'ccc')).toEqual({ key: 'CCC', kind: 'bridge' })
    expect(resolveJob(db, 'ccc-1')).toEqual({ key: 'CCC', kind: 'bridge' })
    expect(resolveJob(db, 'old-root')).toEqual({ key: 'old-root', kind: 'root' })
    expect(resolveJob(db, 'old-1')).toEqual({ key: 'old-root', kind: 'root' })
    expect(resolveJob(db, 'solo-1')).toEqual({ key: 'solo-1', kind: 'session' })
    expect(resolveJob(db, 'nope')).toBeNull()
  })
})
