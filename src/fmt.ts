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
// "EST" — what to print where the pages used to hardcode "UTC".
export function zone(tz = TZ): string {
  const part = fmt('zone', tz).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')
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
