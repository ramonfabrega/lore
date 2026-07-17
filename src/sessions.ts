import type { Database } from 'bun:sqlite'

export type SessionRow = {
  well: string
  sessionId: string
  first: string | null
  last: string | null
  lines: number
  prompts: number
  firstPrompt: string | null
}

// The arc spine of a well: its sessions in order, each headed by the prompt
// that opened it. Ingest reads this before touching any transcript.
export function listSessions(db: Database, opts: { well?: string; limit: number }): SessionRow[] {
  const wellClause = opts.well ? 'WHERE (w.dir LIKE ? OR w.real_path LIKE ?)' : ''
  const sql = `
    SELECT w.dir AS well, s.session_id AS sessionId, s.first_ts AS first, s.last_ts AS last, s.lines,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.session_id AND m.lane = 'prompt') AS prompts,
           (SELECT f.text FROM messages m JOIN messages_fts f ON f.rowid = m.id
            WHERE m.session_id = s.session_id AND m.lane = 'prompt' ORDER BY m.ts LIMIT 1) AS firstPrompt
    FROM sessions s JOIN wells w ON w.id = s.well_id
    ${wellClause}
    ORDER BY s.first_ts LIMIT ?`
  const params: (string | number)[] = []
  if (opts.well) params.push(`%${opts.well}%`, `%${opts.well}%`)
  params.push(opts.limit)
  const rows = db.prepare(sql).all(...params) as SessionRow[]
  for (const r of rows) {
    r.first = r.first?.slice(0, 10) ?? null
    r.last = r.last?.slice(0, 10) ?? null
    if (r.firstPrompt) {
      const flat = r.firstPrompt.replace(/\s+/g, ' ').trim()
      r.firstPrompt = flat.length > 140 ? `${flat.slice(0, 140)}…` : flat
    }
  }
  return rows
}
