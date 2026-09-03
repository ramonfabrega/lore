import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { day, dayName, dayStart, hm, hms, stamp, todayLocal, volatile, when, whenForms, whenShort, zone } from '../src/fmt'
import { tick } from '../src/style'

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
    expect(zone(null, 'UTC')).toBe('UTC')
    expect(zone(null, PA)).toBe('EST')
  })

  // The zone belongs to the INSTANT, not to the reading. A July session read
  // in January printed "EST" over a clock recorded in EDT: the time was
  // localized and its own label was not.
  test('zone follows the instant through DST, not the moment of reading', () => {
    expect(zone('2026-07-08T16:00:00.000Z', NY)).toBe('EDT')
    expect(zone('2026-01-08T16:00:00.000Z', NY)).toBe('EST')
    expect(zone('2026-07-08T16:00:00.000Z', PA)).toBe('EST') // Panama never moves
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

describe('the ladder', () => {
  // Every case is written against a FIXED `now`, so these read as a table
  // rather than as arithmetic, and none of them drift with the wall clock.
  const NOW = Date.parse('2026-09-02T22:00:00.000Z') // 17:00 in Panama
  const w = (ts: string) => when(ts, PA, NOW)
  const s = (ts: string) => whenShort(ts, PA, NOW)

  test('the duration head lives for one hour, then the calendar takes over', () => {
    expect(w('2026-09-02T21:59:30.000Z')).toBe('now') // 30s
    expect(w('2026-09-02T21:59:00.000Z')).toBe('1m ago')
    expect(w('2026-09-02T21:48:00.000Z')).toBe('12m ago')
    expect(w('2026-09-02T21:01:00.000Z')).toBe('59m ago')
    expect(w('2026-09-02T20:59:00.000Z')).toBe('15:59') // over the hour: a clock
  })

  test('resolution grows with distance, and the year appears only when it is not this one', () => {
    expect(w('2026-09-02T12:00:00.000Z')).toBe('07:00') // today
    expect(w('2026-09-01T22:45:00.000Z')).toBe('yest 17:45')
    expect(w('2026-08-19T22:45:00.000Z')).toBe('19 aug 17:45')
    expect(w('2025-08-19T22:45:00.000Z')).toBe('19 aug 25 17:45')
  })

  // The column form drops what the tooltip carries, and nothing else. Nine
  // characters is the widest it gets.
  test('the short form holds a grid column', () => {
    expect(s('2026-09-02T21:48:00.000Z')).toBe('12m ago') // "ago" survives: `ms()` renders durations on these same rows
    expect(s('2026-09-02T12:00:00.000Z')).toBe('07:00')
    expect(s('2026-09-01T22:45:00.000Z')).toBe('yest')
    expect(s('2026-08-19T22:45:00.000Z')).toBe('19 aug')
    expect(s('2025-08-19T22:45:00.000Z')).toBe('19 aug 25')
    for (const ts of ['2026-09-02T21:48:00.000Z', '2026-09-01T22:45:00.000Z', '2025-08-19T22:45:00.000Z']) {
      expect(s(ts).length).toBeLessThanOrEqual(9)
    }
  })

  // The most-cited failure of relative labels is a "yesterday" that means
  // "less than 24 hours". It is a CALENDAR day here: 00:05 today is not
  // yesterday, and 23:55 yesterday is, though they are twenty minutes apart.
  test('yesterday is the previous calendar day, not the previous 24 hours', () => {
    // Ninety minutes earlier, and already "yesterday": the calendar turned.
    const justPastMidnight = Date.parse('2026-09-03T06:30:00.000Z') // 01:30 in Panama
    expect(when('2026-09-03T04:55:00.000Z', PA, justPastMidnight)).toBe('yest 23:55')
    // Twenty-two hours earlier, and still today: the calendar did not.
    const evening = Date.parse('2026-09-03T04:00:00.000Z') // 23:00 in Panama
    expect(when('2026-09-02T06:00:00.000Z', PA, evening)).toBe('01:00')
  })

  // Spring forward: subtracting 86400000ms from an instant to find "yesterday"
  // lands two calendar days back at exactly this hour. The ladder shifts the
  // local DATE instead, so DST never reaches it.
  test('survives the spring-forward hour, where clock arithmetic does not', () => {
    const after = Date.parse('2026-03-09T04:30:00.000Z') // 00:30 EDT, the day after the change
    expect(new Date(after - 86_400_000).toLocaleDateString('en-CA', { timeZone: NY })).toBe('2026-03-07') // the trap
    expect(when('2026-03-08T18:00:00.000Z', NY, after)).toBe('yest 14:00') // 8 March IS yesterday
    expect(when('2026-03-07T18:00:00.000Z', NY, after)).toBe('7 mar 13:00')
  })

  test('a future instant falls through to the calendar rather than counting down', () => {
    expect(w('2026-09-02T23:30:00.000Z')).toBe('18:30')
    expect(w('2026-09-03T23:30:00.000Z')).toBe('3 sep 18:30')
  })

  test('absent and unparseable render as nothing, as everywhere else', () => {
    for (const f of [when, whenShort, stamp]) {
      expect(f(null, PA)).toBe('')
      expect(f('not-a-date', PA)).toBe('')
    }
    expect(volatile(null)).toBe(false)
  })

  test('the tooltip carries everything the display dropped', () => {
    expect(stamp('2026-08-19T22:45:40.000Z', PA)).toBe('19 aug 26 17:45:40 EST')
    expect(stamp('2026-07-08T21:45:40.000Z', NY)).toBe('8 jul 26 17:45:40 EDT')
  })

  test('a day string reads as a person writes it, and only where it is not a key', () => {
    expect(dayName('2026-09-02')).toBe('2 sep 26')
    expect(dayName('2026-12-25')).toBe('25 dec 26')
    expect(dayName(null)).toBe('')
    expect(dayName('2026-W35')).toBe('2026-W35') // a bucket key passes through untouched
  })

  test('only a stamp that can still change ships its alternate forms', () => {
    expect(volatile('2026-09-02T12:00:00.000Z', NOW)).toBe(true)
    expect(volatile('2026-08-19T12:00:00.000Z', NOW)).toBe(false)
  })
})

// The ladder is written once, in TypeScript. What the browser gets is three
// pre-rendered texts plus a tick script that decides which one the calendar
// has reached — so the only logic that exists twice is the duration head, two
// thresholds, and these tests are what hold the two copies together.
describe('the tick script agrees with the server that rendered the page', () => {
  // A DOM the size of the script's actual appetite: querySelectorAll, dataset,
  // textContent. No jsdom, no browser — the script is fifteen lines and this
  // is all fifteen of them touch.
  function run(ts: string, renderedDay: string, short = true): string {
    const el = { dateTime: ts, dataset: { forms: whenForms(ts, TZ_NOW, Date.now(), short).join('|') }, textContent: '' }
    const doc = { querySelectorAll: () => [el] }
    new Function('document', 'setInterval', tick(TZ_NOW, renderedDay))(doc, () => 0)
    return el.textContent
  }
  // The suite's own zone: these run against the real clock (the script calls
  // Date.now() itself), and both halves must read the same one.
  const TZ_NOW = Intl.DateTimeFormat().resolvedOptions().timeZone
  const agoBy = (ms: number) => new Date(Date.now() - ms).toISOString()

  test('on the day it was rendered, the script reproduces the server text exactly', () => {
    for (const ms of [5_000, 60_000, 12 * 60_000, 59 * 60_000, 3 * 3_600_000, 30 * 3_600_000]) {
      const ts = agoBy(ms)
      expect(run(ts, todayLocal()), `${ms}ms ago`).toBe(whenShort(ts))
    }
  })

  test('the full form ticks the same way as the short one', () => {
    const ts = agoBy(12 * 60_000)
    expect(run(ts, todayLocal(), false)).toBe(when(ts))
  })

  // A page held open past midnight: the stamp that said "17:45" has to become
  // "yest", and the day after that, a date. The script walks the forms; it
  // never formats a date itself.
  test('a page left open walks forward through the forms', () => {
    const ts = agoBy(3 * 3_600_000)
    const forms = whenForms(ts)
    const dayShift = (n: number) => {
      const [y, m, d] = todayLocal().split('-').map(Number)
      return new Date(Date.UTC(y!, m! - 1, d!) - n * 86_400_000).toISOString().slice(0, 10)
    }
    expect(run(ts, dayShift(0))).toBe(forms[0])
    expect(run(ts, dayShift(1))).toBe(forms[1]) // rendered yesterday, read today
    expect(run(ts, dayShift(2))).toBe(forms[2])
    expect(run(ts, dayShift(9))).toBe(forms[2]) // the last form is stable forever
  })

  test('a stamp under the hour keeps counting without the server', () => {
    expect(run(agoBy(10_000), todayLocal())).toBe('now')
    expect(run(agoBy(8 * 60_000), todayLocal())).toBe('8m ago')
  })

  // The forms must not freeze the part of the ladder that moves. A stamp
  // rendered as "now" is a clock an hour later, on the same day, with nothing
  // arriving from the server in between — so form 0 is the CALENDAR text, and
  // the duration head is the script's alone.
  test('a stamp rendered inside the hour becomes a clock when it leaves it', () => {
    const ts = agoBy(5_000)
    expect(whenForms(ts)[0]).toBe(hm(ts))
    expect(whenForms(ts)[0]).not.toBe('now')
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
