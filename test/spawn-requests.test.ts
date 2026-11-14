import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { readLimits } from '../src/limits'
import { purgeSession } from '../src/purge'
import { indexSpawns } from '../src/spawns'
import { listUsage, priceOf, rateFor } from '../src/usage'

// The ledger beside the account's quota counted the main thread alone: the
// `requests` table holds one row per MAIN-thread request, and a subagent's
// requests lived only as a count and an output total on its `spawns` row. On
// the night of 2026-11-13 → 14 another project priced one window from the
// subagent transcripts by hand at 941.6 USD, 19.2 USD a point, where `lore
// limits` said 13.5. The account counts subagent requests against the week;
// lore's figure beside it has to count them too.

type Tok = { i?: number; cw?: number; cw1h?: number; cr?: number; o?: number; th?: number }
function assistant(ts: string, id: string, model: string, t: Tok, stop: string | null = 'end_turn'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      id,
      model,
      role: 'assistant',
      stop_reason: stop,
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: t.i ?? 0,
        cache_creation_input_tokens: t.cw ?? 0,
        ...(t.cw1h != null ? { cache_creation: { ephemeral_5m_input_tokens: (t.cw ?? 0) - t.cw1h, ephemeral_1h_input_tokens: t.cw1h } } : {}),
        cache_read_input_tokens: t.cr ?? 0,
        output_tokens: t.o ?? 0,
        output_tokens_details: { thinking_tokens: t.th ?? 0 },
      },
    },
  })
}

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5'
const FABLE = 'claude-fable-5-2'
const WEEK_END = '2026-11-14T11:00:00.000Z'
const NOW = '2026-11-14T10:00:00.000Z'

// One well, one main session, three subagent files under it: an Opus-served
// session that fanned out to a Sonnet miner (two streaming snapshots of one
// request, then a second request, then one past the window), a Fable spawn,
// and a workflow agent. The mod read the week at 10 then 50.
function corpus(): { dir: string; projects: string; limitsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lore-spawn-requests-'))
  const projects = join(dir, 'projects')
  const well = join(projects, '-u-code-fun-app')
  const sub = join(well, 'sess-9', 'subagents')
  mkdirSync(join(sub, 'workflows', 'wf_run1'), { recursive: true })
  writeFileSync(
    join(well, 'sess-9.jsonl'),
    [
      assistant('2026-11-13T20:00:00Z', 'main-0', OPUS, { i: 10, cr: 1_000_000, o: 10_000 }),
      assistant('2026-11-13T21:00:00Z', 'main-1', OPUS, { i: 10, cr: 1_000_000, o: 10_000 }),
      assistant('2026-11-14T08:00:00Z', 'main-2', OPUS, { i: 10, cr: 1_000_000, o: 10_000 }),
    ].join('\n'),
  )
  writeFileSync(join(sub, 'agent-miner.meta.json'), JSON.stringify({ agentType: 'lore-miner' }))
  writeFileSync(
    join(sub, 'agent-miner.jsonl'),
    [
      JSON.stringify({ type: 'user', timestamp: '2026-11-13T21:30:00Z', message: { content: 'go' } }),
      // Two snapshots of one request: counted once, each field its max.
      assistant('2026-11-13T21:30:05Z', 's-1', SONNET, { i: 2, cw: 100_000, cw1h: 100_000, o: 5 }, null),
      assistant('2026-11-13T21:30:06Z', 's-1', SONNET, { i: 2, cw: 100_000, cw1h: 100_000, o: 500 }, 'tool_use'),
      assistant('2026-11-13T22:00:00Z', 's-2', SONNET, { i: 2, cw: 1_000, cw1h: 1_000, cr: 4_000_000, o: 3_000, th: 200 }),
      // After the last reading and past the until of the narrow window.
      assistant('2026-11-14T09:30:00Z', 's-3', SONNET, { i: 2, cr: 4_000_000, o: 3_000 }),
    ].join('\n'),
  )
  writeFileSync(
    join(sub, 'agent-fable.jsonl'),
    [assistant('2026-11-13T23:00:00Z', 'f-1', FABLE, { i: 5, cw: 50_000, cw1h: 50_000, cr: 2_000_000, o: 20_000 })].join('\n'),
  )
  writeFileSync(
    join(sub, 'workflows', 'wf_run1', 'agent-wf.jsonl'),
    [assistant('2026-11-14T01:00:00Z', 'w-1', SONNET, { i: 1, cr: 1_000_000, o: 1_000 })].join('\n'),
  )
  const limitsPath = join(dir, 'limits.jsonl')
  const at = (ts: string, kind: string, pct: number) => JSON.stringify({ ts, session: 'sess-9', kind, pct, resetsAt: WEEK_END })
  writeFileSync(
    limitsPath,
    [
      at('2026-11-13T20:30:00.000Z', 'seven_day', 10),
      at('2026-11-13T20:30:00.000Z', 'seven_day_fable', 10),
      at('2026-11-14T09:00:00.000Z', 'seven_day', 50),
      at('2026-11-14T09:00:00.000Z', 'seven_day_fable', 30),
    ].join('\n'),
  )
  return { dir, projects, limitsPath }
}

