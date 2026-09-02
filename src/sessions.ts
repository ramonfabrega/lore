import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { relayHead } from './envelope'
import { day } from './fmt'

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
  openerId: z.number().nullable(),
  openerLane: z.string().nullable(),
  openerPeer: z.string().nullable(),
  firstPrompt: z.string().nullable(),
})
const ModelRow = z.object({ sessionId: z.string(), model: z.string(), requests: z.number() })

// lastAt is the full last-activity timestamp (`last` is its day) — the
// explorer's recent list wants the hour. `models` is what SERVED the
// session, most requests first (model.ts): a listing that names a
// conversation names what ran it, so neither a person nor a miner has to
// open a session to learn whether it was opus or a sonnet fan-out.
export type SessionRow = Omit<z.infer<typeof Row>, 'openerId' | 'openerLane' | 'openerPeer'> & {
  lastAt: string | null
  // The peer that OPENED this session, when a relay did — `firstPrompt` is
  // then that message, not the user's. Null for a session the user opened.
  openedBy: string | null
  models: { model: string; requests: number }[]
}

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
  // Pick the page FIRST (ids, dates), decorate SECOND: the per-session
  // subqueries (prompt count, modal cwd over messages, first prompt) cost
  // ~1.5 ms each across 300k message rows, and evaluating them for every
  // session before LIMIT made the explorer's root take a second for twenty
  // rows (2026-09-01). Correlated subqueries in the outer SELECT run only
  // for the limited set.
  const sql = `
    SELECT p.well, p.sessionId, p.first, p.last, p.idleUntil, p.lines,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = p.sessionId AND m.lane = 'prompt') AS prompts,
           (SELECT m.cwd FROM messages m WHERE m.session_id = p.sessionId AND m.cwd IS NOT NULL
            GROUP BY m.cwd ORDER BY COUNT(*) DESC LIMIT 1) AS workDir,
           (SELECT COUNT(DISTINCT m.cwd) FROM messages m WHERE m.session_id = p.sessionId AND m.cwd IS NOT NULL) AS workDirs,
           (SELECT m.id FROM messages m
            WHERE m.session_id = p.sessionId AND m.lane IN ('prompt', 'relay') ORDER BY m.ts LIMIT 1) AS openerId
    FROM (
      SELECT w.dir AS well, s.session_id AS sessionId, s.first_ts AS first,
             COALESCE(s.last_activity_ts, s.last_ts) AS last,
             CASE WHEN s.last_activity_ts IS NOT NULL AND s.last_ts > s.last_activity_ts
                  THEN s.last_ts END AS idleUntil,
             s.lines
      FROM sessions s JOIN wells w ON w.id = s.well_id
      ${whereClause}
      ORDER BY ${opts.byActivity ? 'COALESCE(s.last_activity_ts, s.last_ts)' : 's.first_ts'} DESC LIMIT ?
    ) p`
  // The opener's text and provenance come off ONE extra join on the id the
  // subquery already found, not a second scan per session. The join is what
  // makes the outer ORDER BY load-bearing: a subquery's order does not
  // survive being joined, so it is stated HERE, once, not inside.
  const order = opts.byActivity ? 'q.last, q.first' : 'q.first'
  const outer = `SELECT q.*, o.lane AS openerLane, o.peer AS openerPeer, f.text AS firstPrompt
    FROM (${sql}) q
    LEFT JOIN messages o ON o.id = q.openerId
    LEFT JOIN messages_fts f ON f.rowid = q.openerId
    ORDER BY ${order}`
  params.push(opts.limit)
  const picked = z.array(Row).parse(db.prepare(outer).all(...params))
  const models = modelsFor(db, picked.map((r) => r.sessionId))
  return picked.map(({ openerId: _id, openerLane, openerPeer, ...r }) => {
    // A session can be OPENED by a peer — an agent standing by that a relay
    // set to work has no prompt-lane row at all, and headed the arc with a
    // dash until v16. Its head is the relayed message with the envelope off
    // (envelope.ts), and `openedBy` names who sent it.
    const relay = openerLane === 'relay' ? relayHead(r.firstPrompt ?? '') : null
    const openedBy = relay ? (openerPeer ?? relay.from) : null
    const flat = (relay ? relay.text : r.firstPrompt)?.replace(/\s+/g, ' ').trim() ?? null
    return {
      ...r,
      first: day(r.first) || null,
      last: day(r.last) || null,
      lastAt: r.last ?? null,
      idleUntil: day(r.idleUntil) || null,
      openedBy,
      firstPrompt: flat && flat.length > 140 ? `${flat.slice(0, 140)}…` : flat,
      models: models.get(r.sessionId) ?? [],
    }
  })
}

// The served models of a set of sessions, most requests first. One grouped
// query over the PICKED ids (idx_requests_session), never a correlated
// subquery per row — the same rule the page/decorate split above follows.
export function modelsFor(db: Database, sessionIds: string[]): Map<string, { model: string; requests: number }[]> {
  const out = new Map<string, { model: string; requests: number }[]>()
  if (sessionIds.length === 0) return out
  const rows = z.array(ModelRow).parse(
    db
      .prepare(
        `SELECT session_id AS sessionId, model, COUNT(*) AS requests FROM requests
         WHERE model IS NOT NULL AND session_id IN (${sessionIds.map(() => '?').join(',')})
         GROUP BY 1, 2 ORDER BY 3 DESC, 2`,
      )
      .all(...sessionIds),
  )
  for (const r of rows) (out.get(r.sessionId) ?? out.set(r.sessionId, []).get(r.sessionId)!).push({ model: r.model, requests: r.requests })
  return out
}
