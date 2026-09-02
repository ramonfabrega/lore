import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { relayHead } from './envelope'
import { ftsMatch } from './fts'
import type { Lane } from './parse'

// Row schemas live next to the queries that produce them — results are parsed
// at the boundary, never `as`-cast.
const Hit = z.object({
  well: z.string(),
  realPath: z.string().nullable(),
  sessionId: z.string(),
  // The transaction the hit sits in (v13) — the explorer links straight to it.
  promptId: z.string().nullable(),
  ts: z.string().nullable(),
  lane: z.string(),
  gitBranch: z.string().nullable(),
  snippet: z.string(),
})
export type Hit = z.infer<typeof Hit>

const HistoryHit = z.object({
  ts: z.string().nullable(),
  project: z.string().nullable(),
  sessionId: z.string().nullable(),
  snippet: z.string(),
})
export type HistoryHit = z.infer<typeof HistoryHit>

export function searchMessages(
  db: Database,
  query: string,
  opts: { lanes: Lane[]; well?: string; exact?: boolean; limit: number },
): Hit[] {
  const laneMarks = opts.lanes.map(() => '?').join(',')
  const wellClause = opts.well
    ? opts.exact
      ? 'AND (w.dir = ? OR w.real_path = ?)'
      : 'AND (w.dir LIKE ? OR w.real_path LIKE ?)'
    : ''
  const sql = `
    SELECT w.dir AS well, w.real_path AS realPath, m.session_id AS sessionId, m.prompt_id AS promptId, m.ts,
           m.lane, m.git_branch AS gitBranch,
           snippet(messages_fts, 0, '«', '»', ' … ', 24) AS snippet
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    JOIN sessions s ON s.session_id = m.session_id
    JOIN wells w ON w.id = s.well_id
    WHERE messages_fts MATCH ? AND m.lane IN (${laneMarks}) ${wellClause}
    ORDER BY rank LIMIT ?`
  const params: (string | number)[] = [...opts.lanes]
  if (opts.well) {
    const v = opts.exact ? opts.well : `%${opts.well}%`
    params.push(v, v)
  }
  params.push(opts.limit)
  return ftsMatch(query, (q) => z.array(Hit).parse(db.prepare(sql).all(q, ...params)))
}

export function searchHistory(db: Database, query: string, opts: { limit: number }): HistoryHit[] {
  const sql = `
    SELECT h.ts, h.project, h.session_id AS sessionId,
           snippet(history_fts, 0, '«', '»', ' … ', 24) AS snippet
    FROM history_fts f
    JOIN history h ON h.id = f.rowid
    WHERE history_fts MATCH ?
    ORDER BY rank LIMIT ?`
  return ftsMatch(query, (q) => z.array(HistoryHit).parse(db.prepare(sql).all(q, opts.limit)))
}

// ---- the explorer's search: sessions first ---------------------------------
//
// A hit is a message, but the thing a person opens is a session, so the page
// groups the top hits by session and ranks sessions by their best hit, then
// by how many hits they hold, then by recency — deterministic and sayable,
// no learned scoring. "Instant" comes from FTS5 itself (2–12 ms on 300k
// rows measured 2026-09-01), not from client code: the last bare token is
// made a prefix (`lor` → `lor*`) so a half-typed word already lands, unless
// the query carries FTS operators or quotes, which are passed through.

const GroupedRow = z.object({
  sessionId: z.string(),
  promptId: z.string().nullable(),
  ts: z.string().nullable(),
  lane: z.string(),
  rank: z.number(),
  snippet: z.string(),
})

export type SessionHit = {
  sessionId: string
  well: string
  first: string | null
  last: string | null
  firstPrompt: string | null
  // The peer that opened this session, when a relay did (sessions.ts).
  openedBy: string | null
  hits: number
  bestRank: number
  snippets: { lane: string; ts: string | null; promptId: string | null; snippet: string }[]
}

