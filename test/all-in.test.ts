import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { indexedLookup } from '../src/agents'
import { listJobs } from '../src/job'
import { getTrace } from '../src/trace'
import { listUsage } from '../src/usage'
import { createApp, lastDays } from '../src/web'
import { todayLocal } from '../src/fmt'
import { F1, FABLE, MAIN, OPUS, r2, S1, S2, S3, seed, SONNET, W1, WELL } from './spawn-corpus'

// One meaning for a dollar on every totals surface: `allInUsd` is the main
// thread plus the subagents it ran, and every page and verb that prints a
// session's, a job's, a well's or a window's cost reads it. `listUsd` keeps
// meaning the main thread wherever it appears.

const MAIN3 = r2(MAIN * 3)
const SUBS = r2(S1 + S2 + S3 + F1 + W1)
const ALL = r2(MAIN3 + SUBS)

describe('listUsage: allInUsd', () => {
  test('each row and the totals carry allInUsd = listUsd + spawnUsd; listUsd stays the main thread', async () => {
    const { db } = await seed()
    const u = listUsage(db, { by: 'session', limit: 10, subagents: true })
    expect(u.rows[0]).toMatchObject({ key: 'sess-9', listUsd: MAIN3, spawnUsd: SUBS, allInUsd: ALL })
    expect(u.totals).toMatchObject({ listUsd: MAIN3, spawnUsd: SUBS, allInUsd: ALL })
    // Without `subagents` there is no all-in figure to read.
    expect(listUsage(db, { by: 'session', limit: 10 }).totals).not.toHaveProperty('allInUsd')
  })

  test('with split, the class and model splits cover both sides and sum to the all-in figure', async () => {
    const { db } = await seed()
    const u = listUsage(db, { by: 'week', limit: 10, split: true, subagents: true })
    const row = u.rows[0]!
    const classes = row.usd!
    expect(r2(classes.input + classes.cacheWrite + classes.cacheRead + classes.output)).toBe(ALL)
    const models = Object.fromEntries((row.models ?? []).map((m) => [m.model, [m.requests, m.spawnRequests, m.allInUsd == null ? null : r2(m.allInUsd)]]))
    // A subagent request under its own model; `requests` stays the main thread's.
    expect(models).toEqual({
      [OPUS]: [3, 0, MAIN3],
      [SONNET]: [0, 4, r2(S1 + S2 + S3 + W1)],
      [FABLE]: [0, 1, r2(F1)],
    })
    expect(r2((row.models ?? []).reduce((n, m) => n + (m.allInUsd ?? 0), 0))).toBe(ALL)
    // The main-thread split is what it was.
    const plain = listUsage(db, { by: 'week', limit: 10, split: true }).rows[0]!
    expect(plain.models).toEqual([{ model: OPUS, requests: 3, listUsd: MAIN * 3 }])
  })
})

describe('agents and jobs: a row is all-in', () => {
  test('the roster lookup keeps listUsd and gains spawnUsd and allInUsd; the model is the main thread\'s', async () => {
    const { db } = await seed()
    const row = indexedLookup(db)('sess-9')
    expect(row).toMatchObject({ listUsd: MAIN3, spawnUsd: SUBS, allInUsd: ALL })
    // A model only the subagents ran is no part of the conversation's mix.
    expect(row?.models).toEqual([{ model: OPUS, requests: 3 }])
  })

  test('a job sums the three over its sessions', async () => {
    const { db } = await seed()
    const job = listJobs(db, { all: true, limit: 10 }).find((j) => j.key === 'sess-9')!
    expect(job).toMatchObject({ listUsd: MAIN3, spawnUsd: SUBS, allInUsd: ALL })
    expect(job.models).toEqual([{ model: OPUS, requests: 3 }])
  })
})

