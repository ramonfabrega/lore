import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { listJobs, repoOf, spawnEdges } from '../src/job'
import { fleetRows } from '../src/web'

// The fleet tree: a commander that spawned a worker through `ccc spawn
// --json`, whose answer names the child's daemon id; the worker's own
// transcript in its worktree well. The edge is read off the commander's
// transcript, never off the daemon (which records none).

type Rec = Record<string, unknown>
const line = (r: Rec) => JSON.stringify(r)
const bridge = (sessionId: string, cse: string, ts: string) => line({ type: 'bridge-session', timestamp: ts, sessionId, bridgeSessionId: cse })
const prompt = (s: string, root: string, ts: string, promptId: string, text: string, cwd: string) =>
  line({ type: 'user', timestamp: ts, promptId, sessionId: s, session_id: root, cwd, message: { role: 'user', content: text } })
const reply = (s: string, root: string, ts: string, id: string, text: string) =>
  line({
    type: 'assistant', timestamp: ts, sessionId: s, session_id: root,
    message: { id: `m_${id}`, model: 'claude-opus-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 10 } },
  })
const bash = (s: string, root: string, ts: string, id: string, command: string) =>
  line({
    type: 'assistant', timestamp: ts, sessionId: s, session_id: root,
    message: { id: `m_${id}`, model: 'claude-opus-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], usage: { input_tokens: 1, output_tokens: 1 } },
  })
const result = (s: string, root: string, ts: string, promptId: string, id: string, text: string) =>
  line({ type: 'user', timestamp: ts, promptId, sessionId: s, session_id: root, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })

const REPO = '/u/code/fun/x'
const CMD_CWD = `${REPO}/.claude/worktrees/cmd`
const W1_CWD = `${REPO}/.claude/worktrees/w1`
const SPAWN_ANSWER = `{"cwd":"${W1_CWD}","draft":false,"ref":"deadbeef","said":"backgrounded · deadbeef · w1\\n  claude attach deadbeef","worktree":{"base":"worktree-cmd"}}`

async function corpus() {
  const dir = mkdtempSync(join(tmpdir(), 'lore-fleet-'))
  const wells: Record<string, Record<string, string[]>> = {
    '-u-code-fun-x--claude-worktrees-cmd': {
      'cmd-1': [
        bridge('cmd-1', 'cse_CMD', '2026-09-07T04:00:00Z'),
        prompt('cmd-1', 'cmd-root', '2026-09-07T04:00:01Z', 'P1', 'run the loop', CMD_CWD),
        bash('cmd-1', 'cmd-root', '2026-09-07T04:07:00Z', 'tu_s', 'ccc spawn --worktree=w1 --name w1 --model opus --json - < brief.md'),
        result('cmd-1', 'cmd-root', '2026-09-07T04:07:05Z', 'P1', 'tu_s', SPAWN_ANSWER),
        // A fixture spawned into a tmp dir: the harness's own line names the id.
        bash('cmd-1', 'cmd-root', '2026-09-07T04:08:00Z', 'tu_f', 'ccc spawn --model haiku --name fix --cwd /u/tmp/fix --json "say hi"'),
        result('cmd-1', 'cmd-root', '2026-09-07T04:08:02Z', 'P1', 'tu_f', 'backgrounded · f1a7ce00 · fix\n  claude attach f1a7ce00'),
        reply('cmd-1', 'cmd-root', '2026-09-07T04:08:10Z', 'r1', 'spawned w1 and a fixture'),
      ],
    },
    '-u-tmp-fix': {
      'f1a7ce00-2222': [prompt('f1a7ce00-2222', 'f1a7ce00-root', '2026-09-07T04:08:05Z', 'F1', 'say hi', '/u/tmp/fix'), reply('f1a7ce00-2222', 'f1a7ce00-root', '2026-09-07T04:08:09Z', 'r4', 'hi')],
    },
    '-u-code-fun-x--claude-worktrees-w1': {
      // A background job: the record-level session_id is the ROOT, whose
      // first eight characters are the daemon's id — the `ref` above.
      'deadbeef-1111': [
        prompt('deadbeef-1111', 'deadbeef-root', '2026-09-07T04:07:20Z', 'W1', 'You are a worker in the loop', W1_CWD),
        reply('deadbeef-1111', 'deadbeef-root', '2026-09-07T04:20:00Z', 'r2', '17 done: abc1234'),
      ],
    },
    '-u-code-fun-y': {
      'solo-1': [prompt('solo-1', 'solo-root', '2026-09-07T03:00:00Z', 'S1', 'unrelated', '/u/code/fun/y'), reply('solo-1', 'solo-root', '2026-09-07T03:00:10Z', 'r3', 'ok')],
    },
  }
  for (const [well, sessions] of Object.entries(wells)) {
    mkdirSync(join(dir, well), { recursive: true })
    for (const [sid, lines] of Object.entries(sessions)) writeFileSync(join(dir, well, `${sid}.jsonl`), `${lines.join('\n')}\n`)
  }
  const db = openDb(':memory:')
  await buildIndex(db, { projectsDir: dir, historyPath: join(dir, 'nope.jsonl') })
  db.prepare("INSERT INTO jobs(job_id, session_id, bridge_key, name, cwd, state) VALUES('c0ffee00', 'cmd-root', 'CMD', 'cmd', ?, 'working')").run(CMD_CWD)
  db.prepare("INSERT INTO jobs(job_id, session_id, bridge_key, name, cwd, state) VALUES('deadbeef', 'deadbeef-root', NULL, 'w1', ?, 'done')").run(W1_CWD)
  db.prepare("INSERT INTO jobs(job_id, session_id, bridge_key, name, cwd, state) VALUES('50105010', 'solo-root', NULL, 'solo', '/u/code/fun/y', 'done')").run()
  db.prepare("INSERT INTO jobs(job_id, session_id, bridge_key, name, cwd, state) VALUES('f1a7ce00', 'f1a7ce00-root', NULL, 'fix', '/u/tmp/fix', 'done')").run()
  return db
}

describe('repoOf', () => {
  test('a worktree folds into its base checkout', () => {
    expect(repoOf(W1_CWD)).toBe(REPO)
    expect(repoOf(REPO)).toBe(REPO)
    expect(repoOf(null)).toBeNull()
  })
})

describe('the fleet tree', () => {
  test('the edge is read off the parent\'s spawn answer, and lands on the child job', async () => {
    const db = await corpus()
    expect([...spawnEdges(db)]).toEqual([
      ['deadbeef-root', 'CMD'],
      ['f1a7ce00-root', 'CMD'],
    ])
    const jobs = listJobs(db, { limit: 10 })
    const by = new Map(jobs.map((j) => [j.name, j]))
    expect(by.get('w1')?.parent).toEqual({ key: 'CMD', name: 'cmd' })
    expect(by.get('fix')?.parent).toEqual({ key: 'CMD', name: 'cmd' })
    expect(by.get('cmd')?.parent).toBeNull()
    expect(by.get('solo')?.parent).toBeNull()
    expect(jobs.map((j) => [j.name, j.repo]).sort()).toEqual([
      ['cmd', REPO],
      ['fix', '/u/tmp/fix'],
      ['solo', '/u/code/fun/y'],
      ['w1', REPO],
    ])
  })

  test('the page groups by repo in order of appearance and hangs a child under its parent', async () => {
    const db = await corpus()
    const jobs = listJobs(db, { limit: 10 })
    // The page's rows, attention-sorted: here the newest first, as listJobs
    // returns them — the worker (newest activity) ahead of its commander.
    const rows = jobs.map((job) => ({ key: job.key, job, live: null }))
    const tree = fleetRows(rows).map((r) => (r.kind === 'group' ? `# ${r.repo} (${r.n})` : `${'  '.repeat(r.depth)}${r.row.job?.name}`))
    // The fixture lives in /u/tmp/fix and still sits under cmd: a child goes
    // where its parent is.
    expect(tree).toEqual([`# ${REPO} (3)`, 'cmd', '  w1', '  fix', '# /u/code/fun/y (1)', 'solo'])
  })
})
