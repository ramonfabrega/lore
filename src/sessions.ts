import type { Database } from 'bun:sqlite'
import { z } from 'zod'

const Row = z.object({
  well: z.string(),
  sessionId: z.string(),
  first: z.string().nullable(),
  last: z.string().nullable(),
  idleUntil: z.string().nullable(),
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
//
// `last` is the last line that produced an indexed entry, NOT the last line in
// the file: harness heartbeats keep timestamping a dormant session for weeks
// (see db.ts v11). `idleUntil` exposes that tail when it exists and is null
// otherwise — a session showing `last: 2026-07-25, idleUntil: 2026-08-17` was
// open for three weeks and worked for two days.
//
// --limit takes the NEWEST n, then renders them oldest-first. Truncating the
// other way (the pre-v11 behaviour) meant `-n 10` on a live well answered with
// last month, which is how ingest #13 measured a 66-session backlog as ~8.
export function listSessions(
  db: Database,
  // byActivity: take the newest n by LAST ACTIVITY instead of by creation —
  // the explorer's "recent" (a long-lived session that worked today is
  // recent; a session created today that never ran is not). Rendering stays
  // oldest-first either way.
  opts: { well?: string; exact?: boolean; since?: string; limit: number; byActivity?: boolean },
): SessionRow[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (opts.well) {
    // exact matters when the target well's name is a substring of others — the
    // ~/code root well is a prefix of every other well and LIKE can't isolate it.
    where.push(opts.exact ? '(w.dir = ? OR w.real_path = ?)' : '(w.dir LIKE ? OR w.real_path LIKE ?)')
    const v = opts.exact ? opts.well : `%${opts.well}%`
    params.push(v, v)
  }
  if (opts.since) {
    // Filter on activity, not heartbeats — otherwise a dormant session pings
    // its way into every delta window.
    where.push('COALESCE(s.last_activity_ts, s.last_ts) >= ?')
    params.push(opts.since)
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const sql = `
    SELECT * FROM (
      SELECT w.dir AS well, s.session_id AS sessionId, s.first_ts AS first,
             COALESCE(s.last_activity_ts, s.last_ts) AS last,
             CASE WHEN s.last_activity_ts IS NOT NULL AND s.last_ts > s.last_activity_ts
                  THEN s.last_ts END AS idleUntil,
             s.lines,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.session_id AND m.lane = 'prompt') AS prompts,
             (SELECT m.cwd FROM messages m WHERE m.session_id = s.session_id AND m.cwd IS NOT NULL
              GROUP BY m.cwd ORDER BY COUNT(*) DESC LIMIT 1) AS workDir,
             (SELECT COUNT(DISTINCT m.cwd) FROM messages m WHERE m.session_id = s.session_id AND m.cwd IS NOT NULL) AS workDirs,
             (SELECT f.text FROM messages m JOIN messages_fts f ON f.rowid = m.id
              WHERE m.session_id = s.session_id AND m.lane = 'prompt' ORDER BY m.ts LIMIT 1) AS firstPrompt
      FROM sessions s JOIN wells w ON w.id = s.well_id
      ${whereClause}
      ORDER BY ${opts.byActivity ? 'COALESCE(s.last_activity_ts, s.last_ts)' : 's.first_ts'} DESC LIMIT ?
    ) ORDER BY ${opts.byActivity ? 'last, first' : 'first'}`
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
        idleUntil: r.idleUntil?.slice(0, 10) ?? null,
        firstPrompt: flat && flat.length > 140 ? `${flat.slice(0, 140)}…` : flat,
      }
    })
}
