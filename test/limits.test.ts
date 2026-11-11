import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { readLimits } from '../src/limits'
import { parseLine } from '../src/parse'

// Verbatim shape of the refusal record an attrition lane wrote on
// 2026-10-20 12:44Z: a `<synthetic>` assistant message (no request behind it)
// with the window in `apiErrorParams.rate_limit_info`, `resetsAt` in unix
// seconds (1792839600 = 2026-10-24T11:00:00Z, Saturday 06:00 Panama).
function refusalLine(ts: string, rateLimitType = 'seven_day', resetsAt = 1792839600): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      id: 'synthetic-1',
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: "You've hit your weekly limit · resets Oct 24 at 6am (America/Panama)" }],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    requestId: 'req_x',
    apiError: 'usage_limit_reached',
    apiErrorParams: {
      rate_limit_info: { status: 'rejected', resetsAt, rateLimitType, overageStatus: 'rejected', isUsingOverage: false },
    },
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
  })
}

function requestLine(ts: string, id: string, cacheRead: number, output: number, model = 'claude-opus-5-5'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      id,
      model,
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: output },
    },
  })
}

describe('parseLine: a 429', () => {
  test('yields the window and its reset as an instant, and no request', () => {
    const p = parseLine(refusalLine('2026-10-20T12:44:13.996Z'))!
    expect(p.limit).toEqual({ kind: 'seven_day', resetsAt: '2026-10-24T11:00:00.000Z' })
    expect(p.request).toBeUndefined()
    // The refusal text still indexes (the text lane), as before.
    expect(p.entries.map((e) => e.lane)).toEqual(['text'])
  })
})

