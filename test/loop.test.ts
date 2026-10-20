import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import type { AgentRow, JobState } from '../src/agents'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { indexJobs } from '../src/jobs'
import { diffScore, getLoop, parseQueueHead, parseScore } from '../src/loop'

// One loop in miniature: a commander in its worktree that spawned two lanes
// through `ccc spawn --json`, a queue file whose opening line names the
// tranche's base, three first-parent commits from it of which two are
// bookings, and the daemon's side (the roster and a state.json with a gate
// in flight) handed in rather than read — the kit has no daemon.

type Rec = Record<string, unknown>
const line = (r: Rec) => JSON.stringify(r)
const bridge = (sessionId: string, cse: string, ts: string) => line({ type: 'bridge-session', timestamp: ts, sessionId, bridgeSessionId: cse })
const prompt = (s: string, root: string, ts: string, promptId: string, text: string, cwd: string) =>
  line({ type: 'user', timestamp: ts, promptId, sessionId: s, session_id: root, cwd, origin: { kind: 'human' }, message: { role: 'user', content: text } })
const reply = (s: string, root: string, ts: string, id: string, text: string, model = 'claude-opus-5-5') =>
  line({
    type: 'assistant', timestamp: ts, sessionId: s, session_id: root,
    message: { id: `m_${id}`, model, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 100 } },
  })
const bash = (s: string, root: string, ts: string, id: string, command: string) =>
  line({
    type: 'assistant', timestamp: ts, sessionId: s, session_id: root,
    message: { id: `m_${id}`, model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], usage: { input_tokens: 1000, output_tokens: 10 } },
  })
const result = (s: string, root: string, ts: string, promptId: string, id: string, text: string) =>
  line({ type: 'user', timestamp: ts, promptId, sessionId: s, session_id: root, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })

const QUEUE_OPEN = `# The queue

## Where things stand

*2026-10-15, **the first pass is done** (DECISIONS 1): nothing yet.*

Scoreboard: EastIndies 1851/1850 w1850 · GreatLakes 1700/1772 w1850
Peace pair: EastIndiesLakotaPeace w5315 of 6,822
Census: simulation backed 1068 of 3611
Golden: every chapter closed · ch1 closed
`
const queueAt = (base: string) => `# The queue

## Where things stand

*2026-10-15, **the second tranche at two landings** from \`${base}\` (the first pass, DECISIONS 1): two lanes.*

Scoreboard: EastIndies 1851/1850 w1850 · GreatLakes 1772/1772 w1850
Peace pair: EastIndiesLakotaPeace w5499 of 6,822
Census: simulation backed 1125 of 3611
Golden: every chapter closed · ch1 closed · ch2 closed
`

async function repo(): Promise<{ dir: string; base: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'lore-loop-repo-'))
  // Both dates: `--date` sets the author's alone, and a landing is read off
  // the committer's (%cI), which is what the loop's own commits carry.
  const g = (...args: string[]) => {
    const i = args.indexOf('--date')
    const date = i >= 0 ? args[i + 1] : undefined
    const argv = i >= 0 ? args.filter((_, j) => j !== i && j !== i + 1) : args
    const env = { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) }
    return $`git -C ${dir} -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${argv}`.env(env).quiet()
  }
  await g('init', '-q', '-b', 'main')
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs', 'QUEUE.md'), QUEUE_OPEN)
  await g('add', '.')
  await g('commit', '-q', '-m', 'The first pass, second commit: the whole gate is green', '--date', '2026-10-15T10:00:00Z')
  const base = (await $`git -C ${dir} rev-parse --short HEAD`.text()).trim()
  // A merge (a lane's tree), its booking, a note, a second booking.
  await g('checkout', '-q', '-b', 'worktree-att-1')
  writeFileSync(join(dir, 'a.txt'), 'a')
  await g('add', '.')
  await g('commit', '-q', '-m', 'the lane did a thing', '--date', '2026-10-15T10:30:00Z')
  await g('checkout', '-q', 'main')
  await g('merge', '-q', '--no-ff', '-m', 'Merge worktree-att-1 (1 commit)', 'worktree-att-1', '--date', '2026-10-15T10:50:00Z')
  writeFileSync(join(dir, 'docs', 'QUEUE.md'), queueAt(base).replace('5499', '5400'))
  await g('commit', '-q', '-am', 'Book 1: the peace pair 5315 -> 5400', '--date', '2026-10-15T11:00:00Z')
  writeFileSync(join(dir, 'note.txt'), 'n')
  await g('add', '.')
  await g('commit', '-q', '-m', 'The handoff names the next number', '--date', '2026-10-15T11:10:00Z')
  writeFileSync(join(dir, 'docs', 'QUEUE.md'), queueAt(base))
  await g('commit', '-q', '-am', 'Book 2: the peace pair 5400 -> 5499, census 1068 -> 1125', '--date', '2026-10-15T12:00:00Z')
  return { dir, base }
}

