import type { Database } from 'bun:sqlite'
import type { Lane } from './parse'

export type Hit = {
  well: string
  realPath: string | null
  sessionId: string
  ts: string | null
  lane: string
  gitBranch: string | null
  snippet: string
}

export type HistoryHit = {
  ts: string | null
  project: string | null
  sessionId: string | null
  snippet: string
}

export function searchMessages(
  db: Database,
  query: string,
  opts: { lanes: Lane[]; well?: string; limit: number },
): Hit[] {
  const laneMarks = opts.lanes.map(() => '?').join(',')
  const wellClause = opts.well ? 'AND (w.dir LIKE ? OR w.real_path LIKE ?)' : ''
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
  if (opts.well) params.push(`%${opts.well}%`, `%${opts.well}%`)
  params.push(opts.limit)
  return db.prepare(sql).all(...params) as Hit[]
}

export function searchHistory(db: Database, query: string, opts: { limit: number }): HistoryHit[] {
  const sql = `
    SELECT h.ts, h.project, h.session_id AS sessionId,
           snippet(history_fts, 0, '«', '»', ' … ', 24) AS snippet
    FROM history_fts f
    JOIN history h ON h.id = f.rowid
    WHERE history_fts MATCH ?
    ORDER BY rank LIMIT ?`
  return db.prepare(sql).all(query, opts.limit) as HistoryHit[]
}