describe('limits: the table and the verb', () => {
  function seed(): { db: ReturnType<typeof openDb>; limitsPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'lore-limits-'))
    const projects = join(dir, 'projects')
    const well = join(projects, '-u-code-fun-app')
    mkdirSync(well, { recursive: true })
    // Three priced requests inside the week, then the refusal.
    writeFileSync(
      join(well, 'sess-1.jsonl'),
      [
        requestLine('2026-10-18T10:00:00Z', 'm1', 1_000_000, 10_000),
        requestLine('2026-10-19T10:00:00Z', 'm2', 1_000_000, 10_000),
        requestLine('2026-10-20T10:00:00Z', 'm3', 1_000_000, 10_000),
        refusalLine('2026-10-20T12:44:13.996Z'),
      ].join('\n'),
    )
    // The mod's log: two readings of the same window, 20 → 60, then a
    // five-hour reading, then a torn tail.
    const limitsPath = join(dir, 'limits.jsonl')
    writeFileSync(
      limitsPath,
      [
        '{"ts":"2026-10-18T12:00:00.000Z","session":"sess-1","kind":"seven_day","pct":20,"resetsAt":"2026-10-24T11:00:00.000Z"}',
        '{"ts":"2026-10-20T11:00:00.000Z","session":"sess-1","kind":"seven_day","pct":60,"resetsAt":"2026-10-24T11:00:00.000Z"}',
        '{"ts":"2026-10-20T11:00:00.000Z","session":"sess-1","kind":"five_hour","pct":3,"resetsAt":"2026-10-20T15:00:00.000Z"}',
        '{"ts":"2026-10-20T11:30',
      ].join('\n'),
    )
    const db = openDb(join(dir, 'lore.db'))
    return { db, limitsPath }
  }

  test('index: the 429 lands at 100 from the transcript, the mod lines from the log; a re-run does not duplicate', async () => {
    const { db, limitsPath } = seed()
    const projectsDir = join(limitsPath, '..', 'projects')
    const historyPath = join(limitsPath, '..', 'none.jsonl')
    const first = await buildIndex(db, { projectsDir, historyPath, limitsPath })
    expect(first.limitRows).toBe(4)
    const again = await buildIndex(db, { projectsDir, historyPath, limitsPath, full: true })
    expect(again.limitRows).toBe(4)
    const rows = db.prepare('SELECT source, kind, pct, resets_at FROM limits ORDER BY ts').all()
    expect(rows).toEqual([
      { source: 'mod', kind: 'seven_day', pct: 20, resets_at: '2026-10-24T11:00:00.000Z' },
      { source: 'mod', kind: 'seven_day', pct: 60, resets_at: '2026-10-24T11:00:00.000Z' },
      { source: 'mod', kind: 'five_hour', pct: 3, resets_at: '2026-10-20T15:00:00.000Z' },
      { source: 'transcript', kind: 'seven_day', pct: 100, resets_at: '2026-10-24T11:00:00.000Z' },
    ])
  })

  test('the verb: the window is anchored on resetsAt, usage is the ledger up to the reading, implied scales it', async () => {
    const { db, limitsPath } = seed()
    await buildIndex(db, { projectsDir: join(limitsPath, '..', 'projects'), historyPath: join(limitsPath, '..', 'none.jsonl'), limitsPath })
    const r = readLimits(db, { limit: 10 })
    expect(r.count).toBe(4)
    expect(r.windows.map((w) => w.kind)).toEqual(['seven_day', 'five_hour'])
    const week = r.windows[0]!
    // The latest reading of the week is the 429: 100, from the transcript.
    expect(week).toMatchObject({ pct: 100, source: 'transcript', from: '2026-10-17T11:00:00.000Z', until: '2026-10-24T11:00:00.000Z' })
    // All three requests sit inside [from, ts of the reading].
    expect(week.usage).toMatchObject({ requests: 3, cacheRead: 3_000_000, output: 30_000 })
    expect(week.implied).toEqual(week.usage)
    // Between the 20 and the 60 readings the ledger priced m2 and m3 (m1 is
    // before the first reading): that spend over 40 points.
    expect(week.usdPerPoint).not.toBeNull()
    expect(week.usdPerPoint!).toBeCloseTo((week.usage!.listUsd * (2 / 3)) / 40, 2)
    // Readings under 5% imply nothing: too noisy to scale.
    const five = r.windows[1]!
    expect(five).toMatchObject({ pct: 3, from: '2026-10-20T10:00:00.000Z', until: '2026-10-20T15:00:00.000Z' })
    expect(five.implied).toBeNull()
    expect(r.hits.map((h) => h.pct)).toEqual([100])
    expect(r.history.map((h) => h.pct)).toEqual([60, 3, 20])
  })

  test('a kind filter and an empty table are both answered plainly', async () => {
    const { db, limitsPath } = seed()
    expect(readLimits(db, { limit: 10 })).toMatchObject({ windows: [], hits: [], history: [], count: 0 })
    await buildIndex(db, { projectsDir: join(limitsPath, '..', 'projects'), historyPath: join(limitsPath, '..', 'none.jsonl'), limitsPath })
    const r = readLimits(db, { kind: 'five_hour', limit: 10 })
    expect(r.windows.map((w) => w.kind)).toEqual(['five_hour'])
    expect(r.count).toBe(1)
  })
})

