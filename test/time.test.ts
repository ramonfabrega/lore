import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { day, dayStart, hm, hms, todayLocal, zone } from '../src/fmt'

// The rule (config.ts): an instant is UTC in the data, a DAY is local at the
// display edge. Everything here pins its zone explicitly — a test that reads
// the machine's would pass in Panama and fail in CI, which is how the old
// hardcoded day strings behaved before this file existed.

const PA = 'America/Panama' // UTC-5, no DST
const NY = 'America/New_York' // UTC-5 / UTC-4
const IN = 'Asia/Kolkata' // UTC+5:30 — the half-hour case

describe('the display edge', () => {
  // 02:30Z is 9:30pm the PREVIOUS day in Panama: the case that makes the
  // whole change worth making, since the UTC boundary lands at 7pm local and
  // cuts the most active hours of the day in half.
  const EVENING = '2026-09-03T02:30:00.000Z'

  test('a day is the local calendar day an instant fell on', () => {
    expect(day(EVENING, PA)).toBe('2026-09-02')
    expect(day(EVENING, 'UTC')).toBe('2026-09-03')
    expect(day(EVENING, IN)).toBe('2026-09-03')
  })

  test('a clock is the local wall clock, h23 so midnight is 00:00', () => {
    expect(hms(EVENING, PA)).toBe('21:30:00')
    expect(hm(EVENING, PA)).toBe('21:30')
    expect(hms('2026-09-03T05:00:00.000Z', PA)).toBe('00:00:00')
    expect(hm(EVENING, IN)).toBe('08:00') // +5:30
  })

  test('absent and unparseable timestamps render as nothing, never as a throw', () => {
    for (const f of [day, hms, hm]) {
      expect(f(null, PA)).toBe('')
      expect(f('not-a-date', PA)).toBe('')
    }
  })

  test('zone is what the header prints where it used to hardcode UTC', () => {
    expect(zone('UTC')).toBe('UTC')
    expect(zone(PA)).toBe('EST')
  })

  test('todayLocal agrees with day() on now', () => {
    expect(todayLocal(PA)).toBe(day(new Date().toISOString(), PA))
  })
})

describe('dayStart — a window written in local days, compared against UTC instants', () => {
  test('local midnight, as the UTC instant it actually is', () => {
    expect(dayStart('2026-09-02', PA)).toBe('2026-09-02T05:00:00.000Z')
    expect(dayStart('2026-09-02', 'UTC')).toBe('2026-09-02T00:00:00.000Z')
    expect(dayStart('2026-09-02', IN)).toBe('2026-09-01T18:30:00.000Z')
  })

  // The two-pass offset resolution: the offset at local midnight is not
  // always the offset at the UTC instant of the same clock reading.
  test('follows DST rather than a fixed offset', () => {
    expect(dayStart('2026-07-08', NY)).toBe('2026-07-08T04:00:00.000Z') // EDT
    expect(dayStart('2026-12-08', NY)).toBe('2026-12-08T05:00:00.000Z') // EST
  })

  test('a full timestamp is already an instant and passes through', () => {
    expect(dayStart('2026-09-02T13:45:00.000Z', PA)).toBe('2026-09-02T13:45:00.000Z')
  })

  test('a window boundary is the start of the day it names', () => {
    // Everything on 2026-09-02 local is inside [dayStart(02), dayStart(03)).
    const from = dayStart('2026-09-02', PA)
    const to = dayStart('2026-09-03', PA)
    const evening = '2026-09-03T02:30:00.000Z' // 9:30pm on the 2nd, locally
    expect(evening >= from && evening < to).toBe(true)
    expect(day(evening, PA)).toBe('2026-09-02')
  })
})

// The half-migration hazard, held by a test: SQLite buckets with `localtime`
// (the process zone) while the pages render with Intl. If those two ever
// disagree, a row's date and the bucket it was counted in disagree, and the
// page contradicts itself. This runs in whatever zone the suite runs in —
// that is the point.
test('SQL day buckets and the rendered day agree, in whatever zone the process runs', () => {
  // `bun test` sets the JS zone to UTC for reproducibility and cannot move
  // SQLite's, which the C library already cached from the OS — so an UNPINNED
  // run has the two halves genuinely disagreeing and this assertion would be
  // measuring the runner, not the code. CI and the install gate pass TZ in the
  // environment; a deployed process takes the OS zone for both and agrees.
  expect(process.env.TZ, 'pin the zone: `TZ=UTC bun test` (see CLAUDE.md)').toBeTruthy()
  const db = new Database(':memory:')
  const bucket = (ts: string, expr: string) => db.prepare(`SELECT ${expr} AS v`).get(ts) as { v: string }
  for (const ts of ['2026-09-03T02:30:00.000Z', '2026-09-01T23:59:59.000Z', '2026-01-15T12:00:00.000Z', '2026-07-04T00:00:00.000Z']) {
    expect(bucket(ts, "date(?, 'localtime')").v).toBe(day(ts))
    expect(bucket(ts, "strftime('%Y-%m', ?, 'localtime')").v).toBe(day(ts).slice(0, 7))
  }
})