describe('trace: the session total is all-in, the turns are not', () => {
  test('totals gain spawnUsd and allInUsd; listUsd and the per-turn fees stay the main thread', async () => {
    const { db } = await seed()
    const t = getTrace(db, 'sess-9', { limit: 10 })
    expect(t.totals).toMatchObject({ listUsd: MAIN3, spawnUsd: SUBS, allInUsd: ALL })
    expect(r2(t.transactions.reduce((n, x) => n + (x.listUsd ?? 0), 0) + t.unplaced.reduce((n, s) => n + (s.listUsd ?? 0), 0))).toBe(MAIN3)
  })
})

const Totals = z.object({ listUsd: z.number().nullable(), spawnUsd: z.number().nullable(), allInUsd: z.number().nullable() })

describe('the explorer reads allInUsd', () => {
  test('/usage?json=1 totals equal `usage`\'s all-in total for the same window', async () => {
    const { db } = await seed()
    const app = createApp(() => db, { wikiDir: '/nonexistent', agents: async () => [] })
    const page = z
      .object({ models: z.object({ totals: Totals }), wells: z.object({ totals: Totals }), buckets: z.object({ totals: Totals }) })
      .parse(await (await app.request('/usage?since=2026-11-13&until=2026-11-14&json=1')).json())
    // The page's `until` is inclusive; the verb's is exclusive.
    const verb = listUsage(db, { by: 'model', since: '2026-11-13', until: '2026-11-15', limit: 50, subagents: true }).totals
    expect(verb.allInUsd).toBe(r2((verb.listUsd ?? 0) + (verb.spawnUsd ?? 0)))
    expect(page.models.totals.allInUsd).toBe(verb.allInUsd!)
    expect(page.wells.totals.allInUsd).toBe(verb.allInUsd!)
    expect(page.buckets.totals.allInUsd).toBe(verb.allInUsd!)
    const html = await (await app.request('/usage?since=2026-11-13&until=2026-11-14')).text()
    expect(html).toContain(`main $${MAIN3.toFixed(2)} · subagents $${SUBS.toFixed(2)}`)
  })

  test('the home page\'s week and today are the verb\'s all-in totals for the same instants', async () => {
    const { db } = await seed()
    const app = createApp(() => db, { wikiDir: '/nonexistent', agents: async () => [] })
    const home = z.object({ today: Totals, week: Totals }).parse(await (await app.request('/?json=1')).json())
    expect(home.week.allInUsd).toBe(listUsage(db, { by: 'well', since: lastDays(7), limit: 40, subagents: true }).totals.allInUsd!)
    expect(home.today.allInUsd).toBe(listUsage(db, { by: 'day', since: todayLocal(), limit: 2, subagents: true }).totals.allInUsd!)
  })

  test('the job, well and session pages: every total is all-in with the split stated', async () => {
    const { db } = await seed()
    const app = createApp(() => db, { wikiDir: '/nonexistent', agents: async () => [] })
    const job = z
      .object({ job: Totals, sessions: z.array(z.object({ usage: Totals.nullable() })) })
      .parse(await (await app.request('/job/sess-9?json=1')).json())
    expect(job.job.allInUsd).toBe(ALL)
    expect(job.sessions[0]!.usage?.allInUsd).toBe(ALL)
    const well = z.object({ totals: Totals }).parse(await (await app.request(`/well/${WELL}?json=1`)).json())
    expect(well.totals.allInUsd).toBe(ALL)
    const session = z.object({ totals: Totals }).parse(await (await app.request('/session/sess-9?json=1')).json())
    expect(session.totals.allInUsd).toBe(ALL)
    const split = `main $${MAIN3.toFixed(2)} · subagents $${SUBS.toFixed(2)}`
    for (const p of ['/job/sess-9', `/well/${WELL}`, '/session/sess-9']) expect(await (await app.request(p)).text()).toContain(split)
    expect(await (await app.request('/session/sess-9')).text()).toContain('subagent requests are not placed in turns')
  })
})
