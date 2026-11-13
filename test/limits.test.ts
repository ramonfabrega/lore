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

// `lore limits` reads the windows that are OPEN at `now`; the fixtures are
// dated, so each suite says when it is being read.
const OCT = '2026-10-20T13:00:00.000Z'
const NOV = '2026-11-13T22:00:00.000Z'

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
    const r = readLimits(db, { limit: 10, now: OCT })
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
    expect(readLimits(db, { limit: 10, now: OCT })).toMatchObject({ windows: [], hits: [], history: [], count: 0 })
    await buildIndex(db, { projectsDir: join(limitsPath, '..', 'projects'), historyPath: join(limitsPath, '..', 'none.jsonl'), limitsPath })
    const r = readLimits(db, { kind: 'five_hour', limit: 10, now: OCT })
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
    const r = readLimits(await seed(), { limit: 10, now: NOV })
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
    const r = readLimits(db, { limit: 10, now: NOV })
    // Under lore's name for the window, with the harness's own word beside it.
    expect(r.hits.map((h) => [h.kind, h.pct, h.rateLimitType])).toEqual([['seven_day_fable', 100, 'seven_day_overage_included']])
    // The table keeps what the harness said.
    expect(db.prepare("SELECT kind FROM limits WHERE source = 'transcript'").all()).toEqual([{ kind: 'seven_day_overage_included' }])
    for (const kind of ['seven_day_fable', 'seven_day_overage_included']) {
      const one = readLimits(db, { kind, limit: 10, now: NOV })
      expect(one.windows.map((w) => w.kind)).toEqual(['seven_day_fable'])
      expect(one.count).toBe(3)
    }
    expect(readLimits(db, { kind: 'seven_day', limit: 10, now: NOV }).count).toBe(2)
  })
})

