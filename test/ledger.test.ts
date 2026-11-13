import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { spawnEdges } from '../src/job'
import { indexJobs } from '../src/jobs'
import { indexSpawnLedger } from '../src/ledger'
import { getLoop } from '../src/loop'

// ccc's spawn ledger (ledger.ts). The first line is ccc's own sample,
// verbatim, written by its debug build on 2026-11-13 with stdout sent to a
// file — the spelling that hid attrition's lanes from the transcript.
const SAMPLE =
  '{"agent":null,"base":null,"branch":null,"child":"a129aa13","cwd":"/Users/u/code/fun/ccc/.claude/worktrees/v2","draft":false,"effort":"low","from":null,"host":"local","kind":"spawn","model":"haiku","name":"ccc-ledger-probe","parent":{"bridge":"session_01YYPbMRFLoY82q9xYDcFJjk","job":"b87b7169","session":"15a04072-8803-487d-a6d4-16b3eb76f048"},"replaced":null,"ts":"2026-11-13T23:06:14Z","v":1,"via":"cli","worktree":null}'

type Rec = Record<string, unknown>
const json = (r: Rec) => JSON.stringify(r)
const entry = (o: Rec) =>
  json({ agent: null, base: null, branch: null, cwd: '/u/code/fun/app', draft: false, effort: null, from: null, host: 'local', kind: 'spawn', model: null, name: null, parent: null, replaced: null, v: 1, via: 'cli', worktree: null, ...o })

function ledgerFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-ledger-'))
  const path = join(dir, 'spawns.jsonl')
  writeFileSync(path, lines.join('\n'))
  return path
}

describe('indexSpawnLedger', () => {
  test("ccc's own line lands whole; a re-run adds nothing; the instant is stored like every other", async () => {
    const db = openDb(':memory:')
    const path = ledgerFile([SAMPLE])
    expect(await indexSpawnLedger(db, { path })).toEqual({ lines: 1, rows: 1, skipped: { version: 0, kind: 0, malformed: 0 }, present: true })
    expect(await indexSpawnLedger(db, { path })).toMatchObject({ lines: 1, rows: 1 })
    expect(db.prepare('SELECT ts, child, kind, host, via, name, model, effort, cwd, worktree, branch, replaced, draft, parent_job, parent_session, parent_bridge FROM spawn_ledger').all()).toEqual([
      {
        ts: '2026-11-13T23:06:14.000Z',
        child: 'a129aa13',
        kind: 'spawn',
        host: 'local',
        via: 'cli',
        name: 'ccc-ledger-probe',
        model: 'haiku',
        effort: 'low',
        cwd: '/Users/u/code/fun/ccc/.claude/worktrees/v2',
        worktree: null,
        branch: null,
        replaced: null,
        draft: 0,
        parent_job: 'b87b7169',
        parent_session: '15a04072-8803-487d-a6d4-16b3eb76f048',
        parent_bridge: 'session_01YYPbMRFLoY82q9xYDcFJjk',
      },
    ])
  })

  test('a kind or a version lore does not read is counted and left out, never guessed at; a torn tail does not stop the file', async () => {
    const db = openDb(':memory:')
    const path = ledgerFile([
      entry({ ts: '2026-11-14T10:00:00Z', child: 'aaaa0001', kind: 'spawn' }),
      entry({ ts: '2026-11-14T10:01:00Z', child: 'aaaa0002', kind: 'fork', from: 'some-session' }),
      entry({ ts: '2026-11-14T10:02:00Z', child: 'aaaa0003', kind: 'adopt' }),
      entry({ ts: '2026-11-14T10:03:00Z', child: 'aaaa0004', v: 2 }),
      entry({ ts: 'not a date', child: 'aaaa0005' }),
      '{"ts":"2026-11-14T10:04:00Z","chi',
    ])
    expect(await indexSpawnLedger(db, { path })).toEqual({ lines: 6, rows: 2, skipped: { version: 1, kind: 1, malformed: 2 }, present: true })
    expect(db.prepare('SELECT child, kind FROM spawn_ledger ORDER BY ts').all()).toEqual([
      { child: 'aaaa0001', kind: 'spawn' },
      { child: 'aaaa0002', kind: 'fork' },
    ])
  })

  test('the rows outlive the file: a ledger that is gone, or cut back, takes nothing with it', async () => {
    const db = openDb(':memory:')
    const path = ledgerFile([entry({ ts: '2026-11-14T10:00:00Z', child: 'aaaa0001' }), entry({ ts: '2026-11-14T10:01:00Z', child: 'aaaa0002' })])
    await indexSpawnLedger(db, { path })
    writeFileSync(path, entry({ ts: '2026-11-14T11:00:00Z', child: 'aaaa0003' }))
    expect(await indexSpawnLedger(db, { path })).toMatchObject({ lines: 1, rows: 3 })
    rmSync(path)
    expect(await indexSpawnLedger(db, { path })).toEqual({ lines: 0, rows: 3, skipped: { version: 0, kind: 0, malformed: 0 }, present: false })
  })
})