const FTS_OPERATOR = /["*:()^]|\b(AND|OR|NOT|NEAR)\b/

export function prefixLastToken(query: string): string {
  const q = query.trim()
  if (!q || FTS_OPERATOR.test(q)) return q
  const tokens = q.split(/\s+/)
  const last = tokens[tokens.length - 1]!
  if (!/^[\w]+$/.test(last)) return q
  return [...tokens.slice(0, -1), `${last}*`].join(' ')
}

export function searchSessions(
  db: Database,
  query: string,
  opts: { lanes: Lane[]; well?: string; exact?: boolean; limit: number; perSession?: number; sort?: 'rank' | 'recent'; candidates?: number },
): { query: string; sessions: SessionHit[]; hits: number } {
  const q = prefixLastToken(query)
  if (!q) return { query: q, sessions: [], hits: 0 }
  const laneMarks = opts.lanes.map(() => '?').join(',')
  const wellClause = opts.well
    ? opts.exact
      ? 'AND (w.dir = ? OR w.real_path = ?)'
      : 'AND (w.dir LIKE ? OR w.real_path LIKE ?)'
    : ''
  const sql = `
    SELECT m.session_id AS sessionId, m.prompt_id AS promptId, m.ts, m.lane,
           bm25(messages_fts) AS rank,
           snippet(messages_fts, 0, '«', '»', ' … ', 18) AS snippet
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    JOIN sessions s ON s.session_id = m.session_id
    JOIN wells w ON w.id = s.well_id
    WHERE messages_fts MATCH ? AND m.lane IN (${laneMarks}) ${wellClause}
    ORDER BY rank LIMIT ?`
  const params: (string | number)[] = [...opts.lanes]
  if (opts.well) {
    const v = opts.exact ? opts.well : `%${opts.well}%`
    params.push(v, v)
  }
  params.push(opts.candidates ?? 400)
  const rows = ftsMatch(q, (fq) => z.array(GroupedRow).parse(db.prepare(sql).all(fq, ...params)))

  const per = opts.perSession ?? 3
  const groups = new Map<string, { hits: number; bestRank: number; snippets: SessionHit['snippets'] }>()
  for (const r of rows) {
    const g = groups.get(r.sessionId) ?? { hits: 0, bestRank: r.rank, snippets: [] }
    g.hits++
    g.bestRank = Math.min(g.bestRank, r.rank)
    if (g.snippets.length < per) g.snippets.push({ lane: r.lane, ts: r.ts, promptId: r.promptId, snippet: r.snippet })
    groups.set(r.sessionId, g)
  }
  if (groups.size === 0) return { query: q, sessions: [], hits: 0 }

  const ids = [...groups.keys()]
  const Meta = z.object({
    sessionId: z.string(),
    well: z.string(),
    first: z.string().nullable(),
    last: z.string().nullable(),
    openerLane: z.string().nullable(),
    openerPeer: z.string().nullable(),
    firstPrompt: z.string().nullable(),
  })
  const meta = new Map(
    z
      .array(Meta)
      .parse(
        db
          .prepare(
            `SELECT s.session_id AS sessionId, w.dir AS well, s.first_ts AS first,
                    COALESCE(s.last_activity_ts, s.last_ts) AS last,
                    o.lane AS openerLane, o.peer AS openerPeer, f.text AS firstPrompt
             FROM sessions s JOIN wells w ON w.id = s.well_id
             LEFT JOIN messages o ON o.id = (SELECT m.id FROM messages m
                     WHERE m.session_id = s.session_id AND m.lane IN ('prompt', 'relay') ORDER BY m.ts LIMIT 1)
             LEFT JOIN messages_fts f ON f.rowid = o.id
             WHERE s.session_id IN (${ids.map(() => '?').join(',')})`,
          )
          .all(...ids),
      )
      .map((m) => [m.sessionId, m] as const),
  )
  const sessions: SessionHit[] = ids.map((id) => {
    const g = groups.get(id)!
    const m = meta.get(id)
    // Same head as every other listing (sessions.ts): a session a peer
    // opened is headed by the relayed message, not by a dash.
    const relay = m?.openerLane === 'relay' ? relayHead(m.firstPrompt ?? '') : null
    const flat = (relay ? relay.text : m?.firstPrompt)?.replace(/\s+/g, ' ').trim() ?? null
    return {
      sessionId: id,
      well: m?.well ?? '?',
      first: m?.first?.slice(0, 10) ?? null,
      last: m?.last?.slice(0, 10) ?? null,
      openedBy: relay ? (m?.openerPeer ?? relay.from) : null,
      firstPrompt: flat && flat.length > 140 ? `${flat.slice(0, 140)}…` : flat,
      hits: g.hits,
      bestRank: g.bestRank,
      snippets: g.snippets,
    }
  })
  // bm25 is lower-is-better (negative). Best hit, then more hits, then newer.
  sessions.sort((a, b) =>
    opts.sort === 'recent'
      ? (b.last ?? '').localeCompare(a.last ?? '') || a.bestRank - b.bestRank
      : a.bestRank - b.bestRank || b.hits - a.hits || (b.last ?? '').localeCompare(a.last ?? ''),
  )
  return { query: q, sessions: sessions.slice(0, opts.limit), hits: rows.length }
}
