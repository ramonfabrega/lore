import type { Database } from 'bun:sqlite'
import { z } from 'zod'

const Row = z.object({
  well: z.string(),
  sessionId: z.string(),
  first: z.string().nullable(),
  last: z.string().nullable(),
  lines: z.number(),
  prompts: z.number(),
  workDir: z.string().nullable(),
  workDirs: z.number(),
  firstPrompt: z.string().nullable(),
})
export type SessionRow = z.infer<typeof Row>

// The arc spine of a well: its sessions in order, each headed by the prompt
// that opened it. Ingest reads this before touching any transcript.
// workDir is the modal per-message cwd — the ground truth for where work
// happened (well membership only records the creation-time cwd); workDirs > 1
// flags a session that moved (e.g. entered a worktree mid-session).
export function listSessions(
  db: Database,
  opts: { well?: string; exact?: boolean; limit: number },
): SessionRow[] {
  // exact matters when the target well's name is a substring of others — the
  // ~/code root well is a prefix of every other well and LIKE can't isolate it.
  const wellClause = opts.well
    ? opts.exact
      ? 'WHERE (w.dir = ? OR w.real_path = ?)'
      : 'WHERE (w.dir LIKE ? OR w.real_path LIKE ?)'
    : ''
  const sql = `
    SELECT w.dir AS well, s.session_id AS sessionId, s.first_ts AS first, s.last_ts AS last, s.lines,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.session_id AND m.lane = 'prompt') AS prompts,
           (SELECT m.cwd FROM messages m WHERE m.session_id = s.session_id AND m.cwd IS NOT NULL
            GROUP BY m.cwd ORDER BY COUNT(*) DESC LIMIT 1) AS workDir,
           (SELECT COUNT(DISTINCT m.cwd) FROM messages m WHERE m.session_id = s.session_id AND m.cwd IS NOT NULL) AS workDirs,
           (SELECT f.text FROM messages m JOIN messages_fts f ON f.rowid = m.id
            WHERE m.session_id = s.session_id AND m.lane = 'prompt' ORDER BY m.ts LIMIT 1) AS firstPrompt
    FROM sessions s JOIN wells w ON w.id = s.well_id
    ${wellClause}
    ORDER BY s.first_ts LIMIT ?`
  const params: (string | number)[] = []
  if (opts.well) {
    const v = opts.exact ? opts.well : `%${opts.well}%`
    params.push(v, v)
  }
  params.push(opts.limit)
  return z
    .array(Row)
    .parse(db.prepare(sql).all(...params))
    .map((r) => {
      const flat = r.firstPrompt?.replace(/\s+/g, ' ').trim() ?? null
      return {
        ...r,
        first: r.first?.slice(0, 10) ?? null,
        last: r.last?.slice(0, 10) ?? null,
        firstPrompt: flat && flat.length > 140 ? `${flat.slice(0, 140)}…` : flat,
      }
    })
}