// A commander that spawns the way attrition's does since 2026-11-13: the
// `--json` answer goes to a file and the transcript holds a bare id, a
// branch and a base. Nothing in that result is an edge lore's reader of
// answers accepts — and a wider pattern would accept the next 8-hex string
// that is not one.
const line = json
const bridge = (sessionId: string, cse: string, ts: string) => line({ type: 'bridge-session', timestamp: ts, sessionId, bridgeSessionId: cse })
const prompt = (s: string, ts: string, promptId: string, text: string, cwd: string) =>
  line({ type: 'user', timestamp: ts, promptId, sessionId: s, session_id: s, cwd, origin: { kind: 'human' }, message: { role: 'user', content: text } })
const reply = (s: string, ts: string, id: string, text: string) =>
  line({ type: 'assistant', timestamp: ts, sessionId: s, session_id: s, message: { id: `m_${id}`, model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 100 } } })
const bash = (s: string, ts: string, id: string, command: string) =>
  line({
    type: 'assistant', timestamp: ts, sessionId: s, session_id: s,
    message: { id: `m_${id}`, model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], usage: { input_tokens: 1000, output_tokens: 10 } },
  })
const result = (s: string, ts: string, promptId: string, id: string, text: string) =>
  line({ type: 'user', timestamp: ts, promptId, sessionId: s, session_id: s, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })

const CMD = 'c0dec0de-0000-4000-8000-00000000000c'
const CMD2 = 'c0dec0de-0000-4000-8000-00000000000d'
const L1 = '4ca3fb81-0000-4000-8000-000000000001'
const L2 = 'a38dc1b7-0000-4000-8000-000000000002'
const NEXT = '5eedbeef-0000-4000-8000-000000000003'
const OTHER = '0ddba110-0000-4000-8000-000000000005'
const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')
const ROOT = '/u/code/fun/app/.claude/worktrees'