async function seed() {
  const c = corpus()
  const db = openDb(join(c.dir, 'lore.db'))
  await buildIndex(db, { projectsDir: c.projects, historyPath: join(c.dir, 'none.jsonl'), limitsPath: c.limitsPath })
  await indexSpawns(db, { projectsDir: c.projects })
  return { db, ...c }
}

const usd = (model: string, day: string, t: Tok) => {
  const p = priceOf({ input: t.i ?? 0, cacheWrite: t.cw ?? 0, cacheWrite1h: t.cw1h ?? 0, cacheRead: t.cr ?? 0, output: t.o ?? 0 }, rateFor(model, day)!)
  return p.input + p.cacheWrite + p.cacheRead + p.output
}
const r2 = (n: number) => Math.round(n * 100) / 100
const MAIN = usd(OPUS, '2026-11-13', { i: 10, cr: 1_000_000, o: 10_000 })
const S1 = usd(SONNET, '2026-11-13', { i: 2, cw: 100_000, cw1h: 100_000, o: 500 })
const S2 = usd(SONNET, '2026-11-13', { i: 2, cw: 1_000, cw1h: 1_000, cr: 4_000_000, o: 3_000 })
const S3 = usd(SONNET, '2026-11-14', { i: 2, cr: 4_000_000, o: 3_000 })
const F1 = usd(FABLE, '2026-11-13', { i: 5, cw: 50_000, cw1h: 50_000, cr: 2_000_000, o: 20_000 })
const W1 = usd(SONNET, '2026-11-14', { i: 1, cr: 1_000_000, o: 1_000 })

describe('spawn_requests: the subagent ledger', () => {
  test('indexSpawns writes one row per request of every subagent file, snapshots folded', async () => {
    const { db } = await seed()
    const rows = db
      .prepare('SELECT agent_id, session_id, message_id, model, input_tokens, cache_write_tokens, cache_write_1h_tokens, cache_read_tokens, output_tokens, thinking_tokens, stop_reason, ts FROM spawn_requests ORDER BY ts')
      .all()
    expect(rows).toEqual([
      { agent_id: 'miner', session_id: 'sess-9', message_id: 's-1', model: SONNET, input_tokens: 2, cache_write_tokens: 100_000, cache_write_1h_tokens: 100_000, cache_read_tokens: 0, output_tokens: 500, thinking_tokens: 0, stop_reason: 'tool_use', ts: '2026-11-13T21:30:05Z' },
      { agent_id: 'miner', session_id: 'sess-9', message_id: 's-2', model: SONNET, input_tokens: 2, cache_write_tokens: 1_000, cache_write_1h_tokens: 1_000, cache_read_tokens: 4_000_000, output_tokens: 3_000, thinking_tokens: 200, stop_reason: 'end_turn', ts: '2026-11-13T22:00:00Z' },
      { agent_id: 'fable', session_id: 'sess-9', message_id: 'f-1', model: FABLE, input_tokens: 5, cache_write_tokens: 50_000, cache_write_1h_tokens: 50_000, cache_read_tokens: 2_000_000, output_tokens: 20_000, thinking_tokens: 0, stop_reason: 'end_turn', ts: '2026-11-13T23:00:00Z' },
      { agent_id: 'wf', session_id: 'sess-9', message_id: 'w-1', model: SONNET, input_tokens: 1, cache_write_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 1_000_000, output_tokens: 1_000, thinking_tokens: 0, stop_reason: 'end_turn', ts: '2026-11-14T01:00:00Z' },
      { agent_id: 'miner', session_id: 'sess-9', message_id: 's-3', model: SONNET, input_tokens: 2, cache_write_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 4_000_000, output_tokens: 3_000, thinking_tokens: 0, stop_reason: 'end_turn', ts: '2026-11-14T09:30:00Z' },
    ])
  })

  test('a plain index backfills a current spawn row that has no requests yet, once; a spawn with none is not re-read', async () => {
    const { db, projects } = await seed()
    // An index built before the table: the spawn rows are current by size and
    // mtime, the requests are not there.
    db.exec('DELETE FROM spawn_requests')
    const again = await indexSpawns(db, { projectsDir: projects })
    expect(again.spawnsIndexed).toBe(3)
    expect(db.prepare('SELECT COUNT(*) AS n FROM spawn_requests').get()).toEqual({ n: 5 })
    // Then it is current, and nothing is read.
    expect((await indexSpawns(db, { projectsDir: projects })).spawnsIndexed).toBe(0)
    // A spawn file with no request in it (refused at its first call, or cut
    // before one) is read once and left alone after.
    writeFileSync(join(projects, '-u-code-fun-app', 'sess-9', 'subagents', 'agent-empty.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-11-14T02:00:00Z', message: { content: 'go' } }))
    expect((await indexSpawns(db, { projectsDir: projects })).spawnsIndexed).toBe(1)
    expect((await indexSpawns(db, { projectsDir: projects })).spawnsIndexed).toBe(0)
  })
})

