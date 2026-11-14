import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { dayStart } from './fmt'
import { listUsage } from './usage'

// The subscription as the account enforces it. `lore usage` prices tokens at
// list rates; the user's budget is a PERCENT of a weekly allowance nobody
// publishes, and the two never mapped: on 2026-10-28 two recorded 429s said a
// week was ≈4.8B cache-read tokens whatever the list price, and a /usage
// reading the same month implied half that. This verb puts the percent (the
// `limits` table: the mod's log plus the transcripts' 429s) beside the ledger
// over the SAME window, so the exchange rate is measured, never believed:
// spend in the window up to the reading, divided by the reading, is the
// week in list dollars and in tokens. `resetsAt` anchors the window off the
// data; there is deliberately no hardcoded weekday.

const Reading = z.object({
  ts: z.string(),
  session: z.string().nullable(),
  kind: z.string(),
  pct: z.number(),
  resetsAt: z.string().nullable(),
  source: z.string(),
})
export type Reading = z.infer<typeof Reading>

// How long each window is, by the harness's names: five hours, or seven days
// for the week and for every week SCOPED to one model or surface
// (`seven_day_fable`, `seven_day_opus`, `seven_day_cowork`). A gateway's
// `spend_limit` or an unknown kind has no window: its reading is reported bare.
function windowMs(kind: string): number | null {
  if (kind === 'five_hour') return 5 * 3600_000
  if (kind === 'seven_day' || kind.startsWith('seven_day_')) return 7 * 86400_000
  return null
}

// One window, two spellings. The mod logs a model's week by its model
// (`seven_day_fable`, from the usage endpoint's `weekly_scoped` row, labelled
// "Fable"); the harness names the SAME window in a 429 by its billing rule,
// `rateLimitType: seven_day_overage_included`, which its own label table
// reads "Fable limit" (2.1.321). Without the alias the mod's readings and the
// instant the window read 100 are two windows that never meet. Applied at
// read time: the table keeps what each source said.
const ALIAS: Record<string, string> = { seven_day_overage_included: 'seven_day_fable' }
const canon = (kind: string): string => ALIAS[kind] ?? kind

// The weeks scoped to a SURFACE: seven days like the rest, but the ledger
// cannot tell a surface from the requests, so they carry no usage.
const SURFACES = new Set(['seven_day_oauth_apps', 'seven_day_cowork', 'seven_day_omelette'])

// The model a week is scoped to, as the substring its request model ids
// carry: `seven_day_fable` → `fable`. Fable's allowance is its own (half the
// all-models week, 2026-11-11: 85% of the week read 94% of Fable's), so the
// ledger beside it is Fable's requests alone — the whole ledger over Fable's
// percent would be a number about nothing. (An account with Mythos shares
// this bucket with it; this box has none.)
function scopeModel(kind: string): string | null {
  if (kind === 'seven_day' || !kind.startsWith('seven_day_') || SURFACES.has(kind)) return null
  return kind.slice('seven_day_'.length)
}

export type WindowUsage = { requests: number; cacheRead: number; output: number; listUsd: number }

// A window reset on demand, before its `resetsAt`: the percent starts over
// and the boundary does not move. On 2026-11-12 the all-models week read 100
// at 03:56Z, refused a request at 04:11:16Z and read 0 at 04:12Z; Fable's
// week read 98 at 02:46Z and 2 at 05:27Z — both still resetting 11-14 11:00Z.
// The percent then counts from the reset and the ledger from the window's
// start, and the row priced a week's spend against a day's percent: 57 USD a
// point on 11-13, against 15 to 22 measured before. A reading that DROPS
// inside one window is the signal, and the only one — nothing in a reading
// says a reset happened. Five points, the module's noise floor: across 1,794
// readings logged by a dozen sessions at once (2026-10-28 → 11-13) the two
// drops above are the only ones of any size, so the floor has never had to
// choose; it is there for the stale status line that has not happened yet.
const RESET_DROP = 5

export type WindowReset = {
  // The first reading after the drop — where the ledger restarts. The reset
  // itself fell between `wasAt` and here, and no reading names the instant.
  at: string
  // What the window read there. Not always 0: Fable's first reading after
  // the reset came 75 minutes later, at 2.
  pct: number
  // The last reading before it.
  was: number
  wasAt: string
}

// The last reset inside one window, from its readings oldest first.
function lastReset(readings: Reading[]): WindowReset | null {
  let reset: WindowReset | null = null
  for (let i = 1; i < readings.length; i++) {
    const prev = readings[i - 1]!
    const cur = readings[i]!
    if (prev.pct - cur.pct >= RESET_DROP) reset = { at: cur.ts, pct: cur.pct, was: prev.pct, wasAt: prev.ts }
  }
  return reset
}

