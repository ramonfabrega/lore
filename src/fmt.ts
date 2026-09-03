// Number and text formatters shared by the pages (web.ts) and the block
// view (block.ts). Display only — the JSON surfaces carry raw numbers.
import { TZ } from './config'

export function tok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return String(n)
}

export function usd(n: number | null): string {
  return n == null ? '—' : `$${n.toFixed(2)}`
}

export function ms(n: number | null): string {
  if (n == null) return ''
  if (n < 1000) return `${n}ms`
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`
  if (n < 3_600_000) return `${Math.round(n / 60_000)}min`
  return `${(n / 3_600_000).toFixed(1)}h`
}

// Terminal color codes reach the transcript intact (`/model` echoes a bolded
// model name through local-command-stdout, git paints its own output). They
// render as nothing, or as garbage — strip them wherever text is shown.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
export function plain(s: string): string {
  return s.replace(ANSI, '')
}

// `cut` for prose that will be READ rather than scanned: paragraphs survive.
// A brief arrives with structure — a READ FIRST list, a WHAT V0 IS paragraph —
// and flattening it to one line, as `cut` does, turns four hundred words into
// a wall. Runs of blank lines collapse to one; spaces and tabs still collapse,
// so a wrapped line does not keep its accidental indentation.
export function cutProse(s: string, n: number): string {
  const t = plain(s)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export function cut(s: string, n: number): string {
  const one = plain(s).replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

// ---- clocks and calendars ------------------------------------------------
//
// An instant is UTC in the data (storage, ordering, `--since`, cursors); a
// DAY is local, and so is a wall clock (config.ts). These are the display
// edge and the only place the conversion happens — the same rule the
// envelope follows. `tz` is a parameter so a test can pin a zone instead of
// inheriting the machine's.
const CACHE = new Map<string, Intl.DateTimeFormat>()
// en-CA is the locale whose date format is already ISO ("2026-09-02"), and
// h23 keeps midnight at 00:00 rather than the 24:00 some hour cycles emit.
const SHAPE: Record<string, Intl.DateTimeFormatOptions> = {
  day: { year: 'numeric', month: '2-digit', day: '2-digit' },
  hms: { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' },
  hm: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  zone: { timeZoneName: 'short' },
  parts: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' },
}
function fmt(kind: keyof typeof SHAPE, tz: string): Intl.DateTimeFormat {
  const key = `${kind} ${tz}`
  let f = CACHE.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...SHAPE[kind] })
    CACHE.set(key, f)
  }
  return f
}
// A bad ISO string must not throw a page — it renders as nothing, the way an
// absent one does.
function at(ts: string | null): Date | null {
  if (!ts) return null
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d
}

// "2026-09-02" — the LOCAL calendar day an instant fell on.
export function day(ts: string | null, tz = TZ): string {
  const d = at(ts)
  return d ? fmt('day', tz).format(d) : ''
}
// "19:51:56" / "19:51" on the local wall clock.
export function hms(ts: string | null, tz = TZ): string {
  const d = at(ts)
  return d ? fmt('hms', tz).format(d) : ''
}
export function hm(ts: string | null, tz = TZ): string {
  const d = at(ts)
  return d ? fmt('hm', tz).format(d) : ''
}
// "EST" — the zone AT THAT INSTANT, which is not always today's. Reading a
// July session in January, `new Date()` here had the header print EST over a
// timestamp that was recorded in EDT: the clock was localized and its label
// was not, which is the half-migration in miniature.
export function zone(ts: string | null = null, tz = TZ): string {
  const part = fmt('zone', tz).formatToParts(at(ts) ?? new Date()).find((p) => p.type === 'timeZoneName')
  return part?.value ?? tz
}
// Today's local day, for "is this timestamp from today" comparisons. Callers
// must compare against `day()`, never against a sliced ISO string.
export function todayLocal(tz = TZ): string {
  return day(new Date().toISOString(), tz)
}

// How far the wall clock in `tz` runs from UTC at a given instant.
function offsetMs(t: number, tz: string): number {
  const p = Object.fromEntries(fmt('parts', tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
  return asUtc - t
}

// The UTC instant at which a LOCAL day begins — the bridge between a window
// a person writes ("since 2026-09-01") and the UTC instants it is compared
// against. Without it a window and the buckets inside it disagree by the
// offset, which is the half-migration that makes a page contradict itself.
// A value that is already a full timestamp is an instant, and passes through.
// Two passes because the offset at local midnight is not always the offset at
// the UTC instant of the same clock reading — the DST spring-forward case.
export function dayStart(d: string, tz = TZ): string {
  if (d.length > 10) return d
  const naive = Date.parse(`${d}T00:00:00Z`)
  if (Number.isNaN(naive)) return d
  let t = naive - offsetMs(naive, tz)
  t = naive - offsetMs(t, tz)
  return new Date(t).toISOString()
}

// ---- the ladder ----------------------------------------------------------
//
// One stamp shape, its resolution growing with distance. The industry hybrid
// (Cloudscape, Close, GitHub's <relative-time>) is relative-then-absolute
// with the absolute always in a tooltip; where lore diverges is the
// THRESHOLD. Those systems stay relative for 7 days (Atlassian, Close) or 30
// (GitHub's `P30D` default) because they render feeds, where "3 days ago" is
// the whole answer. lore renders archaeology: a column holds twenty rows from
// one afternoon, and "4d ago" twenty times destroys what "17:45 / 18:02 /
// 19:31" carries. So duration text lives for an hour and the calendar takes
// over after — which is also the shape the standing critique of relative
// labels argues for (relative under the hour, "yesterday" only for the real
// previous calendar day, absolute past that, a tooltip throughout).
//
//   < 45s        now              now
//   < 60m        12m ago          12m ago
//   today        17:45            17:45
//   yesterday    yest 17:45       yest
//   this year    2 sep 17:45      2 sep
//   older        2 sep 25 17:45   2 sep 25
//                ^ when()         ^ whenShort()
//
// `whenShort` is the grid column: the front page's "at" was 5 chars wide and
// a full stamp runs to 14, which is real width in a dense console. It drops
// only what the tooltip carries anyway, and holds the column at 9. The
// duration head keeps its "ago" in both — `ms()` renders durations as `12min`
// on the same rows, and a bare `12m` in a time column beside them is a
// genuine ambiguity for four saved characters.
//
// A future instant (clock skew) falls through to the calendar rather than
// counting down: lore has no future events, so `-3m ago` would be a bug
// rendered as a feature.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MIN = 60_000
const DAY_MS = 86_400_000

type Cal = { y: number; m: number; d: number }
type Wall = Cal & { hh: string; mm: string; ss: string }

function wall(d: Date, tz: string): Wall {
  const p = Object.fromEntries(fmt('parts', tz).formatToParts(d).map((x) => [x.type, x.value]))
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: p.hour!, mm: p.minute!, ss: p.second! }
}
// Calendar arithmetic, not clock arithmetic: "yesterday" is the previous
// CALENDAR day. The most-cited failure of relative labels is a "yesterday"
// that quietly means "less than 24 hours" — they pretend to speak human and
// then don't. Shifting a local date through Date.UTC keeps DST out of it;
// subtracting 86400000 from an instant does not, and lands two days back at
// the spring-forward hour.
function shift(c: Cal, days: number): Cal {
  const d = new Date(Date.UTC(c.y, c.m - 1, c.d) + days * DAY_MS)
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }
}
const sameDay = (a: Cal, b: Cal) => a.y === b.y && a.m === b.m && a.d === b.d

// `rel` off suppresses the duration head — how the alternate forms below are
// generated: the same ladder, asked what an instant reads as once it is no
// longer today.
function ladder(ts: string | null, tz: string, nowMs: number, nowCal: Cal, short: boolean, rel = true): string {
  const d = at(ts)
  if (!d) return ''
  const age = nowMs - d.getTime()
  if (rel && age >= 0) {
    if (age < 45_000) return 'now'
    if (age < 60 * MIN) return `${Math.max(1, Math.round(age / MIN))}m ago`
  }
  const t = wall(d, tz)
  const clock = `${t.hh}:${t.mm}`
  if (sameDay(t, nowCal)) return clock
  if (sameDay(t, shift(nowCal, -1))) return short ? 'yest' : `yest ${clock}`
  const dm = `${t.d} ${MONTHS[t.m - 1]}`
  const yy = t.y === nowCal.y ? '' : ` ${String(t.y % 100).padStart(2, '0')}`
  return short ? `${dm}${yy}` : `${dm}${yy} ${clock}`
}

// The listing stamp (`whenShort`) and the prose one (`when`).
export function when(ts: string | null, tz = TZ, now = Date.now()): string {
  return ladder(ts, tz, now, wall(new Date(now), tz), false)
}
export function whenShort(ts: string | null, tz = TZ, now = Date.now()): string {
  return ladder(ts, tz, now, wall(new Date(now), tz), true)
}

// The three texts an instant will read as on a page left open: today's,
// tomorrow's ("yest …"), and the day after's ("2 sep"). The tick script picks
// between them by comparing the reader's local day against the render's, so
// the ladder is never reimplemented in the browser — it is CALLED here, three
// times, and shipped as strings. What the script computes for itself is the
// duration head alone, which is two thresholds and no calendar at all.
//
// All three are CALENDAR forms (`rel` off), including the current day's. The
// duration head is the one part of the ladder that keeps moving while a page
// sits open, so it is exactly the part the forms must not freeze: ship "now"
// as form 0 and a stamp is still saying "now" ninety minutes later, having
// crossed into the hour the script would have handed back to the clock.
export function whenForms(ts: string | null, tz = TZ, now = Date.now(), short = true): [string, string, string] {
  const cal = wall(new Date(now), tz)
  return [0, 1, 2].map((i) => ladder(ts, tz, now, shift(cal, i), short, false)) as [string, string, string]
}

// A stamp older than two days cannot change while a page is open, so it ships
// as frozen text and the tick script never looks at it again.
export function volatile(ts: string | null, now = Date.now()): boolean {
  const d = at(ts)
  return d != null && now - d.getTime() < 2 * DAY_MS
}

// A local day STRING (what `day()` produced, what a bucket key is) as a
// person reads it: "2026-09-02" → "2 sep 26". For group headers only. The
// keys themselves stay ISO wherever they are keys — a usage bucket is sorted,
// filtered, put in a `?since=` and typed into an `<input type="date">`, and
// it has to agree with what `lore usage --by day` prints.
export function dayName(d: string | null): string {
  const m = d?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return d ?? ''
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]!.slice(2)}`
}

// The tooltip, and the page headers: everything, unabbreviated —
// "2 sep 26 17:45:40 EST".
export function stamp(ts: string | null, tz = TZ): string {
  const d = at(ts)
  if (!d) return ''
  const t = wall(d, tz)
  return `${t.d} ${MONTHS[t.m - 1]} ${String(t.y % 100).padStart(2, '0')} ${t.hh}:${t.mm}:${t.ss} ${zone(ts, tz)}`
}

// There is deliberately no always-relative `ago()` for the nav's freshness
// LED. It would have been the one stamp on the page whose text the browser
// had to derive on its own — a second ladder, in JavaScript, agreeing with
// this one by inspection — to buy "22h ago" over "indexed yest 03:12". The
// LED already carries staleness as COLOUR, which is what a light is for, so
// the text can be the same ladder as everything else and tick for free.
