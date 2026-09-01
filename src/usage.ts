import type { Database } from 'bun:sqlite'
import { z } from 'zod'

// The token profile (lore#8): where the tokens go, by well / session / model /
// day / week / month, in the four billed classes plus thinking. Reads the
// `requests` table (main-thread API requests, deduped by message id) and joins
// the spawn observatory's output totals for the well/session groupings so a
// session's fan-out cost sits next to its own.
//
// Cost is a LIST-PRICE EQUIVALENT at first-party API rates, not a bill — the
// fleet runs on subscription OAuth, where the price only matters as the
// exchange rate the usage limit is believed to track. Rates are dated:
// Fable 5.1 shipped a 75% cache-read cut on 2026-09-01, and the grind loop is
// ~99.7% cache-read tokens, so the same model id can price two ways across a
// date. A request whose model matches no rate is summed but left unpriced,
// and the model is named in `unpriced` — a silent zero would misstate the
// mix exactly where a new model shows up.

export const GROUPINGS = ['well', 'session', 'model', 'day', 'week', 'month'] as const
export type Grouping = (typeof GROUPINGS)[number]

// USD per million tokens. Longest model-id prefix wins; within a model the
// latest `from` on or before the request's day applies (the first rate covers
// anything earlier). cache write is the 5-minute ephemeral rate (1.25× input).
type Rate = { from: string; input: number; cacheWrite: number; cacheRead: number; output: number }
const RATES: Record<string, Rate[]> = {
  'claude-fable-5-1': [{ from: '2026-09-01', input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 }],
  'claude-mythos-5-1': [{ from: '2026-09-01', input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 }],
  'claude-fable-5': [{ from: '2026-01-01', input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 }],
  'claude-mythos-5': [{ from: '2026-01-01', input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 }],
  'claude-opus-5': [{ from: '2026-01-01', input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 }],
  'claude-opus-4-8': [{ from: '2026-01-01', input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 }],
  'claude-opus-4-7': [{ from: '2026-01-01', input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 }],
  'claude-opus-4-6': [{ from: '2026-01-01', input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 }],
  'claude-opus-4-5': [{ from: '2025-11-01', input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 }],
  'claude-opus-4-1': [{ from: '2025-01-01', input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 }],
  'claude-opus-4': [{ from: '2025-01-01', input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 }],
  'claude-sonnet-5': [{ from: '2026-01-01', input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 }],
  'claude-sonnet-4': [{ from: '2025-01-01', input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 }],
  'claude-haiku-4-5': [{ from: '2025-01-01', input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }],
  'claude-haiku-3-5': [{ from: '2025-01-01', input: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 }],
}

export function rateFor(model: string | null, day: string | null): Rate | null {
  if (!model) return null
  const key = Object.keys(RATES)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  if (!key) return null
  const rates = RATES[key]!
  const d = day ?? '9999-12-31'
  let pick = rates[0]!
  for (const r of rates) if (r.from <= d) pick = r
  return pick
}

const Tokens = {
  requests: z.number(),
  sessions: z.number(),
  input: z.number(),
  cacheWrite: z.number(),
  cacheRead: z.number(),
  output: z.number(),
  thinking: z.number(),
}
const Cell = z.object({ key: z.string(), model: z.string().nullable(), day: z.string().nullable(), ...Tokens })
const SpawnCell = z.object({ key: z.string(), spawns: z.number(), spawnOutput: z.number() })
const SessionMeta = z.object({ key: z.string(), well: z.string(), first: z.string().nullable() })

export type UsageRow = {
  key: string
  well?: string
  first?: string | null
  requests: number
  sessions: number
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  thinking: number
  spawns?: number
  spawnOutput?: number
  listUsd: number | null
}
export type UsageReport = {
  by: Grouping
  count: number
  totals: Omit<UsageRow, 'key'>
  rows: UsageRow[]
  unpriced: string[]
  note: string
}

