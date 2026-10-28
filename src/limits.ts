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

// How long each window is, by the harness's names. A gateway's `spend_limit`
// or an unknown kind has no window: its reading is reported bare.
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000 }

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
  // The ledger over [from, ts]: what the index priced inside the window up to
  // the reading (main-thread requests, lore-visible sessions only).
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

function usageIn(db: Database, from: string, until: string): WindowUsage | null {
  if (from >= until) return null
  const u = listUsage(db, { by: 'week', since: from, until, limit: 1 }).totals
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
  const where: string[] = []
  const params: string[] = []
  if (opts.kind) {
    where.push('kind = ?')
    params.push(opts.kind)
  }
  if (opts.since) {
    where.push('ts >= ?')
    params.push(opts.since)
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const cols = 'ts, session_id AS session, kind, pct, resets_at AS resetsAt, source'
  const rows = z.array(Reading).parse(db.prepare(`SELECT ${cols} FROM limits ${filter} ORDER BY ts DESC`).all(...params))

  const latestByKind = new Map<string, Reading>()
  for (const r of rows) if (!latestByKind.has(r.kind)) latestByKind.set(r.kind, r)

  const windows: LimitWindow[] = []
  for (const r of latestByKind.values()) {
    const len = WINDOW_MS[r.kind]
    const until = r.resetsAt && len ? new Date(r.resetsAt).toISOString() : null
    const from = until && len ? new Date(new Date(until).getTime() - len).toISOString() : null
    const usage = from ? usageIn(db, from, r.ts) : null
    const implied = usage && r.pct >= 5 ? scale(usage, 100 / r.pct) : null
    // The window's own readings, oldest first, mod rows only (a 429 is the
    // same fact at 100 and pairs with no dollar figure of its own).
    let usdPerPoint: number | null = null
    if (from && until) {
      const inWindow = rows.filter((x) => x.kind === r.kind && x.source === 'mod' && x.ts >= from && x.ts < until).reverse()
      const first = inWindow[0]
      const last = inWindow.at(-1)
      if (first && last && last.pct - first.pct >= 5) {
        const span = usageIn(db, first.ts, last.ts)
        if (span) usdPerPoint = Math.round((span.listUsd / (last.pct - first.pct)) * 100) / 100
      }
    }
    windows.push({ kind: r.kind, pct: r.pct, ts: r.ts, session: r.session, source: r.source, resetsAt: r.resetsAt, from, until, usage, implied, usdPerPoint })
  }
  windows.sort((a, b) => (WINDOW_MS[b.kind] ?? 0) - (WINDOW_MS[a.kind] ?? 0))

  const hits = rows.filter((r) => r.source === 'transcript').slice(0, opts.limit)
  const history = rows.filter((r) => r.source === 'mod').slice(0, opts.limit)
  return {
    windows,
    hits,
    history,
    count: rows.length,
    note:
      'pct is the account\'s own reading (the `limits` mod logs the status line\'s rate_limits on every whole-point move; a 429 in a transcript is a reading of 100). `usage` is the ledger inside the window up to the reading — main-thread requests, lore-visible sessions, list rates; `implied` scales it to 100% and assumes the quota tracks the ledger linearly, which the two recorded 429s say it does NOT by price (same tokens, 2x the dollars) — read `cacheRead`/`output` before `listUsd`. `usdPerPoint` is measured between two mod readings of the same window. Install the mod: `claude plugin install limits@mods`.',
  }
}