async function corpus(ledger: string[], opts: { decoy?: boolean } = {}) {
  const projects = mkdtempSync(join(tmpdir(), 'lore-ledger-projects-'))
  const put = (cwd: string, sid: string, lines: string[]) => {
    mkdirSync(join(projects, slug(cwd)), { recursive: true })
    writeFileSync(join(projects, slug(cwd), `${sid}.jsonl`), `${lines.join('\n')}\n`)
  }
  put(`${ROOT}/cmd`, CMD, [
    bridge(CMD, 'cse_CMD', '2026-11-13T15:00:00Z'),
    prompt(CMD, '2026-11-13T15:00:01Z', 'P1', 'run the loop', `${ROOT}/cmd`),
    bash(CMD, '2026-11-13T15:05:00Z', 'tu_1', 'for n in 4199 4200; do ccc spawn --name lane-$n --worktree=att-$n --json - < brief-$n.md > spawn-$n.json; python3 -c "print(ref, branch, base)"; done'),
    result(CMD, '2026-11-13T15:05:05Z', 'P1', 'tu_1', '4199 exit 0\n4ca3fb81 worktree-att-4199 worktree-cmd\n4200 exit 0\na38dc1b7 worktree-att-4200 worktree-cmd'),
    reply(CMD, '2026-11-13T15:06:00Z', 'r1', 'two lanes out'),
  ])
  // The same job after a /clear: a new session under the same bridge.
  put(`${ROOT}/cmd`, CMD2, [
    bridge(CMD2, 'cse_CMD', '2026-11-13T17:00:00Z'),
    prompt(CMD2, '2026-11-13T17:00:01Z', 'P2', 'hand over', `${ROOT}/cmd`),
    reply(CMD2, '2026-11-13T17:01:00Z', 'r2', 'the next seat is spawned'),
  ])
  for (const [sid, cwd, at] of [
    [L1, `${ROOT}/att-4199`, '2026-11-13T15:05:10Z'],
    [L2, `${ROOT}/att-4200`, '2026-11-13T15:05:12Z'],
    [NEXT, `${ROOT}/cmd`, '2026-11-13T17:00:30Z'],
  ] as const)
    put(cwd, sid, [prompt(sid, at, `P-${sid.slice(0, 4)}`, 'You are a worker.', cwd), reply(sid, at.replace(/\d\dZ$/, '59Z'), `r-${sid.slice(0, 4)}`, 'done')])
  // Another job whose transcript holds an ANSWER naming lane-4199's ref, an
  // hour earlier: what the reader of answers takes for a spawn.
  if (opts.decoy)
    put('/u/code/fun/other', OTHER, [
      prompt(OTHER, '2026-11-13T14:00:00Z', 'PO', 'look at that lane', '/u/code/fun/other'),
      bash(OTHER, '2026-11-13T14:00:05Z', 'tu_o', 'ccc show 4ca3fb81 --json'),
      result(OTHER, '2026-11-13T14:00:06Z', 'PO', 'tu_o', '{"ref":"4ca3fb81","name":"lane-4199","state":"working"}'),
    ])
  const claudeDir = mkdtempSync(join(tmpdir(), 'lore-ledger-claude-'))
  for (const [id, name, sid, cwd, extra] of [
    ['c0dec0de', 'commander', CMD, `${ROOT}/cmd`, { bridgeSessionId: 'cse_CMD' }],
    ['4ca3fb81', 'lane-4199', L1, `${ROOT}/att-4199`, {}],
    ['a38dc1b7', 'lane-4200', L2, `${ROOT}/att-4200`, {}],
    ['5eedbeef', 'steer', NEXT, `${ROOT}/cmd`, {}],
  ] as const) {
    mkdirSync(join(claudeDir, 'jobs', id), { recursive: true })
    writeFileSync(join(claudeDir, 'jobs', id, 'state.json'), JSON.stringify({ name, state: 'done', sessionId: sid, cwd, ...extra }))
  }
  const db = openDb(':memory:')
  await buildIndex(db, { projectsDir: projects, historyPath: join(projects, 'none.jsonl') })
  await indexJobs(db, { claudeDir })
  await indexSpawnLedger(db, { path: ledgerFile(ledger) })
  return db
}

const byCommander = { job: 'c0dec0de', session: CMD, bridge: 'session_CMD' }