// 2026-11-12: the week was reset on demand, three days before its boundary.
// The all-models week read 100, refused a request, and read 0 a minute
// later; Fable's read 98 and, 75 minutes after the reset, 2 — both still
// resetting 11-14 11:00Z. The percent counts from the reset; the ledger
// counted from the window's start, and a week's spend over a day's percent
// read 57 USD a point against 15 to 22 measured.
describe('limits: a window reset on demand', () => {
  async function seed(extra: string[] = []): Promise<ReturnType<typeof openDb>> {
    const dir = mkdtempSync(join(tmpdir(), 'lore-limits-reset-'))
    const well = join(dir, 'projects', '-u-code-fun-app')
    mkdirSync(well, { recursive: true })
    writeFileSync(
      join(well, 'sess-3.jsonl'),
      [
        // Before the reset: four days of the week, on both models.
        requestLine('2026-11-08T10:00:00Z', 'a1', 900_000_000, 9_000_000, 'claude-fable-5-2'),
        requestLine('2026-11-10T10:00:00Z', 'a2', 900_000_000, 9_000_000),
        requestLine('2026-11-11T10:00:00Z', 'a3', 900_000_000, 9_000_000, 'claude-fable-5-2'),
        refusalLine('2026-11-12T04:11:16.671Z', 'seven_day', 1794654000),
        // After it: one Opus request, then two Fable ones either side of
        // Fable's first reading.
        requestLine('2026-11-12T05:00:00Z', 'b1', 100_000_000, 1_000_000),
        requestLine('2026-11-12T05:10:00Z', 'b2', 100_000_000, 1_000_000, 'claude-fable-5-2'),
        requestLine('2026-11-12T12:00:00Z', 'b3', 200_000_000, 2_000_000, 'claude-fable-5-2'),
        requestLine('2026-11-13T10:00:00Z', 'b4', 300_000_000, 3_000_000),
      ].join('\n'),
    )
    const at = (ts: string, kind: string, pct: number) => JSON.stringify({ ts, session: 'sess-3', kind, pct, resetsAt: '2026-11-14T11:00:00.000Z' })
    const limitsPath = join(dir, 'limits.jsonl')
    writeFileSync(
      limitsPath,
      [
        at('2026-11-08T12:00:00.000Z', 'seven_day', 30),
        at('2026-11-12T02:46:30.000Z', 'seven_day_fable', 98),
        at('2026-11-12T03:56:00.000Z', 'seven_day', 100),
        at('2026-11-12T04:12:00.000Z', 'seven_day', 0),
        at('2026-11-12T05:27:00.000Z', 'seven_day', 1),
        at('2026-11-12T05:27:00.000Z', 'seven_day_fable', 2),
        at('2026-11-13T21:00:00.000Z', 'seven_day', 40),
        at('2026-11-13T21:00:00.000Z', 'seven_day_fable', 36),
        ...extra,
      ].join('\n'),
    )
    const db = openDb(join(dir, 'lore.db'))
    await buildIndex(db, { projectsDir: join(dir, 'projects'), historyPath: join(dir, 'none.jsonl'), limitsPath })
    return db
  }

  test('the drop is the reset: the row says so and the ledger restarts at the first reading after it', async () => {
    const r = readLimits(await seed(), { limit: 20, now: NOV })
    const week = r.windows.find((w) => w.kind === 'seven_day')!
    // The window itself has not moved; the 429 is the reading before the drop.
    expect(week).toMatchObject({ pct: 40, from: '2026-11-07T11:00:00.000Z', until: '2026-11-14T11:00:00.000Z' })
    expect(week.reset).toEqual({ at: '2026-11-12T04:12:00.000Z', pct: 0, was: 100, wasAt: '2026-11-12T04:11:16.671Z' })
    // Only what was spent since: b1..b4, not the three requests of the first four days.
    expect(week.usage).toMatchObject({ requests: 4, cacheRead: 700_000_000, output: 7_000_000 })
    // 40 points since the reset: the week is that ledger × 100/40.
    expect(week.implied).toMatchObject({ requests: 10, cacheRead: 1_750_000_000, output: 17_500_000 })
    // Between the readings at 0 and at 40, the same four requests over 40 points.
    expect(week.usdPerPoint!).toBeCloseTo(week.usage!.listUsd / 40, 1)
    // The hit says which window its 429 named, in the harness's word.
    expect(r.hits.map((h) => [h.kind, h.rateLimitType])).toEqual([['seven_day', 'seven_day']])
  })

  test('a scoped week whose first reading after the reset is not 0 is scaled by the points gained since', async () => {
    const fable = readLimits(await seed(), { limit: 20, now: NOV }).windows.find((w) => w.kind === 'seven_day_fable')!
    expect(fable).toMatchObject({ pct: 36, model: 'fable' })
    expect(fable.reset).toEqual({ at: '2026-11-12T05:27:00.000Z', pct: 2, was: 98, wasAt: '2026-11-12T02:46:30.000Z' })
    // Fable's requests since ITS first reading: b3 alone. b2 fell between the
    // reset and that reading — it is inside the 2 points, not the 34.
    expect(fable.usage).toMatchObject({ requests: 1, cacheRead: 200_000_000, output: 2_000_000 })
    expect(fable.implied).toMatchObject({ cacheRead: Math.round((200_000_000 * 100) / 34), output: Math.round((2_000_000 * 100) / 34) })
    expect(fable.usdPerPoint!).toBeCloseTo(fable.usage!.listUsd / 34, 1)
  })

  test('a window that only climbs has no reset, and a one-point wobble is not one', async () => {
    const at = (ts: string, pct: number) => JSON.stringify({ ts, session: 'sess-4', kind: 'seven_day', pct, resetsAt: '2026-11-14T11:00:00.000Z' })
    // A second session's status line, a point behind, logged after the first's.
    const r = readLimits(await seed([at('2026-11-13T21:00:05.000Z', 39), at('2026-11-13T21:30:00.000Z', 41)]), { limit: 20, now: NOV })
    const week = r.windows.find((w) => w.kind === 'seven_day')!
    expect(week.pct).toBe(41)
    expect(week.reset).toMatchObject({ at: '2026-11-12T04:12:00.000Z' })
    // And the windows of the other suites, which never dropped, carry none.
    const plain = openDb(':memory:')
    plain.prepare("INSERT INTO limits(ts, session_id, kind, pct, resets_at, source) VALUES ('2026-11-08T12:00:00.000Z','s','seven_day',30,'2026-11-14T11:00:00.000Z','mod'), ('2026-11-09T12:00:00.000Z','s','seven_day',29,'2026-11-14T11:00:00.000Z','mod'), ('2026-11-10T12:00:00.000Z','s','seven_day',50,'2026-11-14T11:00:00.000Z','mod')").run()
    expect(readLimits(plain, { limit: 10, now: NOV }).windows[0]).toMatchObject({ pct: 50, reset: null })
  })

  // The plan dropped the five-hour window around 2026-10-30. Its last
  // reading — 0%, resetting that evening — stood in `windows` for two weeks.
  test('a window whose last reading names a boundary already past is ended, not open', async () => {
    const db = await seed([JSON.stringify({ ts: '2026-10-30T17:56:54.016Z', session: 'sess-0', kind: 'five_hour', pct: 0, resetsAt: '2026-10-30T22:50:00.000Z' })])
    const r = readLimits(db, { limit: 20, now: NOV })
    expect(r.windows.map((w) => w.kind)).toEqual(['seven_day', 'seven_day_fable'])
    expect(r.ended).toEqual([{ kind: 'five_hour', pct: 0, ts: '2026-10-30T17:56:54.016Z', resetsAt: '2026-10-30T22:50:00.000Z' }])
    // It is still a reading: the history keeps it, and a filter still finds it.
    expect(readLimits(db, { kind: 'five_hour', limit: 20, now: NOV })).toMatchObject({ windows: [], count: 1 })
    // The week itself ends the same way the moment its boundary passes, until
    // the next week's first reading arrives.
    const after = readLimits(db, { limit: 20, now: '2026-11-14T11:00:00.000Z' })
    expect(after.windows).toEqual([])
    expect(after.ended.map((e) => [e.kind, e.pct])).toEqual([
      ['seven_day', 40],
      ['seven_day_fable', 36],
      ['five_hour', 0],
    ])
  })

  test('a reading that names LAST week, logged after this week began, opens nothing and resets nothing', async () => {
    const db = openDb(':memory:')
    db.prepare(
      "INSERT INTO limits(ts, session_id, kind, pct, resets_at, source) VALUES ('2026-11-07T11:00:05.000Z','old','seven_day',97,'2026-11-07T11:00:00.000Z','mod'), ('2026-11-07T12:00:00.000Z','s','seven_day',1,'2026-11-14T11:00:00.000Z','mod'), ('2026-11-09T12:00:00.000Z','s','seven_day',20,'2026-11-14T11:00:00.000Z','mod')",
    ).run()
    expect(readLimits(db, { limit: 10, now: NOV }).windows[0]).toMatchObject({ pct: 20, reset: null, from: '2026-11-07T11:00:00.000Z' })
  })
})
