import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { conversationOf } from '../src/conversation'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { purgeSession } from '../src/purge'
import { indexSpawns } from '../src/spawns'
import { getTrace } from '../src/trace'
import { listUsage } from '../src/usage'
import { createApp } from '../src/web'
import { assistant as subRequest, r2, SONNET, type Tok, usd } from './spawn-corpus'

// Every subagent request is charged to a turn: the turn of the latest call
// addressed to its agent at or before the request's instant. A call is the
// one that created the agent — its `Agent` tool call (meta `toolUseId`), the
// `Workflow` call whose result names its run, or else the turn its first
// prompt id names — or a `SendMessage` to it, which charges what the agent
// does after it to the send's turn. Until this, the session page summed the
// subagents into the header alone and said, in a footnote, that no turn held
// them.

const WELL = '-u-code-fun-app'
const SESSION = 'sess-s'
const MAIN_MODEL = 'claude-opus-5'
const DAY = '2026-11-13'
const T = (hms: string) => `${DAY}T${hms}.000Z`

function prompt(ts: string, promptId: string, text: string) {
  return JSON.stringify({ type: 'user', timestamp: ts, promptId, sessionId: SESSION, message: { role: 'user', content: text } })
}
function main(ts: string, id: string, content: unknown[], stop = 'tool_use') {
  return JSON.stringify({
    type: 'assistant', timestamp: ts, sessionId: SESSION,
    message: { id, model: MAIN_MODEL, role: 'assistant', stop_reason: stop, content, usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 10_000, output_tokens: 100 } },
  })
}
function call(ts: string, id: string, toolUseId: string, name: string, input: object) {
  return main(ts, id, [{ type: 'tool_use', id: toolUseId, name, input }])
}
function result(ts: string, promptId: string, toolUseId: string, text: string) {
  return JSON.stringify({
    type: 'user', timestamp: ts, promptId, sessionId: SESSION, sourceToolAssistantUUID: 'x',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  })
}
// A subagent's opening record: only `user` records carry a prompt id, and it
// is the PARENT's turn at that moment.
function opener(ts: string, promptId: string | null) {
  return JSON.stringify({ type: 'user', timestamp: ts, ...(promptId ? { promptId } : {}), isSidechain: true, message: { role: 'user', content: 'go' } })
}

const REQ: Tok = { i: 1, cr: 100_000, o: 1_000 }
const ONE = usd(SONNET, DAY, REQ)
const MAIN_REQ = usd(MAIN_MODEL, DAY, { i: 2, cr: 10_000, o: 100 })

type Agent = { id: string; meta: object; lines: string[]; dir?: string }

