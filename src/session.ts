import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { Lane } from './parse'

const Meta = z.object({
  well: z.string(),
  sessionId: z.string(),
  first: z.string().nullable(),
  last: z.string().nullable(),
  lines: z.number(),
})

const Msg = z.object({
  ts: z.string().nullable(),
  lane: z.string(),
  type: z.string(),
  gitBranch: z.string().nullable(),
  text: z.string(),
})
export type SessionDump = { session: z.infer<typeof Meta>; messages: z.infer<typeof Msg>[] }

// The transcript slice behind an arc: one session's messages in order. Accepts a
// unique id prefix (ids are uuids; the sessions listing is the usual source).
// gitBranch rides along because well membership ≠ work location — per-message
// branch/cwd is the ground truth for where work happened.
export function getSession(
  db: Database,
  idPrefix: string,
  opts: { lanes: Lane[]; limit: number },
): SessionDump {
  const ids = z
    .array(z.object({ session_id: z.string() }))
    .parse(db.prepare('SELECT session_id FROM sessions WHERE session_id LIKE ? LIMIT 5').all(`${idPrefix}%`))
  if (ids.length === 0) throw new Error(`no indexed session matches "${idPrefix}"`)
  if (ids.length > 1)
    throw new Error(`ambiguous prefix "${idPrefix}": ${ids.map((r) => r.session_id).join(', ')}`)
  const sessionId = ids[0]!.session_id

  const session = Meta.parse(
    db
      .prepare(
        `SELECT w.dir AS well, s.session_id AS sessionId, s.first_ts AS first, s.last_ts AS last, s.lines
         FROM sessions s JOIN wells w ON w.id = s.well_id WHERE s.session_id = ?`,
      )
      .get(sessionId),
  )

  const placeholders = opts.lanes.map(() => '?').join(', ')
  const messages = z.array(Msg).parse(
    db
      .prepare(
        `SELECT m.ts, m.lane, m.type, m.git_branch AS gitBranch, f.text
         FROM messages m JOIN messages_fts f ON f.rowid = m.id
         WHERE m.session_id = ? AND m.lane IN (${placeholders})
         ORDER BY m.id LIMIT ?`,
      )
      .all(sessionId, ...opts.lanes, opts.limit),
  )
  return { session, messages }
}