function wells(cmdCwd: string, w1: string, w2: string) {
  const spawn = (cwd: string, ref: string, name: string) => `{"cwd":"${cwd}","draft":false,"ref":"${ref}","said":"backgrounded · ${ref} · ${name}\\n  claude attach ${ref}","worktree":{"base":"worktree-cmd"}}`
  return {
    [slug(cmdCwd)]: {
      'cmd-1': [
        bridge('cmd-1', 'cse_CMD', '2026-10-15T09:00:00Z'),
        prompt('cmd-1', 'cmd-root', '2026-10-15T09:00:01Z', 'P1', 'run the loop', cmdCwd),
        reply('cmd-1', 'cmd-root', '2026-10-15T09:00:05Z', 'r0', 'reading the queue'),
        // Before the base: this tranche does not pay for it.
        bash('cmd-1', 'cmd-root', '2026-10-15T09:30:00Z', 'tu_0', 'ccc spawn --worktree=att-0 --name att-0 --model sonnet --json - < brief.md'),
        result('cmd-1', 'cmd-root', '2026-10-15T09:30:05Z', 'P1', 'tu_0', spawn(w1, '00000000', 'att-0')),
        bash('cmd-1', 'cmd-root', '2026-10-15T10:05:00Z', 'tu_1', 'ccc spawn --worktree=att-1 --name att-1 --model sonnet --json - < brief.md'),
        result('cmd-1', 'cmd-root', '2026-10-15T10:05:05Z', 'P1', 'tu_1', spawn(w1, 'deadbeef', 'att-1')),
        bash('cmd-1', 'cmd-root', '2026-10-15T11:05:00Z', 'tu_2', 'ccc spawn --worktree=att-2 --name att-2 --model opus --json - < brief.md'),
        result('cmd-1', 'cmd-root', '2026-10-15T11:05:05Z', 'P1', 'tu_2', spawn(w2, 'cafebabe', 'att-2')),
        reply('cmd-1', 'cmd-root', '2026-10-15T12:01:00Z', 'r1', '2 booked; gate running'),
      ],
    },
    [slug(w1)]: {
      '00000000-0000-4000-8000-000000000000': [
        prompt('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000', '2026-10-15T09:31:00Z', 'L0', 'You are a worker lane. Your item is 0.', w1),
        reply('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000', '2026-10-15T09:40:00Z', 'l0', 'done', 'claude-sonnet-5-5'),
      ],
      'deadbeef-0000-4000-8000-000000000001': [
        prompt('deadbeef-0000-4000-8000-000000000001', 'deadbeef-0000-4000-8000-000000000001', '2026-10-15T10:06:00Z', 'L1', 'You are a worker lane. Your item is 1.', w1),
        reply('deadbeef-0000-4000-8000-000000000001', 'deadbeef-0000-4000-8000-000000000001', '2026-10-15T10:40:00Z', 'l1', 'done', 'claude-sonnet-5-5'),
      ],
    },
    [slug(w2)]: {
      'cafebabe-0000-4000-8000-000000000002': [
        prompt('cafebabe-0000-4000-8000-000000000002', 'cafebabe-0000-4000-8000-000000000002', '2026-10-15T11:06:00Z', 'L2', 'You are a worker lane. Your item is 2.', w2),
        reply('cafebabe-0000-4000-8000-000000000002', 'cafebabe-0000-4000-8000-000000000002', '2026-10-15T11:50:00Z', 'l2', 'working'),
      ],
    },
  }
}

const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')