function fixture(extra: Agent[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'lore-trace-spawns-'))
  const projects = join(dir, 'projects')
  const well = join(projects, WELL)
  const sub = join(well, SESSION, 'subagents')
  mkdirSync(join(sub, 'workflows', 'wf_abc-123'), { recursive: true })
  writeFileSync(
    join(well, `${SESSION}.jsonl`),
    [
      // Turn p1: an Agent call (instruction 0), its result, the reply.
      prompt(T('10:00:00'), 'p1', 'audit the parser'),
      call(T('10:00:05'), 'm1', 'tu_agent', 'Agent', { description: 'audit', subagent_type: 'lean', prompt: 'audit it' }),
      result(T('10:05:00'), 'p1', 'tu_agent', 'audit done'),
      main(T('10:05:10'), 'm2', [{ type: 'text', text: 'Audited.' }], 'end_turn'),
      // Turn p2: a follow-up to that agent (instruction 0), then a Workflow
      // (instruction 1) whose result names its run.
      prompt(T('11:00:00'), 'p2', 'one more pass, then the sweep'),
      call(T('11:00:05'), 'm3', 'tu_send', 'SendMessage', { to: 'aaa', summary: 'one more pass', message: 'check the tail too' }),
      result(T('11:00:06'), 'p2', 'tu_send', '{"success":true}'),
      call(T('11:00:10'), 'm4', 'tu_wf', 'Workflow', { script: 'export const meta = {}' }),
      result(T('11:00:11'), 'p2', 'tu_wf', 'Workflow launched in background.\nRun ID: wf_abc-123\nTask ID: t1'),
      main(T('11:00:20'), 'm5', [{ type: 'text', text: 'Sweeping.' }], 'end_turn'),
      // Turn p3: nothing called; a nested agent's opener names it.
      prompt(T('12:00:00'), 'p3', 'status?'),
      main(T('12:00:05'), 'm6', [{ type: 'text', text: 'All green.' }], 'end_turn'),
    ].join('\n'),
  )
  const agents: Agent[] = [
    // Spawned by the Agent call; two requests before the follow-up, one after.
    {
      id: 'aaa',
      meta: { agentType: 'lean', description: 'audit', toolUseId: 'tu_agent' },
      lines: [opener(T('10:00:06'), 'p1'), subRequest(T('10:00:10'), 'a-1', SONNET, REQ), subRequest(T('10:04:00'), 'a-2', SONNET, REQ), subRequest(T('11:00:30'), 'a-3', SONNET, REQ)],
    },
    // A workflow agent: no toolUseId; its run is named by the Workflow result.
    { id: 'www', dir: join(sub, 'workflows', 'wf_abc-123'), meta: { agentType: 'workflow-step' }, lines: [opener(T('11:00:12'), 'p2'), subRequest(T('11:01:00'), 'w-1', SONNET, REQ)] },
    // Nested: its toolUseId is a call inside another subagent, in no
    // main-thread row; its opener's prompt id is the parent's turn p3.
    { id: 'nnn', meta: { agentType: 'lean', description: 'nested', spawnDepth: 2, toolUseId: 'tu_inner' }, lines: [opener(T('12:00:01'), 'p3'), subRequest(T('12:00:02'), 'n-1', SONNET, REQ)] },
    // An old harness: meta carried no toolUseId at all.
    { id: 'ooo', meta: { agentType: 'general', description: 'old harness' }, lines: [opener(T('10:00:30'), 'p1'), subRequest(T('10:01:00'), 'o-1', SONNET, REQ)] },
    // An orphan: a call in another session, a prompt id that matches nothing.
    { id: 'zzz', meta: { agentType: 'lean', description: 'orphan', toolUseId: 'tu_elsewhere' }, lines: [opener(T('10:02:00'), 'p-nowhere'), subRequest(T('10:02:30'), 'z-1', SONNET, REQ)] },
    ...extra,
  ]
  for (const a of agents) {
    const at = a.dir ?? sub
    writeFileSync(join(at, `agent-${a.id}.meta.json`), JSON.stringify(a.meta))
    writeFileSync(join(at, `agent-${a.id}.jsonl`), a.lines.join('\n'))
  }
  return { dir, projects }
}

async function seed(extra: Agent[] = []) {
  const f = fixture(extra)
  const db = openDb(join(f.dir, 'lore.db'))
  await buildIndex(db, { projectsDir: f.projects, historyPath: join(f.dir, 'none.jsonl') })
  await indexSpawns(db, { projectsDir: f.projects })
  return { db, ...f }
}

const at = (x: { agents: { agentId: string; via: string; at: number | null; requests: number; listUsd: number | null }[] }) =>
  x.agents.map((a) => [a.agentId, a.via, a.at, a.requests, a.listUsd])

describe('spawn_origins: where each agent came from', () => {
  test('one row per spawn file: meta toolUseId and the first user record\'s prompt id, nulls kept', async () => {
    const { db } = await seed()
    const rows = db.prepare('SELECT agent_id, session_id, tool_use_id, prompt_id FROM spawn_origins ORDER BY agent_id').all()
    expect(rows).toEqual([
      { agent_id: 'aaa', session_id: SESSION, tool_use_id: 'tu_agent', prompt_id: 'p1' },
      { agent_id: 'nnn', session_id: SESSION, tool_use_id: 'tu_inner', prompt_id: 'p3' },
      { agent_id: 'ooo', session_id: SESSION, tool_use_id: null, prompt_id: 'p1' },
      { agent_id: 'www', session_id: SESSION, tool_use_id: null, prompt_id: 'p2' },
      { agent_id: 'zzz', session_id: SESSION, tool_use_id: 'tu_elsewhere', prompt_id: 'p-nowhere' },
    ])
  })

  test('a plain index backfills current spawn rows with no origin, once, then skips', async () => {
    const { db, projects } = await seed()
    // An index built before the table: spawns and their requests current,
    // no origins.
    db.exec('DELETE FROM spawn_origins')
    expect((await indexSpawns(db, { projectsDir: projects })).spawnsIndexed).toBe(5)
    expect(db.prepare('SELECT COUNT(*) AS n FROM spawn_origins').get()).toEqual({ n: 5 })
    expect((await indexSpawns(db, { projectsDir: projects })).spawnsIndexed).toBe(0)
    // A file with no request still gets its row, so it too is read once.
    writeFileSync(join(projects, WELL, SESSION, 'subagents', 'agent-empty.jsonl'), opener(T('13:00:00'), 'p3'))
    expect((await indexSpawns(db, { projectsDir: projects })).spawnsIndexed).toBe(1)
    expect(db.prepare("SELECT prompt_id FROM spawn_origins WHERE agent_id = 'empty'").get()).toEqual({ prompt_id: 'p3' })
    expect((await indexSpawns(db, { projectsDir: projects })).spawnsIndexed).toBe(0)
  })

  test('purge takes the session\'s origins with it', async () => {
    const { db, dir, projects } = await seed()
    const opts = { projectsDir: projects, archiveDir: join(dir, 'archive'), historyPath: join(dir, 'none.jsonl'), indexOnly: true }
    expect((await purgeSession(db, SESSION, opts)).rows.spawn_origins).toBe(5)
    await purgeSession(db, SESSION, { ...opts, yes: true })
    expect(db.prepare('SELECT COUNT(*) AS n FROM spawn_origins').get()).toEqual({ n: 0 })
  })
})

