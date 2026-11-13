import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRow, JobState } from '../src/agents'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { indexJobs } from '../src/jobs'
import { getLoop } from '../src/loop'

// One job that runs others, in miniature: a commander in its worktree that
// spawned three lanes through `ccc spawn --json` (one before the window),
// the steer that set it to work and that it hands back to, and the daemon's
// side (the roster and a state.json with a shell in flight) handed in
// rather than read — the kit has no daemon.

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

const CMD_CWD = '/u/code/fun/app/.claude/worktrees/cmd'

function wells(cmdCwd: string, w1: string, w2: string) {
  const spawn = (cwd: string, ref: string, name: string) => `{"cwd":"${cwd}","draft":false,"ref":"${ref}","said":"backgrounded · ${ref} · ${name}\\n  claude attach ${ref}","worktree":{"base":"worktree-cmd"}}`
  return {
    [slug(cmdCwd)]: {
      'cmd-1': [
        bridge('cmd-1', 'cse_CMD', '2026-10-15T09:00:00Z'),
        prompt('cmd-1', 'c0dec0de', '2026-10-15T09:00:01Z', 'P1', 'run the loop', cmdCwd),
        reply('cmd-1', 'c0dec0de', '2026-10-15T09:00:05Z', 'r0', 'reading the queue'),
        // Before the window: it does not pay for it.
        bash('cmd-1', 'c0dec0de', '2026-10-15T09:30:00Z', 'tu_0', 'ccc spawn --worktree=att-0 --name att-0 --model sonnet --json - < brief.md'),
        result('cmd-1', 'c0dec0de', '2026-10-15T09:30:05Z', 'P1', 'tu_0', spawn(w1, '00000000', 'att-0')),
        bash('cmd-1', 'c0dec0de', '2026-10-15T10:05:00Z', 'tu_1', 'ccc spawn --worktree=att-1 --name att-1 --model sonnet --json - < brief.md'),
        result('cmd-1', 'c0dec0de', '2026-10-15T10:05:05Z', 'P1', 'tu_1', spawn(w1, 'deadbeef', 'att-1')),
        bash('cmd-1', 'c0dec0de', '2026-10-15T11:05:00Z', 'tu_2', 'ccc spawn --worktree=att-2 --name att-2 --model opus --json - < brief.md'),
        result('cmd-1', 'c0dec0de', '2026-10-15T11:05:05Z', 'P1', 'tu_2', spawn(w2, 'cafebabe', 'att-2')),
        // The commander hands back to the steer that set it to work: the
        // answer names the steer's ref inside the window, and is no spawn.
        bash('cmd-1', 'c0dec0de', '2026-10-15T11:30:00Z', 'tu_3', 'ccc clear steer --then "the second pass" --json'),
        result('cmd-1', 'c0dec0de', '2026-10-15T11:30:05Z', 'P1', 'tu_3', spawn(cmdCwd, 'beefbeef', 'steer')),
        reply('cmd-1', 'c0dec0de', '2026-10-15T12:01:00Z', 'r1', '2 booked; gate running'),
      ],
      // The steer: it cleared the commander into this window (so it reads
      // as the commander's parent) and worked inside it — never a lane.
      'beefbeef-0000-4000-8000-000000000009': [
        prompt('beefbeef-0000-4000-8000-000000000009', 'beefbeef-0000-4000-8000-000000000009', '2026-10-15T08:50:00Z', 'S1', 'the first pass', cmdCwd),
        bash('beefbeef-0000-4000-8000-000000000009', 'beefbeef-0000-4000-8000-000000000009', '2026-10-15T08:55:00Z', 'tu_s', 'ccc clear commander --then "the second tranche" --json'),
        result('beefbeef-0000-4000-8000-000000000009', 'beefbeef-0000-4000-8000-000000000009', '2026-10-15T08:55:05Z', 'S1', 'tu_s', spawn(cmdCwd, 'c0dec0de', 'commander')),
        reply('beefbeef-0000-4000-8000-000000000009', 'beefbeef-0000-4000-8000-000000000009', '2026-10-15T11:40:00Z', 's1', 'the pass is written'),
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
  const now = Date.parse('2026-10-15T12:30:00Z')
  const liveSide = (w2: string) => ({
    rows: [
      row({ id: 'cmd00000', name: 'commander', state: 'working', tempo: 'busy', detail: '2 booked; gate running', cwd: CMD_CWD, sessionId: 'cmd-1', ctx: 240_000, model: 'claude-opus-5-5' }),
      row({ id: 'cafebabe', name: 'att-2', state: 'working', cwd: w2, sessionId: 'cafebabe-0000-4000-8000-000000000002', ctx: 310_000, model: 'claude-opus-5-5' }),
    ],
    states: new Map<string, JobState | null>([
      ['cmd00000', { fan: [{ id: 'g1', kind: 'shell', label: 'python3 tools/release_gate.py game --scope abc', startedAt: now - 600_000 }, { id: 'w1', kind: 'shell', label: 'python3 tools/lanewait.py att-2', startedAt: now - 60_000, doneAt: now - 30_000 }] }],
    ]),
  })

  test('one job: its row at the daemon, what is running, the lanes of the window plus the live ones, the fee, who spoke last', async () => {
    const { db, w2 } = await corpus(CMD_CWD)
    const live = liveSide(w2)
    const loop = await getLoop(db, 'commander', { now, live, since: '2026-10-15T10:00:00.000Z' })

    expect(loop.job).toMatchObject({ name: 'commander', jobId: 'cmd00000', state: 'working', tempo: 'busy', detail: '2 booked; gate running', ctx: 240_000, cwd: CMD_CWD, sessions: 1 })
    expect(loop.window).toEqual({ since: '2026-10-15T10:00:00.000Z', until: null })

    // The daemon's fan, unfinished shells only — every one, under its own
    // label: what a shell IS (a gate, a wait) is the caller's to read.
    expect(loop.running).toEqual([{ kind: 'shell', label: 'python3 tools/release_gate.py game --scope abc', since: new Date(now - 600_000).toISOString() }])

    // att-0 was spawned before the window and is not live: not in it. The
    // steer the commander cleared is its parent, never a lane.
    expect(loop.lanes.map((l) => l.name)).toEqual(['att-2', 'att-1'])
    expect(loop.lanesTotal).toBe(2)
    expect(loop.lanes[0]).toMatchObject({ live: true, state: 'working', model: 'claude-opus-5-5', ctx: 310_000, deep: true, spawnedAt: '2026-10-15T11:05:00.000Z' })
    expect(loop.lanes[0]?.ageMs).toBe(85 * 60_000)
    expect(loop.lanes[1]).toMatchObject({ live: false, state: 'done', model: 'claude-sonnet-5-5', ctx: null, peak: 1000, deep: false })
    // A lane that is gone has no live context: it is deep on what it
    // REACHED, so a closed window still counts its deep lanes.
    const shallow = await getLoop(db, 'commander', { now, live, since: '2026-10-15T10:00:00.000Z', deep: 1000 })
    expect(shallow.lanes.map((l) => [l.name, l.deep])).toEqual([['att-2', true], ['att-1', true]])

    // The fee inside the window: the commander's requests after 10:00 and
    // the two lanes'. Less than the whole job's, which also paid for att-0.
    expect(loop.spend.jobUsd).toBeGreaterThan(0)
    expect(loop.spend.laneUsd).toBeGreaterThan(0)
    expect(loop.spend.totalUsd).toBe(Math.round(((loop.spend.jobUsd ?? 0) + (loop.spend.laneUsd ?? 0)) * 100) / 100)
    const whole = await getLoop(db, 'commander', { now, live })
    expect(whole.spend.jobUsd ?? 0).toBeGreaterThan(loop.spend.jobUsd ?? 0)
    expect(whole.lanesTotal).toBe(3)
    expect(whole.lanes.reduce((n, l) => n + l.requests, 0)).toBeGreaterThan(loop.lanes.reduce((n, l) => n + l.requests, 0))

    // `--lanes` caps the rows listed, never the spend.
    const capped = await getLoop(db, 'commander', { now, live, since: '2026-10-15T10:00:00.000Z', lanes: 1 })
    expect(capped.lanes.map((l) => l.name)).toEqual(['att-2'])
    expect(capped.lanesTotal).toBe(2)
    expect(capped.spend.laneUsd).toBe(loop.spend.laneUsd)

    // Index instants pass through as the transcript wrote them, like every
    // other verb's; only what the daemon wrote is normalized.
    expect(loop.spoke).toEqual({ lastPrompt: '2026-10-15T09:00:01Z', lastText: '2026-10-15T12:01:00Z', lastSent: null })
  })

  test('--until closes the window: lanes by spawn instant inside it, nothing live, ages to its end', async () => {
    const { db, w2 } = await corpus(CMD_CWD)
    const loop = await getLoop(db, 'commander', { now, live: liveSide(w2), since: '2026-10-15T10:00:00.000Z', until: '2026-10-15T11:00:00.000Z' })
    expect(loop.window).toEqual({ since: '2026-10-15T10:00:00.000Z', until: '2026-10-15T11:00:00.000Z' })
    // att-1 at 10:05 is in; att-2 at 11:05 is past the end though it is live
    // now; att-0 before the start is not.
    expect(loop.lanes.map((l) => l.name)).toEqual(['att-1'])
    // Measured to the end, not to now: 55 minutes old at 11:00.
    expect(loop.lanes[0]?.ageMs).toBe(55 * 60_000)
  })

  test('no window is the whole job, and no daemon still answers: the ledger side alone', async () => {
    const { db } = await corpus(CMD_CWD)
    const loop = await getLoop(db, 'commander', { now, live: { rows: [], states: new Map() } })
    expect(loop.window).toEqual({ since: null, until: null })
    expect(loop.running).toEqual([])
    expect(loop.job).toMatchObject({ name: 'commander', state: 'working', tempo: null, ctx: null })
    // Every lane the job ever spawned, newest first.
    expect(loop.lanes.map((l) => l.name)).toEqual(['att-2', 'att-1', 'att-0'])
  })

  test('a name nothing matches is an error, never an empty loop', async () => {
    const { db } = await corpus(CMD_CWD)
    await expect(getLoop(db, 'nobody', { live: { rows: [], states: new Map() } })).rejects.toThrow(/no job matches/)
  })
})