async function corpus(cmdCwd: string) {
  const w1 = `${cmdCwd.replace(/\/[^/]+$/, '')}/att-1`
  const w2 = `${cmdCwd.replace(/\/[^/]+$/, '')}/att-2`
  const projects = mkdtempSync(join(tmpdir(), 'lore-loop-projects-'))
  for (const [well, sessions] of Object.entries(wells(cmdCwd, w1, w2))) {
    mkdirSync(join(projects, well), { recursive: true })
    for (const [sid, lines] of Object.entries(sessions)) writeFileSync(join(projects, well, `${sid}.jsonl`), `${lines.join('\n')}\n`)
  }
  const claudeDir = mkdtempSync(join(tmpdir(), 'lore-loop-claude-'))
  mkdirSync(join(claudeDir, 'jobs', 'cmd00000'), { recursive: true })
  writeFileSync(join(claudeDir, 'jobs', 'cmd00000', 'state.json'), JSON.stringify({ name: 'commander', state: 'working', sessionId: 'cmd-1', bridgeSessionId: 'cse_CMD', cwd: cmdCwd }))
  const lanes = [
    ['00000000', 'att-0', '00000000-0000-4000-8000-000000000000', 'done', w1],
    ['deadbeef', 'att-1', 'deadbeef-0000-4000-8000-000000000001', 'done', w1],
    ['cafebabe', 'att-2', 'cafebabe-0000-4000-8000-000000000002', 'working', w2],
  ] as const
  for (const [id, name, sid, state, cwd] of lanes) {
    mkdirSync(join(claudeDir, 'jobs', id), { recursive: true })
    writeFileSync(join(claudeDir, 'jobs', id, 'state.json'), JSON.stringify({ name, state, sessionId: sid, cwd }))
  }
  const db = openDb(':memory:')
  await buildIndex(db, { projectsDir: projects, historyPath: join(projects, 'none.jsonl') })
  await indexJobs(db, { claudeDir })
  return { db, w2 }
}

const row = (o: Partial<AgentRow> & { cwd: string; state: string }): AgentRow => ({
  id: null, name: null, waitingFor: null, detail: null, tempo: null, branch: null, sessionId: null, startedAt: '2026-10-15T09:00:00.000Z', updatedAt: null,
  liveTokens: null, ctx: null, children: [], attach: null, attachUrl: null, model: null, modelSource: null, indexed: null, ...o,
})