export type LimitWindow = {
  kind: string
  // The latest reading of this window: when, how much, from which session.
  pct: number
  ts: string
  session: string | null
  source: string
  resetsAt: string | null
  // [from, until): the window the reading belongs to, from `resetsAt`.
  from: string | null
  until: string | null
  // The model a scoped week counts (`fable` for `seven_day_fable`): `usage`,
  // `implied` and `usdPerPoint` are then that model's requests alone. Null
  // for the all-models windows.
  model: string | null
  // Set when the window was reset on demand before its boundary: `usage`,
  // `implied` and `usdPerPoint` then count from `reset.at`, not from `from`.
  reset: WindowReset | null
  // The ledger over [from, ts] — or [reset.at, ts] after a reset: what the
  // index priced inside the window up to the reading (main-thread requests,
  // lore-visible sessions only). Null for a week scoped to a surface, which
  // the ledger cannot single out.
  usage: WindowUsage | null
  // usage × 100 / pct — what 100% of this window is, in the ledger's units,
  // if the quota tracked the ledger linearly. After a reset the divisor is
  // the points gained since (pct − reset.pct), the same span the ledger
  // covers. Absent under 5 points (too noisy).
  implied: WindowUsage | null
  // List dollars per percent point between the window's first and latest mod
  // readings — the first one at or after a reset — when they are at least 5
  // points apart: the exchange rate the window actually showed, independent
  // of the implied line's assumption.
  usdPerPoint: number | null
}

// A window whose last reading names a boundary that has already passed. The
// account has said nothing about it since, so there is no percent to show
// and no window to price — only the fact that it used to be read.
export type EndedWindow = { kind: string; pct: number; ts: string; resetsAt: string }

export type LimitsReport = {
  // The windows OPEN now: the latest reading of each names a boundary still
  // ahead (or names none — a gateway's `spend_limit`).
  windows: LimitWindow[]
  // The ones that are not. The plan dropped the five-hour window around
  // 2026-10-30; its last reading (0%, resetting that evening) was listed as
  // a live window for two weeks. A week also lands here between its
  // boundary and the first reading of the next one.
  ended: EndedWindow[]
  // The 429s the transcripts carry: the instants a window read 100. `kind`
  // is the window refused, under lore's one name for it; `rateLimitType` is
  // the harness's own word in that record, verbatim — the 11-12 wall landed
  // in a Fable session two points short of Fable's own limit, and only the
  // record could say it was the all-models week that refused it.
  hits: (Reading & { rateLimitType: string })[]
  // The mod's readings, newest first.
  history: Reading[]
  count: number
  note: string
}

function usageIn(db: Database, from: string, until: string, model: string | null): WindowUsage | null {
  if (from >= until) return null
  const u = listUsage(db, { by: 'week', since: from, until, limit: 1, ...(model ? { model } : {}) }).totals
  return { requests: u.requests, cacheRead: u.cacheRead, output: u.output, listUsd: Math.round((u.listUsd ?? 0) * 100) / 100 }
}

function scale(u: WindowUsage, factor: number): WindowUsage {
  return {
    requests: Math.round(u.requests * factor),
    cacheRead: Math.round(u.cacheRead * factor),
    output: Math.round(u.output * factor),
    listUsd: Math.round(u.listUsd * factor * 100) / 100,
  }
}

