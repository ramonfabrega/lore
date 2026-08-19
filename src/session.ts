import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { Lane } from './parse'

const Meta = z.object({
  well: z.string(),
  sessionId: z.string(),
  first: z.string().nullable(),
  last: z.string().nullable(),
  idleUntil: z.string().nullable(),
  lines: z.number(),
})

const CwdRow = z.object({ cwd: z.string(), n: z.number() })

const Msg = z.object({
  ts: z.string().nullable(),
  lane: z.string(),
  type: z.string(),
  gitBranch: z.string().nullable(),
  text: z.string(),
})
export type SessionDump = {
  session: z.infer<typeof Meta>
  workDirs: z.infer<typeof CwdRow>[]
  messages: z.infer<typeof Msg>[]
}

// The transcript slice behind an arc: one session's messages in order. Accepts a
// unique id prefix (ids are uuids; the sessions listing is the usual source).
// gitBranch rides along because well membership ≠ work location — per-message
// branch/cwd is the ground truth for where work happened.
export function getSession(
  db: Database,
  idPrefix: string,
  opts: { lanes: Lane[]; limit: number; well?: string; exact?: boolean },
): SessionDump {
  // --well narrows an ambiguous prefix. Ids are uuids so collisions are rare,
  // but the miner agent def has always documented this flag; before v11 it
  // errored `Unknown flag: --well` (ingest #12 finding).
  const wellClause = opts.well
    ? opts.exact
      ? ' AND (w.dir = ? OR w.real_path = ?)'
      : ' AND (w.dir LIKE ? OR w.real_path LIKE ?)'
    : ''
  const wellParams: string[] = []
  if (opts.well) {
    const v = opts.exact ? opts.well : `%${opts.well}%`
    wellParams.push(v, v)
  }
  const ids = z
    .array(z.object({ session_id: z.string() }))
    .parse(
      db
        .prepare(
          `SELECT s.session_id FROM sessions s JOIN wells w ON w.id = s.well_id
           WHERE s.session_id LIKE ?${wellClause} LIMIT 5`,
        )
        .all(`${idPrefix}%`, ...wellParams),
    )
  if (ids.length === 0)
    throw new Error(
      opts.well
        ? `no indexed session matches "${idPrefix}" in a well matching "${opts.well}"`
        : `no indexed session matches "${idPrefix}"`,
    )
  if (ids.length > 1)
    throw new Error(
      `ambiguous prefix "${idPrefix}": ${ids.map((r) => r.session_id).join(', ')}` +
        (opts.well ? '' : ' (narrow with --well)'),
    )
  const sessionId = ids[0]!.session_id

  const session = Meta.parse(
    db
      .prepare(
        `SELECT w.dir AS well, s.session_id AS sessionId, s.first_ts AS first,
                COALESCE(s.last_activity_ts, s.last_ts) AS last,
                CASE WHEN s.last_activity_ts IS NOT NULL AND s.last_ts > s.last_activity_ts
                     THEN s.last_ts END AS idleUntil,
                s.lines
         FROM sessions s JOIN wells w ON w.id = s.well_id WHERE s.session_id = ?`,
      )
      .get(sessionId),
  )

  // The work-location histogram over ALL lanes (not just the requested ones):
  // well membership records creation-time cwd; this is where work happened.
  const workDirs = z.array(CwdRow).parse(
    db
      .prepare(
        `SELECT cwd, COUNT(*) AS n FROM messages WHERE session_id = ? AND cwd IS NOT NULL
         GROUP BY cwd ORDER BY n DESC, cwd`,
      )
      .all(sessionId),
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
  return { session, workDirs, messages }
}