const KEY_SQL: Record<Grouping, string> = {
  well: 'w.dir',
  session: 'r.session_id',
  model: "COALESCE(r.model, '?')",
  day: 'substr(r.ts, 1, 10)',
  week: "strftime('%Y-W%W', r.ts)",
  month: 'substr(r.ts, 1, 7)',
}

export function listUsage(
  db: Database,
  opts: {
    by: Grouping
    well?: string
    exact?: boolean
    session?: string
    // An explicit id list (the explorer decorating a page's rows) — cheaper
    // than aggregating every session and picking twenty.
    sessions?: string[]
    model?: string
    since?: string
    until?: string
    limit: number
  },
): UsageReport {
  const where: string[] = ['1=1']
  const params: (string | number)[] = []
  if (opts.sessions) {
    if (opts.sessions.length === 0) return { by: opts.by, count: 0, totals: { requests: 0, sessions: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, listUsd: 0 }, rows: [], unpriced: [], note: '' }
    where.push(`r.session_id IN (${opts.sessions.map(() => '?').join(',')})`)
    params.push(...opts.sessions)
  }
  if (opts.well) {
    where.push(opts.exact ? '(w.dir = ? OR w.real_path = ?)' : '(w.dir LIKE ? OR w.real_path LIKE ?)')
    const v = opts.exact ? opts.well : `%${opts.well}%`
    params.push(v, v)
  }
  if (opts.session) {
    where.push('r.session_id LIKE ?')
    params.push(`${opts.session}%`)
  }
  if (opts.model) {
    where.push('r.model LIKE ?')
    params.push(`%${opts.model}%`)
  }
  if (opts.since) {
    where.push('r.ts >= ?')
    params.push(opts.since)
  }
  if (opts.until) {
    where.push('r.ts < ?')
    params.push(opts.until)
  }
  const filter = where.join(' AND ')
  // Cells are (key, model, day) so pricing can be applied per model and per
  // rate date before folding into the requested grouping.
  const cells = z.array(Cell).parse(
    db
      .prepare(
        `SELECT ${KEY_SQL[opts.by]} AS key, r.model AS model, substr(r.ts, 1, 10) AS day,
                COUNT(*) AS requests, COUNT(DISTINCT r.session_id) AS sessions,
                SUM(r.input_tokens) AS input, SUM(r.cache_write_tokens) AS cacheWrite,
                SUM(r.cache_read_tokens) AS cacheRead, SUM(r.output_tokens) AS output,
                SUM(r.thinking_tokens) AS thinking
         FROM requests r
         JOIN sessions s ON s.session_id = r.session_id
         JOIN wells w ON w.id = s.well_id
         WHERE ${filter}
         GROUP BY 1, 2, 3`,
      )
      .all(...params),
  )

  const rows = new Map<string, UsageRow & { priced: boolean }>()
  const unpriced = new Set<string>()
  const blank = (key: string): UsageRow & { priced: boolean } => ({
    key,
    requests: 0,
    sessions: 0,
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
    listUsd: 0,
    priced: true,
  })
  for (const c of cells) {
    const row = rows.get(c.key) ?? blank(c.key)
    row.requests += c.requests
    row.input += c.input
    row.cacheWrite += c.cacheWrite
    row.cacheRead += c.cacheRead
    row.output += c.output
    row.thinking += c.thinking
    const rate = rateFor(c.model, c.day)
    if (rate) {
      row.listUsd =
        (row.listUsd ?? 0) +
        (c.input * rate.input + c.cacheWrite * rate.cacheWrite + c.cacheRead * rate.cacheRead + c.output * rate.output) / 1e6
    } else {
      row.priced = false
      unpriced.add(c.model ?? '?')
    }
    rows.set(c.key, row)
  }
  // Distinct sessions per key can't be summed across cells — recount.
  if (opts.by !== 'session') {
    const perKey = z.array(z.object({ key: z.string(), sessions: z.number() })).parse(
      db
        .prepare(
          `SELECT ${KEY_SQL[opts.by]} AS key, COUNT(DISTINCT r.session_id) AS sessions
           FROM requests r JOIN sessions s ON s.session_id = r.session_id JOIN wells w ON w.id = s.well_id
           WHERE ${filter} GROUP BY 1`,
        )
        .all(...params),
    )
    for (const p of perKey) {
      const row = rows.get(p.key)
      if (row) row.sessions = p.sessions
    }
  } else {
    for (const row of rows.values()) row.sessions = 1
  }

  // Spawn output rides along for the groupings where "this session's fan-out"
  // is a meaningful attribution (the spawn observatory keeps the detail).
  if (opts.by === 'well' || opts.by === 'session') {
    const spawnKey = opts.by === 'well' ? 'w.dir' : 'sp.session_id'
    const spawnCells = z.array(SpawnCell).parse(
      db
        .prepare(
          `SELECT ${spawnKey} AS key, COUNT(*) AS spawns, SUM(sp.output_tokens) AS spawnOutput
           FROM spawns sp JOIN wells w ON w.dir = sp.well_dir
           GROUP BY 1`,
        )
        .all(),
    )
    for (const row of rows.values()) {
      row.spawns = 0
      row.spawnOutput = 0
    }
    for (const c of spawnCells) {
      const row = rows.get(c.key)
      if (!row) continue
      row.spawns = c.spawns
      row.spawnOutput = c.spawnOutput
    }
  }
  if (opts.by === 'session') {
    const meta = z.array(SessionMeta).parse(
      db
        .prepare(
          `SELECT s.session_id AS key, w.dir AS well, s.first_ts AS first
           FROM sessions s JOIN wells w ON w.id = s.well_id
           WHERE s.session_id IN (${[...rows.keys()].map(() => '?').join(',') || "''"})`,
        )
        .all(...rows.keys()),
    )
    for (const m of meta) {
      const row = rows.get(m.key)
      if (row) {
        row.well = m.well
        row.first = m.first?.slice(0, 10) ?? null
      }
    }
  }

  const finished: UsageRow[] = [...rows.values()].map(({ priced, ...r }) => ({
    ...r,
    listUsd: priced ? round2(r.listUsd ?? 0) : null,
  }))
  const timeGrouped = opts.by === 'day' || opts.by === 'week' || opts.by === 'month'
  finished.sort((a, b) =>
    timeGrouped ? a.key.localeCompare(b.key) : (b.listUsd ?? -1) - (a.listUsd ?? -1) || b.output - a.output,
  )
  const page = timeGrouped ? finished.slice(-opts.limit) : finished.slice(0, opts.limit)

  const totals = finished.reduce<Omit<UsageRow, 'key'>>(
    (t, r) => ({
      requests: t.requests + r.requests,
      sessions: t.sessions + r.sessions,
      input: t.input + r.input,
      cacheWrite: t.cacheWrite + r.cacheWrite,
      cacheRead: t.cacheRead + r.cacheRead,
      output: t.output + r.output,
      thinking: t.thinking + r.thinking,
      ...(r.spawns != null ? { spawns: (t.spawns ?? 0) + r.spawns, spawnOutput: (t.spawnOutput ?? 0) + (r.spawnOutput ?? 0) } : {}),
      listUsd: t.listUsd == null || r.listUsd == null ? null : round2(t.listUsd + r.listUsd),
    }),
    { requests: 0, sessions: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, listUsd: 0 },
  )
  // `sessions` in totals is distinct across the whole filter, not a sum of rows.
  if (opts.by !== 'session') {
    totals.sessions = z
      .object({ n: z.number() })
      .parse(
        db
          .prepare(
            `SELECT COUNT(DISTINCT r.session_id) AS n FROM requests r
             JOIN sessions s ON s.session_id = r.session_id JOIN wells w ON w.id = s.well_id WHERE ${filter}`,
          )
          .get(...params),
      ).n
  }

  return {
    by: opts.by,
    count: page.length,
    totals,
    rows: page,
    unpriced: [...unpriced].sort(),
    note:
      'listUsd is a list-price equivalent at first-party API rates (dated; cache reads priced per model/date) — not a bill. Main-thread requests only; spawns/spawnOutput join the subagent observatory (`lore spawns` for detail). Open a session with `lore session <id>`.',
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