// Fable has its own weekly allowance, and the two sources name its window
// differently: the mod by its model (`seven_day_fable`), the harness's 429 by
// its billing rule (`seven_day_overage_included`). 1794654000 =
// 2026-11-14T11:00:00Z.
describe('limits: a week scoped to one model', () => {
  async function seed(): Promise<ReturnType<typeof openDb>> {
    const dir = mkdtempSync(join(tmpdir(), 'lore-limits-scoped-'))
    const well = join(dir, 'projects', '-u-code-fun-app')
    mkdirSync(well, { recursive: true })
    // Inside the week: two Fable requests and two Opus ones, then Fable's wall.
    writeFileSync(
      join(well, 'sess-2.jsonl'),
      [
        requestLine('2026-11-08T10:00:00Z', 'f1', 2_000_000, 20_000, 'claude-fable-5-2'),
        requestLine('2026-11-08T11:00:00Z', 'o1', 5_000_000, 50_000),
        requestLine('2026-11-10T10:00:00Z', 'f2', 2_000_000, 20_000, 'claude-fable-5-2'),
        requestLine('2026-11-10T11:00:00Z', 'o2', 5_000_000, 50_000),
        refusalLine('2026-11-11T18:00:00.000Z', 'seven_day_overage_included', 1794654000),
      ].join('\n'),
    )
    const limitsPath = join(dir, 'limits.jsonl')
    writeFileSync(
      limitsPath,
      [
        '{"ts":"2026-11-08T12:00:00.000Z","session":"sess-2","kind":"seven_day","pct":30,"resetsAt":"2026-11-14T11:00:00.000Z"}',
        '{"ts":"2026-11-08T12:00:00.000Z","session":"sess-2","kind":"seven_day_fable","pct":40,"resetsAt":"2026-11-14T11:00:00.000Z"}',
        '{"ts":"2026-11-11T12:00:00.000Z","session":"sess-2","kind":"seven_day","pct":85,"resetsAt":"2026-11-14T11:00:00.000Z"}',
        '{"ts":"2026-11-11T12:00:00.000Z","session":"sess-2","kind":"seven_day_fable","pct":94,"resetsAt":"2026-11-14T11:00:00.000Z"}',
        '{"ts":"2026-11-11T12:00:00.000Z","session":"sess-2","kind":"seven_day_cowork","pct":7,"resetsAt":"2026-11-14T11:00:00.000Z"}',
      ].join('\n'),
    )
    const db = openDb(join(dir, 'lore.db'))
    await buildIndex(db, { projectsDir: join(dir, 'projects'), historyPath: join(dir, 'none.jsonl'), limitsPath })
    return db
  }

  test('it is a seven-day window whose ledger is that model alone, beside the all-models week', async () => {
    const r = readLimits(await seed(), { limit: 10 })
    expect(r.windows.map((w) => w.kind)).toEqual(['seven_day', 'seven_day_cowork', 'seven_day_fable'])
    const [week, cowork, fable] = r.windows
    expect(week).toMatchObject({ pct: 85, model: null, from: '2026-11-07T11:00:00.000Z', until: '2026-11-14T11:00:00.000Z' })
    expect(week!.usage).toMatchObject({ requests: 4, cacheRead: 14_000_000, output: 140_000 })
    // The latest reading of Fable's week is its 429, under the harness's name.
    expect(fable).toMatchObject({ pct: 100, source: 'transcript', model: 'fable', from: '2026-11-07T11:00:00.000Z', until: '2026-11-14T11:00:00.000Z' })
    expect(fable!.usage).toMatchObject({ requests: 2, cacheRead: 4_000_000, output: 40_000 })
    expect(fable!.implied).toEqual(fable!.usage)
    // Between the 40 and the 94 readings only f2 is Fable's: o2 is not counted.
    const perPoint = fable!.usdPerPoint!
    expect(perPoint).toBeGreaterThan(0)
    expect(week!.usdPerPoint!).toBeGreaterThan(perPoint)
    // A week scoped to a surface is a window with no ledger: nothing in a
    // request says which surface made it.
    expect(cowork).toMatchObject({ pct: 7, model: null, from: '2026-11-07T11:00:00.000Z', usage: null, implied: null, usdPerPoint: null })
  })

  test('the 429 is listed under the window it refused, and either spelling filters to it', async () => {
    const db = await seed()
    const r = readLimits(db, { limit: 10 })
    expect(r.hits.map((h) => [h.kind, h.pct])).toEqual([['seven_day_fable', 100]])
    // The table keeps what the harness said.
    expect(db.prepare("SELECT kind FROM limits WHERE source = 'transcript'").all()).toEqual([{ kind: 'seven_day_overage_included' }])
    for (const kind of ['seven_day_fable', 'seven_day_overage_included']) {
      const one = readLimits(db, { kind, limit: 10 })
      expect(one.windows.map((w) => w.kind)).toEqual(['seven_day_fable'])
      expect(one.count).toBe(3)
    }
    expect(readLimits(db, { kind: 'seven_day', limit: 10 }).count).toBe(2)
  })
})