describe('lore loop', () => {
  test('the queue head and score lines parse, and the base folds in as open and delta', () => {
    expect(parseQueueHead(queueAt('abc1234'))).toEqual({ label: 'the second tranche', base: 'abc1234' })
    expect(parseQueueHead(QUEUE_OPEN)).toEqual({ label: null, base: null })
    const now = parseScore(queueAt('abc1234'))
    expect(now.map((l) => l.line)).toEqual(['Scoreboard', 'Peace pair', 'Census'])
    const d = diffScore(now, parseScore(QUEUE_OPEN))
    expect(d[1]?.items[0]).toEqual({ label: 'EastIndiesLakotaPeace', value: 5499, of: 6822, open: 5315, delta: 184 })
    expect(d[2]?.items[0]).toEqual({ label: 'backed', value: 1125, of: 3611, open: 1068, delta: 57 })
    expect(d[0]?.items[1]).toEqual({ label: 'GreatLakes', value: 1772, of: 1772, open: 1700, delta: 72 })
  })

  test('one loop: the tranche from the base, the lanes of the tranche plus the live ones, the gate, the fee, who spoke last', async () => {
    const { dir, base } = await repo()
    const { db, w2 } = await corpus(dir)
    const now = Date.parse('2026-10-15T12:30:00Z')
    const live = {
      rows: [
        row({ id: 'cmd00000', name: 'commander', state: 'working', tempo: 'busy', detail: '2 booked; gate running', cwd: dir, sessionId: 'cmd-1', ctx: 240_000, model: 'claude-opus-5-5' }),
        row({ id: 'cafebabe', name: 'att-2', state: 'working', cwd: w2, sessionId: 'cafebabe-0000-4000-8000-000000000002', ctx: 310_000, model: 'claude-opus-5-5' }),
      ],
      states: new Map<string, JobState | null>([
        ['cmd00000', { fan: [{ id: 'g1', kind: 'shell', label: 'python3 tools/release_gate.py game --scope abc', startedAt: now - 600_000 }, { id: 'w1', kind: 'shell', label: 'python3 tools/lanewait.py att-2', startedAt: now - 60_000, doneAt: now - 30_000 }] }],
      ]),
    }
    const loop = await getLoop(db, 'commander', { now, live })

    expect(loop.job).toMatchObject({ name: 'commander', jobId: 'cmd00000', state: 'working', tempo: 'busy', detail: '2 booked; gate running', ctx: 240_000, cwd: dir, sessions: 1 })

    // The base is read off the queue; two bookings on the first-parent line,
    // the merge and the note counted but not landings.
    expect(loop.tranche).toMatchObject({ label: 'the second tranche', base, landings: 2, of: 20, merges: 1, commits: 4 })
    expect(loop.tranche?.baseAt).toBe('2026-10-15T10:00:00.000Z')
    expect(loop.tranche?.last).toBe('2026-10-15T12:00:00.000Z')
    expect(loop.tranche?.sinceLastMs).toBe(30 * 60_000)
    expect(loop.tranche?.perHour).toBe(0.8)
    expect(loop.tranche?.etaMs).toBe(Math.round((18 / 0.8) * 3_600_000))

    // The score against the base commit's queue, not the previous landing's.
    const peace = loop.score.find((l) => l.line === 'Peace pair')?.items[0]
    expect(peace).toMatchObject({ value: 5499, open: 5315, delta: 184 })

    expect(loop.gate).toEqual({ running: true, since: new Date(now - 600_000).toISOString(), label: 'python3 tools/release_gate.py game --scope abc' })
    expect(loop.running).toHaveLength(1)

    // att-0 was spawned before the base and is not live: not this tranche's.
    expect(loop.lanes.map((l) => l.name)).toEqual(['att-2', 'att-1'])
    expect(loop.lanes[0]).toMatchObject({ item: 2, live: true, state: 'working', model: 'claude-opus-5-5', ctx: 310_000, deep: true, spawnedAt: '2026-10-15T11:05:00.000Z' })
    expect(loop.lanes[0]?.ageMs).toBe(85 * 60_000)
    expect(loop.lanes[1]).toMatchObject({ item: 1, live: false, state: 'done', model: 'claude-sonnet-5-5', ctx: null, deep: false })

    // The fee since the base: the commander's requests after 10:00 (two of
    // the three bash calls and the closing reply) and the two lanes'.
    expect(loop.spend.jobUsd).toBeGreaterThan(0)
    expect(loop.spend.laneUsd).toBeGreaterThan(0)
    expect(loop.spend.totalUsd).toBe(Math.round(((loop.spend.jobUsd ?? 0) + (loop.spend.laneUsd ?? 0)) * 100) / 100)
    expect(loop.spend.perLanding).toBe(Math.round(((loop.spend.totalUsd ?? 0) / 2) * 100) / 100)

    // Index instants pass through as the transcript wrote them, like every
    // other verb's; only what git or the daemon wrote is normalized.
    expect(loop.spoke).toEqual({ lastPrompt: '2026-10-15T09:00:01Z', lastText: '2026-10-15T12:01:00Z', lastSent: null })
  })

  test('a job without a queue or a daemon still answers: no tranche, no score, the ledger side alone', async () => {
    const { dir } = await repo()
    const { db } = await corpus(dir)
    const loop = await getLoop(db, 'commander', { now: Date.parse('2026-10-15T12:30:00Z'), live: { rows: [], states: new Map() }, queue: 'docs/NOPE.md' })
    expect(loop.tranche).toBeNull()
    expect(loop.score).toEqual([])
    expect(loop.gate).toBeNull()
    expect(loop.job).toMatchObject({ name: 'commander', state: 'working', tempo: null, ctx: null })
    // No base: every lane the job ever spawned, newest first.
    expect(loop.lanes.map((l) => l.name)).toEqual(['att-2', 'att-1', 'att-0'])
    expect(loop.spend.perLanding).toBeNull()
  })

  test('a name nothing matches is an error, never an empty loop', async () => {
    const { dir } = await repo()
    const { db } = await corpus(dir)
    await expect(getLoop(db, 'nobody', { live: { rows: [], states: new Map() } })).rejects.toThrow(/no job matches/)
  })
})
