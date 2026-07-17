import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { Lane } from './parse'

// Row schemas live next to the queries that produce them — results are parsed
// at the boundary, never `as`-cast.
const Hit = z.object({
  well: z.string(),
  realPath: z.string().nullable(),
  sessionId: z.string(),
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
    SELECT w.dir AS well, w.real_path AS realPath, m.session_id AS sessionId, m.ts,
           m.lane, m.git_branch AS gitBranch,
           snippet(messages_fts, 0, '«', '»', ' … ', 24) AS snippet
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    JOIN sessions s ON s.session_id = m.session_id
    JOIN wells w ON w.id = s.well_id
    WHERE messages_fts MATCH ? AND m.lane IN (${laneMarks}) ${wellClause}
    ORDER BY rank LIMIT ?`
  const params: (string | number)[] = [query, ...opts.lanes]
  if (opts.well) {
    const v = opts.exact ? opts.well : `%${opts.well}%`
    params.push(v, v)
  }
  params.push(opts.limit)
  return z.array(Hit).parse(db.prepare(sql).all(...params))
}

export function searchHistory(db: Database, query: string, opts: { limit: number }): HistoryHit[] {
  const sql = `
    SELECT h.ts, h.project, h.session_id AS sessionId,
           snippet(history_fts, 0, '«', '»', ' … ', 24) AS snippet
    FROM history_fts f
    JOIN history h ON h.id = f.rowid
    WHERE history_fts MATCH ?
    ORDER BY rank LIMIT ?`
  return z.array(HistoryHit).parse(db.prepare(sql).all(query, opts.limit))
}