export function readLimits(db: Database, opts: { kind?: string; since?: string; limit: number; now?: string }): LimitsReport {
  const now = opts.now ?? new Date().toISOString()
  const cols = 'ts, session_id AS session, kind, pct, resets_at AS resetsAt, source'
  // The kind filter runs after the alias, so either spelling of a window
  // asks for the same one.
  const want = opts.kind ? canon(opts.kind) : null
  // Every reading, whatever `--since` says. The windows are the account's
  // state NOW and need the whole window's readings: `--since` used to filter
  // in SQL before the reset detection, so a since that fell between the
  // reading before a drop and the one after hid the drop, and the row priced
  // a week's spend against the points since the reset — the 57-USD-a-point
  // error the reset exists to prevent, back (2026-11-14 review). `--since`
  // bounds what it says it bounds, the readings listed: `hits` and `history`.
  // A bare date is the local day (dayStart), an instant passes through.
  const all = z
    .array(Reading)
    .parse(db.prepare(`SELECT ${cols} FROM limits ORDER BY ts DESC`).all())
    .map((r) => ({ ...r, kind: canon(r.kind), said: r.kind }))
    .filter((r) => !want || r.kind === want)
  const since = opts.since ? dayStart(opts.since) : null
  const rows = since ? all.filter((r) => r.ts >= since) : all

  // The reading a window is shown at: the newest one that names a boundary
  // still ahead. A reading belongs to the window it NAMES (below), and that
  // holds here too: a status line still showing LAST week, logged seconds
  // after another session logged this week's 1%, was the newest reading of
  // the kind, its boundary was past, and the open week was filed under
  // `ended` at 97 (2026-11-14 review). Only when no reading names an open
  // boundary is the newest one the window's last word.
  const nowMs = Date.parse(now)
  const open = (r: Reading) => r.resetsAt != null && windowMs(r.kind) != null && Date.parse(r.resetsAt) > nowMs
  const latestByKind = new Map<string, Reading>()
  for (const r of all) {
    const held = latestByKind.get(r.kind)
    if (!held || (open(r) && !open(held))) latestByKind.set(r.kind, r)
  }

  const windows: LimitWindow[] = []
  const ended: EndedWindow[] = []
  for (const r of latestByKind.values()) {
    const len = windowMs(r.kind)
    const model = scopeModel(r.kind)
    const priced = !SURFACES.has(r.kind)
    const until = r.resetsAt && len ? new Date(r.resetsAt).toISOString() : null
    if (until && until <= now) {
      ended.push({ kind: r.kind, pct: r.pct, ts: r.ts, resetsAt: until })
      continue
    }
    const from = until && len ? new Date(new Date(until).getTime() - len).toISOString() : null
    // The window's own readings, oldest first — both sources: a 429 is a
    // reading of 100, and the drop after it is how a reset shows.
    // A reading belongs to the window it NAMES: one logged a moment after
    // the boundary by a status line still showing last week would otherwise
    // open this week at 97 and read as a reset.
    const boundary = until ? new Date(until).getTime() : 0
    const sameWindow = (x: Reading) => x.resetsAt != null && Math.abs(new Date(x.resetsAt).getTime() - boundary) < 60_000
    const inWindow = from && until ? all.filter((x) => x.kind === r.kind && x.ts >= from && x.ts < until && sameWindow(x)).reverse() : []
    const reset = lastReset(inWindow)
    const ledgerFrom = reset ? reset.at : from
    const points = r.pct - (reset?.pct ?? 0)
    const usage = ledgerFrom && priced ? usageIn(db, ledgerFrom, r.ts, model) : null
    const implied = usage && points >= 5 ? scale(usage, 100 / points) : null
    // Mod rows only (a 429 is the same fact at 100 and pairs with no dollar
    // figure of its own), and none from before a reset.
    let usdPerPoint: number | null = null
    if (ledgerFrom && priced) {
      const mod = inWindow.filter((x) => x.source === 'mod' && x.ts >= ledgerFrom)
      const first = mod[0]
      const last = mod.at(-1)
      if (first && last && last.pct - first.pct >= 5) {
        const span = usageIn(db, first.ts, last.ts, model)
        if (span) usdPerPoint = Math.round((span.listUsd / (last.pct - first.pct)) * 100) / 100
      }
    }
    windows.push({ kind: r.kind, pct: r.pct, ts: r.ts, session: r.session, source: r.source, resetsAt: r.resetsAt, from, until, model, reset, usage, implied, usdPerPoint })
  }
  // Longest window first; the all-models week ahead of the weeks scoped inside it.
  windows.sort((a, b) => (windowMs(b.kind) ?? 0) - (windowMs(a.kind) ?? 0) || a.kind.localeCompare(b.kind))

  const hits = rows
    .filter((r) => r.source === 'transcript')
    .slice(0, opts.limit)
    .map(({ said, ...r }) => ({ ...r, rateLimitType: said }))
  const history = rows
    .filter((r) => r.source === 'mod')
    .slice(0, opts.limit)
    .map(({ said: _said, ...r }) => r)
  ended.sort((a, b) => b.ts.localeCompare(a.ts))
  return {
    windows,
    ended,
    hits,
    history,
    count: rows.length,
    note:
      'pct is the account\'s own reading (the `limits` mod logs the status line\'s rate_limits on every whole-point move; a 429 in a transcript is a reading of 100). `usage` is the ledger inside the window up to the reading — main-thread requests, lore-visible sessions, list rates; `implied` scales it to 100% and assumes the quota tracks the ledger linearly, which the two recorded 429s say it does NOT by price (same tokens, 2x the dollars) — read `cacheRead`/`output` before `listUsd`. `usdPerPoint` is measured between two mod readings of the same window. A window reset on demand before its boundary (the percent DROPS inside one `resetsAt`: 100 to 0 on 2026-11-12) says so in `reset` — `at` the first reading after the drop, `pct` what it read there, `was`/`wasAt` the reading before — and its `usage`, `implied` and `usdPerPoint` then count from `reset.at`, with `implied` scaled by the points gained since. Each hit names the `rateLimitType` its 429 carried, verbatim. `windows` are the ones OPEN now; a window whose last reading names a boundary already past is in `ended` with that reading and nothing priced (the plan dropped `five_hour` around 2026-10-30, and a week sits there between its boundary and the next reading); a stale reading that names a boundary already past never moves an open window there. `since` bounds `hits`, `history` and `count` only — the windows always read every reading of the window, so a reset before `since` is still seen. A week scoped to one model (`seven_day_fable`: Fable has its own allowance, half the week, and it binds first) names it in `model`, and its `usage`/`implied`/`usdPerPoint` count that model\'s requests alone; a 429 the harness spells `seven_day_overage_included` is that same Fable week and is listed under it. Install the mod: `claude plugin install limits@mods`.',
  }
}