describe('purge: a session takes its subagent requests with it', () => {
  test('the dry run counts them and --yes deletes them', async () => {
    const { db, dir, projects } = await seed()
    const opts = { projectsDir: projects, archiveDir: join(dir, 'archive'), historyPath: join(dir, 'none.jsonl'), indexOnly: true }
    expect((await purgeSession(db, 'sess-9', opts)).rows.spawn_requests).toBe(5)
    await purgeSession(db, 'sess-9', { ...opts, yes: true })
    expect(db.prepare('SELECT COUNT(*) AS n FROM spawn_requests').get()).toEqual({ n: 0 })
  })
})

describe('listUsage: the subagent side, beside the main thread', () => {
  test('totals carry both sides; listUsd stays the main thread', async () => {
    const { db } = await seed()
    const u = listUsage(db, { by: 'week', limit: 10, subagents: true })
    expect(u.totals.requests).toBe(3)
    expect(u.totals.listUsd).toBe(r2(MAIN * 3))
    expect(u.totals.spawnRequests).toBe(5)
    expect(u.totals.spawnCacheRead).toBe(11_000_000)
    expect(u.totals.spawnRequestOutput).toBe(27_500)
    expect(u.totals.spawnUsd).toBe(r2(S1 + S2 + S3 + F1 + W1))
    expect(u.note).toMatch(/spawnUsd/)
  })

  test('by model, a model only subagents used is a row of its own', async () => {
    const { db } = await seed()
    const u = listUsage(db, { by: 'model', limit: 10, subagents: true })
    const by = Object.fromEntries(u.rows.map((r) => [r.key, [r.requests, r.spawnRequests, r.listUsd, r.spawnUsd]]))
    expect(by).toEqual({
      [OPUS]: [3, 0, r2(MAIN * 3), 0],
      [SONNET]: [0, 4, 0, r2(S1 + S2 + S3 + W1)],
      [FABLE]: [0, 1, 0, r2(F1)],
    })
    // Ranked all-in: Sonnet's subagents outspent the Opus main thread here.
    const ranked: [string, number][] = [
      [OPUS, MAIN * 3],
      [SONNET, S1 + S2 + S3 + W1],
      [FABLE, F1],
    ]
    expect(u.rows.map((r) => r.key)).toEqual(ranked.sort((a, b) => b[1] - a[1]).map(([k]) => k))
  })

  test('without `subagents` the report is what it was: no spawn* fields, no subagent-only rows', async () => {
    const { db } = await seed()
    const u = listUsage(db, { by: 'model', limit: 10 })
    expect(u.rows.map((r) => r.key)).toEqual([OPUS])
    expect(u.totals).not.toHaveProperty('spawnUsd')
    expect(u.rows[0]).not.toHaveProperty('spawnRequests')
    expect(u.note).not.toMatch(/spawnUsd/)
  })

  test('by session and well, a subagent request is its parent session\'s; the filters bound both sides', async () => {
    const { db } = await seed()
    const s = listUsage(db, { by: 'session', limit: 10, subagents: true }).rows[0]!
    expect([s.key, s.requests, s.spawnRequests, s.spawns]).toEqual(['sess-9', 3, 5, 3])
    const w = listUsage(db, { by: 'well', well: 'fun-app', limit: 10, subagents: true }).rows[0]!
    expect([w.key, w.spawnRequests]).toEqual(['-u-code-fun-app', 5])
    // A window by each request's own instant.
    const win = listUsage(db, { by: 'week', since: '2026-11-13T21:00:00Z', until: '2026-11-14T09:00:00Z', limit: 10, subagents: true }).totals
    expect([win.requests, win.spawnRequests, win.spawnUsd]).toEqual([2, 4, r2(S1 + S2 + F1 + W1)])
    // A model filter, by the subagent request's own model.
    const fable = listUsage(db, { by: 'week', model: 'fable', limit: 10, subagents: true }).totals
    expect([fable.requests, fable.spawnRequests, fable.spawnUsd]).toEqual([0, 1, r2(F1)])
    // A session filter that matches nothing matches nothing on either side.
    expect(listUsage(db, { by: 'week', session: 'nope', limit: 10, subagents: true }).totals).toMatchObject({ requests: 0, spawnRequests: 0, spawnUsd: 0 })
  })
})