describe('spawnEdges: the ledger', () => {
  test('without it, a spawn whose answer went to a file has no edge — the 2026-11-13 reading', async () => {
    const db = await corpus([])
    expect([...spawnEdges(db)]).toEqual([])
    const loop = await getLoop(db, 'commander', { live: { rows: [], states: new Map() } })
    expect(loop.lanesTotal).toBe(0)
  })

  test('with it, the same lanes are the commander\'s: the edge is the line ccc wrote, the session the one live at the spawn', async () => {
    const db = await corpus([
      entry({ ts: '2026-11-13T15:05:03Z', child: '4ca3fb81', name: 'lane-4199', model: 'claude-opus-5-5', worktree: 'att-4199', parent: byCommander }),
      entry({ ts: '2026-11-13T15:05:04Z', child: 'a38dc1b7', name: 'lane-4200', model: 'claude-opus-5-5', worktree: 'att-4200', parent: byCommander }),
    ])
    expect(spawnEdges(db).get(L1)).toEqual({ key: 'CMD', sessionId: CMD, ts: '2026-11-13T15:05:03.000Z' })
    expect(spawnEdges(db).get(L2)).toEqual({ key: 'CMD', sessionId: CMD, ts: '2026-11-13T15:05:04.000Z' })
    // Scoped to one session of the job: the lanes THAT session drove.
    expect([...spawnEdges(db, { sessionId: CMD }).keys()].sort()).toEqual([L1, L2].sort())
    expect([...spawnEdges(db, { sessionId: CMD2 })]).toEqual([])
    const loop = await getLoop(db, 'commander', { live: { rows: [], states: new Map() } })
    expect(loop.lanes.map((l) => l.name).sort()).toEqual(['lane-4199', 'lane-4200'])
    expect(loop.spend.laneUsd).toBeGreaterThan(0)
  })

  test('the parent is the caller as its environment said: the session, else the bridge in the trailer spelling, else the daemon id', async () => {
    const db = await corpus([
      // A session lore has not indexed (the spawner's transcript moved): the bridge names the job.
      entry({ ts: '2026-11-13T15:05:03Z', child: '4ca3fb81', parent: { job: null, session: 'not-indexed', bridge: 'session_CMD' } }),
      // No bridge either: the daemon id, which is the root's first eight.
      entry({ ts: '2026-11-13T15:05:04Z', child: 'a38dc1b7', parent: { job: 'c0dec0de', session: null, bridge: null } }),
    ])
    expect(spawnEdges(db).get(L1)).toEqual({ key: 'CMD', sessionId: 'not-indexed', ts: '2026-11-13T15:05:03.000Z' })
    expect(spawnEdges(db).get(L2)).toEqual({ key: 'CMD', sessionId: '', ts: '2026-11-13T15:05:04.000Z' })
  })

  test('no edge where there is none to state: a spawn a person typed, a child on another machine, a job naming itself', async () => {
    const db = await corpus([
      entry({ ts: '2026-11-13T15:05:03Z', child: '4ca3fb81', parent: null, via: 'app' }),
      entry({ ts: '2026-11-13T15:05:04Z', child: 'fa4fa4fa', host: 'air', parent: byCommander }),
      entry({ ts: '2026-11-13T15:05:05Z', child: 'c0dec0de', parent: byCommander }),
    ])
    expect([...spawnEdges(db)]).toEqual([])
  })

  // An answer in a transcript is the shape of a tool's output: any call
  // that prints a job's `ref` reads as its spawn. The line ccc wrote is the
  // spawn, and it is taken first.
  test('the ledger is taken before an answer in a transcript, whichever came first', async () => {
    const guessed = await corpus([], { decoy: true })
    expect(spawnEdges(guessed).get(L1)).toMatchObject({ key: OTHER })
    const stated = await corpus([entry({ ts: '2026-11-13T15:05:03Z', child: '4ca3fb81', parent: byCommander })], { decoy: true })
    expect(spawnEdges(stated).get(L1)).toEqual({ key: 'CMD', sessionId: CMD, ts: '2026-11-13T15:05:03.000Z' })
  })

  // What the ledger does NOT say (ccc, 2026-11-13): a handover's next seat
  // and a worker are both a named spawn by a session. The successor is an
  // edge like any other; telling it from a lane is not something this file
  // can do, and the test holds that reading so nobody reads more into it.
  test('a successor spawned at a handover is an edge like a lane: the ledger carries no role', async () => {
    const db = await corpus([entry({ ts: '2026-11-13T17:00:20Z', child: '5eedbeef', name: 'steer', cwd: `${ROOT}/cmd`, parent: { job: 'c0dec0de', session: CMD2, bridge: 'session_CMD' } })])
    expect(spawnEdges(db).get(NEXT)).toEqual({ key: 'CMD', sessionId: CMD2, ts: '2026-11-13T17:00:20.000Z' })
    expect(db.prepare("SELECT cwd, worktree FROM spawn_ledger WHERE child = '5eedbeef'").get()).toEqual({ cwd: `${ROOT}/cmd`, worktree: null })
  })
})