describe('trace: each subagent request is charged to a turn', () => {
  test('spawn, resume, workflow, nested and old-harness agents land in their turns, in instruction order', async () => {
    const { db } = await seed()
    const t = getTrace(db, SESSION, { limit: 10 })
    const [p1, p2, p3] = t.transactions
    // p1: the old-harness agent by its prompt id (no row, so at its head),
    // then the Agent call at instruction 0 with the two requests before the
    // follow-up.
    expect(at(p1!)).toEqual([
      ['ooo', 'turn', null, 1, r2(ONE)],
      ['aaa', 'spawn', 0, 2, r2(ONE * 2)],
    ])
    // p2: the follow-up (instruction 0) holds the request after it; the
    // Workflow (instruction 1) holds its run's agent.
    expect(at(p2!)).toEqual([
      ['aaa', 'message', 0, 1, r2(ONE)],
      ['www', 'workflow', 1, 1, r2(ONE)],
    ])
    // p3: the nested agent, by its opener's prompt id.
    expect(at(p3!)).toEqual([['nnn', 'turn', null, 1, r2(ONE)]])
    // The row names the agent as the spawns table knows it, with the
    // verified model.
    expect(p1!.agents[1]).toMatchObject({ agentId: 'aaa', agentType: 'lean', description: 'audit', model: SONNET, output: 2_000 })
    // A turn's fee: the main thread, the subagents it paid for, the two.
    expect(p1!.listUsd).toBe(r2(MAIN_REQ * 2))
    expect(p1!.spawnUsd).toBe(r2(ONE * 3))
    expect(p1!.allInUsd).toBe(r2(r2(MAIN_REQ * 2) + r2(ONE * 3)))
    expect(p3!.spawnUsd).toBe(r2(ONE))
  })

  test('an agent no turn can hold is listed in unplacedAgents and still counted', async () => {
    const { db } = await seed()
    const t = getTrace(db, SESSION, { limit: 10 })
    expect(t.unplacedAgents.map((a) => [a.agentId, a.via, a.at, a.requests, a.listUsd])).toEqual([['zzz', 'none', null, 1, r2(ONE)]])
    // Seven requests: three of the audit's, one each for the other four.
    expect(t.totals.spawnUsd).toBe(r2(ONE * 7))
  })

  test('the turns and the unplaced sum to the total, and the total is the ledger\'s', async () => {
    const { db } = await seed()
    const t = getTrace(db, SESSION, { limit: 10 })
    const turns = t.transactions.reduce((n, x) => n + (x.spawnUsd ?? 0), 0) + t.unplacedAgents.reduce((n, a) => n + (a.listUsd ?? 0), 0)
    expect(r2(turns)).toBe(t.totals.spawnUsd!)
    const ledger = listUsage(db, { by: 'session', sessions: [SESSION], limit: 1, subagents: true }).totals
    expect(t.totals.spawnUsd).toBe(ledger.spawnUsd!)
    expect(t.totals.allInUsd).toBe(ledger.allInUsd!)
    // The requests too: every subagent request is in exactly one row.
    const rows = [...t.transactions.flatMap((x) => x.agents), ...t.unplacedAgents]
    expect(rows.reduce((n, a) => n + a.requests, 0)).toBe(ledger.spawnRequests!)
    // --limit pages the turns, never the totals.
    expect(getTrace(db, SESSION, { limit: 1 }).totals.spawnUsd).toBe(t.totals.spawnUsd)
  })

  test('an unpriced model nulls its own turn and the totals, and no other turn', async () => {
    const { db } = await seed([
      { id: 'uuu', meta: { agentType: 'lean', description: 'mystery', spawnDepth: 2 }, lines: [opener(T('12:00:01'), 'p3'), subRequest(T('12:00:03'), 'u-1', 'claude-unknown-9', REQ)] },
    ])
    const t = getTrace(db, SESSION, { limit: 10 })
    const [p1, p2, p3] = t.transactions
    expect([p1!.spawnUsd, p2!.spawnUsd]).toEqual([r2(ONE * 3), r2(ONE * 2)])
    expect(p3!.spawnUsd).toBeNull()
    expect(p3!.allInUsd).toBeNull()
    expect(p3!.agents.find((a) => a.agentId === 'uuu')?.listUsd).toBeNull()
    expect([t.totals.spawnUsd, t.totals.allInUsd]).toEqual([null, null])
    expect(listUsage(db, { by: 'session', sessions: [SESSION], limit: 1, subagents: true }).totals.spawnUsd).toBeNull()
  })

  test('a usage-less record with no model is a request at zero: it counts and prices nothing', async () => {
    const bare = JSON.stringify({ type: 'assistant', timestamp: T('12:00:04'), message: { id: 'b-1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
    const { db } = await seed([{ id: 'bbb', meta: { spawnDepth: 2 }, lines: [opener(T('12:00:01'), 'p3'), bare] }])
    const p3 = getTrace(db, SESSION, { limit: 10 }).transactions[2]!
    expect(p3.agents.find((a) => a.agentId === 'bbb')).toMatchObject({ requests: 1, listUsd: 0 })
    expect(p3.spawnUsd).toBe(r2(ONE))
  })
})

describe('the pages place them too', () => {
  const Turn = z.object({ listUsd: z.number().nullable(), spawnUsd: z.number().nullable(), allInUsd: z.number().nullable() })

  test('block view: the spine is all-in, the charged call carries its agent, the footnote is gone', async () => {
    const { db } = await seed()
    const app = createApp(() => db, { wikiDir: '/nonexistent', agents: async () => [] })
    const page = await (await app.request(`/session/${SESSION}`)).text()
    expect(page).not.toContain('not placed in turns')
    const t = getTrace(db, SESSION, { limit: 10 })
    const p1 = t.transactions[0]!
    // The spine's fee for p1 is all-in, with the split in its tooltip.
    expect(page).toContain(`title="main $${p1.listUsd!.toFixed(2)} · subagents $${p1.spawnUsd!.toFixed(2)}">$${p1.allInUsd!.toFixed(2)}</span>`)
    // The Agent call's row says what its agent cost: model, requests, dollars.
    expect(page).toMatch(/class="subcost"[^>]*>[^<]*sonnet[^<]*· 2 req · \$0\.\d\d/)
    // The agent with no row is named at its turn's head.
    expect(page).toContain('old harness')
    // An agent no turn holds is said where the number is read.
    expect(page).toContain('1 unplaced')
    // The fee bar takes the subagents, so it sums to the list $ tile.
    expect(page).toContain('class="seg subagents"')
    const json = z.object({ transactions: z.array(Turn) }).parse(await (await app.request(`/session/${SESSION}?json=1`)).json())
    expect(json.transactions[0]).toEqual({ listUsd: p1.listUsd, spawnUsd: p1.spawnUsd, allInUsd: p1.allInUsd })
  })

  test('conversation: a turn carries its subagents, and the work beat holding the call carries its cost', async () => {
    const { db } = await seed()
    const t = getTrace(db, SESSION, { limit: 10, steps: true })
    const [c1, c2] = conversationOf(t)
    expect([c1!.spawnUsd, c1!.allInUsd]).toEqual([t.transactions[0]!.spawnUsd, t.transactions[0]!.allInUsd])
    // p1's work beat holds the Agent call (instruction 0): the two requests
    // charged there, not the old-harness agent (it has no call).
    const w1 = c1!.beats.find((b) => b.kind === 'work')
    expect(w1).toMatchObject({ kind: 'work', from: 0, to: 1, spawnUsd: r2(ONE * 2) })
    // p2: the follow-up is a `sent` beat and carries its resumed request; the
    // Workflow sits in the work beat after it.
    const sent = c2!.beats.find((b) => b.kind === 'sent')
    expect(sent).toMatchObject({ kind: 'sent', spawnUsd: r2(ONE) })
    expect(c2!.beats.find((b) => b.kind === 'work')).toMatchObject({ from: 1, to: 2, spawnUsd: r2(ONE) })
    const app = createApp(() => db, { wikiDir: '/nonexistent', agents: async () => [] })
    const page = await (await app.request(`/session/${SESSION}?view=conversation`)).text()
    expect(page).toContain(`$${t.transactions[0]!.allInUsd!.toFixed(2)}`)
    expect(page).toContain(`subagents $${r2(ONE * 2).toFixed(2)}`)
  })
})