describe('limits: the week counts what the account counts', () => {
  test('usage, implied and usdPerPoint are all-in; the main thread stays visible', async () => {
    const { db } = await seed()
    const week = readLimits(db, { limit: 10, now: NOW }).windows.find((w) => w.kind === 'seven_day')!
    // [from, 09:00]: three main requests, and S1, S2, F1, W1 (S3 is after the reading).
    expect(week.usage).toMatchObject({ requests: 7, mainRequests: 3, mainUsd: r2(MAIN * 3) })
    expect(week.usage!.listUsd).toBe(r2(MAIN * 3 + S1 + S2 + F1 + W1))
    expect(week.implied!.listUsd).toBe(r2(week.usage!.listUsd * 2))
    // Between the 10 (20:30) and the 50 (09:00): main-1, main-2, S1, S2, F1, W1 over 40 points.
    expect(week.usdPerPoint).toBe(r2((MAIN * 2 + S1 + S2 + F1 + W1) / 40))
    expect(week.mainUsdPerPoint).toBe(r2((MAIN * 2) / 40))
  })

  test('a week scoped to one model counts that model\'s subagent requests too', async () => {
    const { db } = await seed()
    const fable = readLimits(db, { limit: 10, now: NOW }).windows.find((w) => w.kind === 'seven_day_fable')!
    expect(fable.usage).toMatchObject({ requests: 1, mainRequests: 0, mainUsd: 0, listUsd: r2(F1) })
    expect(fable.usdPerPoint).toBe(r2(F1 / 20))
  })

  // A subagent record with no usage block and no model is a row at zero
  // (spawns.ts keeps the request count exact). With nothing to price it must
  // not mark the row unpriced: `spawnUsd` went null, and `lore limits` —
  // which reads a null as 0 — dropped every subagent dollar of the window.
  test('a usage-less record with no model does not unprice its row', async () => {
    const c = corpus()
    writeFileSync(
      join(c.projects, '-u-code-fun-app', 'sess-9', 'subagents', 'agent-bare.jsonl'),
      [
        JSON.stringify({ type: 'assistant', timestamp: '2026-11-13T22:30:00Z', message: { id: 'b-1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
        assistant('2026-11-13T22:31:00Z', 'b-2', SONNET, { i: 1, cr: 1_000_000, o: 1_000 }),
      ].join('\n'),
    )
    const db = openDb(join(c.dir, 'lore.db'))
    await buildIndex(db, { projectsDir: c.projects, historyPath: join(c.dir, 'none.jsonl'), limitsPath: c.limitsPath })
    await indexSpawns(db, { projectsDir: c.projects })
    const bare = db.prepare("SELECT message_id, model, cache_read_tokens FROM spawn_requests WHERE agent_id = 'bare' ORDER BY ts").all()
    expect(bare).toEqual([
      { message_id: 'b-1', model: null, cache_read_tokens: 0 },
      { message_id: 'b-2', model: SONNET, cache_read_tokens: 1_000_000 },
    ])
    const u = listUsage(db, { by: 'session', limit: 10, subagents: true })
    expect(u.unpriced).toEqual([])
    expect(u.totals.spawnUsd).not.toBeNull()
    const week = readLimits(db, { limit: 5, now: NOW }).windows.find((w) => w.kind === 'seven_day')
    expect(week?.usage?.listUsd ?? 0).toBeGreaterThan(week?.usage?.mainUsd ?? 0)
  })
})
