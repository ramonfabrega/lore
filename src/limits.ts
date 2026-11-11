import type { Database } from 'bun:sqlite'
import { z } from 'zod'
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
  // The ledger over [from, ts]: what the index priced inside the window up to
  // the reading (main-thread requests, lore-visible sessions only). Null for
  // a week scoped to a surface, which the ledger cannot single out.
  usage: WindowUsage | null
  // usage × 100 / pct — what 100% of this window is, in the ledger's units,
  // if the quota tracked the ledger linearly. Absent under 5% (too noisy).
  implied: WindowUsage | null
  // List dollars per percent point between the window's first and latest mod
  // readings, when they are at least 5 points apart: the exchange rate the
  // window actually showed, independent of the implied line's assumption.
  usdPerPoint: number | null
}

export type LimitsReport = {
  windows: LimitWindow[]
  // The 429s the transcripts carry: the instants a window read 100.
  hits: Reading[]
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

export function readLimits(db: Database, opts: { kind?: string; since?: string; limit: number }): LimitsReport {
  const filter = opts.since ? 'WHERE ts >= ?' : ''
  const cols = 'ts, session_id AS session, kind, pct, resets_at AS resetsAt, source'
  // The kind filter runs after the alias, so either spelling of a window
  // asks for the same one.
  const want = opts.kind ? canon(opts.kind) : null
  const rows = z
    .array(Reading)
    .parse(db.prepare(`SELECT ${cols} FROM limits ${filter} ORDER BY ts DESC`).all(...(opts.since ? [opts.since] : [])))
    .map((r) => ({ ...r, kind: canon(r.kind) }))
    .filter((r) => !want || r.kind === want)

  const latestByKind = new Map<string, Reading>()
  for (const r of rows) if (!latestByKind.has(r.kind)) latestByKind.set(r.kind, r)

  const windows: LimitWindow[] = []
  for (const r of latestByKind.values()) {
    const len = windowMs(r.kind)
    const model = scopeModel(r.kind)
    const priced = !SURFACES.has(r.kind)
    const until = r.resetsAt && len ? new Date(r.resetsAt).toISOString() : null
    const from = until && len ? new Date(new Date(until).getTime() - len).toISOString() : null
    const usage = from && priced ? usageIn(db, from, r.ts, model) : null
    const implied = usage && r.pct >= 5 ? scale(usage, 100 / r.pct) : null
    // The window's own readings, oldest first, mod rows only (a 429 is the
    // same fact at 100 and pairs with no dollar figure of its own).
    let usdPerPoint: number | null = null
    if (from && until && priced) {
      const inWindow = rows.filter((x) => x.kind === r.kind && x.source === 'mod' && x.ts >= from && x.ts < until).reverse()
      const first = inWindow[0]
      const last = inWindow.at(-1)
      if (first && last && last.pct - first.pct >= 5) {
        const span = usageIn(db, first.ts, last.ts, model)
        if (span) usdPerPoint = Math.round((span.listUsd / (last.pct - first.pct)) * 100) / 100
      }
    }
    windows.push({ kind: r.kind, pct: r.pct, ts: r.ts, session: r.session, source: r.source, resetsAt: r.resetsAt, from, until, model, usage, implied, usdPerPoint })
  }
  // Longest window first; the all-models week ahead of the weeks scoped inside it.
  windows.sort((a, b) => (windowMs(b.kind) ?? 0) - (windowMs(a.kind) ?? 0) || a.kind.localeCompare(b.kind))

  const hits = rows.filter((r) => r.source === 'transcript').slice(0, opts.limit)
  const history = rows.filter((r) => r.source === 'mod').slice(0, opts.limit)
  return {
    windows,
    hits,
    history,
    count: rows.length,
    note:
      'pct is the account\'s own reading (the `limits` mod logs the status line\'s rate_limits on every whole-point move; a 429 in a transcript is a reading of 100). `usage` is the ledger inside the window up to the reading — main-thread requests, lore-visible sessions, list rates; `implied` scales it to 100% and assumes the quota tracks the ledger linearly, which the two recorded 429s say it does NOT by price (same tokens, 2x the dollars) — read `cacheRead`/`output` before `listUsd`. `usdPerPoint` is measured between two mod readings of the same window. A week scoped to one model (`seven_day_fable`: Fable has its own allowance, half the week, and it binds first) names it in `model`, and its `usage`/`implied`/`usdPerPoint` count that model\'s requests alone; a 429 the harness spells `seven_day_overage_included` is that same Fable week and is listed under it. Install the mod: `claude plugin install limits@mods`.',
  }
}
