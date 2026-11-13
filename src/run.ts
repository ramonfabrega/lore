import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { JOB_KEY_SQL, resolveJob, spawnEdges } from './job'
import { getLoop, type Loop, type LoopLane, type LoopOpts } from './loop'
import { getTrace, type Trace } from './trace'

// A job and the lanes it spawned as a page's data (docs/EXPLORER.md §The
// run page): `lore loop` for the numbers, bounded to a window of instants,
// plus what the page shows that a peek at the numbers does not — the
// sessions whose words to read (the job's in the window, and its PARENT's:
// the job that spawned it, which is the session that was talking when the
// window opened), and per lane the instants it reported back.
//
// Membership is by instant against the window, never by prose: a session
// of the job belongs to the window it started in, a session of the parent
// to the windows its span touches (the one that set this job to work ends
// a minute before the job's first turn — a thirty-minute reach before the
// window is what catches it, and it is stated here, not in the data).
//
// With no window asked for, the page reads the job's last 24 hours: a job
// can be months and hundreds of sessions long, and every session in the
// window is traced.

export type RunLane = LoopLane & {
  // When the lane wrote to the job (a relay in the job's sessions).
  msgs: string[]
}
export type Run = {
  loop: Loop
  parent: { key: string; name: string | null } | null
  // `defaulted` when nobody asked for a window and the last day was taken.
  window: { from: string | null; to: string; defaulted: boolean }
  sessions: { job: string[]; parent: string[] }
  lanes: RunLane[]
}

const Sess = z.array(z.object({ sessionId: z.string() }))
const Relay = z.array(z.object({ peer: z.string(), ts: z.string().nullable() }))
const Name = z.object({ name: z.string().nullable() }).nullable()
const REACH_MS = 30 * 60_000
const DAY_MS = 86_400_000

export async function getRun(db: Database, q: string, opts: LoopOpts = {}): Promise<{ run: Run; traces: { job: Trace[]; parent: Trace[] } }> {
  const ref = resolveJob(db, q)
  if (!ref) throw new Error(`no job matches "${q}" — a name from \`lore jobs\`, a bridge id, the daemon's id, or a session id`)
  const now = opts.now ?? Date.now()
  const defaulted = !opts.since && !opts.until
  const since = defaulted ? new Date(now - DAY_MS).toISOString() : opts.since
  const loop = await getLoop(db, ref.key, { ...opts, since, now, lanes: opts.lanes ?? 500 })

  const edge = spawnEdges(db).get(ref.key)
  const parent = edge
    ? { key: edge.key, name: Name.parse(db.prepare('SELECT name FROM jobs WHERE bridge_key = ? OR session_id = ? ORDER BY CASE source WHEN \'state\' THEN 0 ELSE 1 END LIMIT 1').get(edge.key, edge.key) ?? null)?.name ?? null }
    : null

  // The window on the page starts where the job does when the job is
  // younger than the window asked for.
  const started = loop.job.startedAt
  const from = loop.window.since && started && started > loop.window.since ? started : (loop.window.since ?? started)
  const to = loop.window.until ?? loop.asOf
  const inWindow = (key: string, reach: number) =>
    Sess.parse(
      db
        .prepare(
          `SELECT s.session_id AS sessionId FROM sessions s
           WHERE ${JOB_KEY_SQL} = ? AND s.first_ts <= ? AND COALESCE(s.last_activity_ts, s.last_ts) >= ?
           ORDER BY s.first_ts`,
        )
        .all(key, to, from ? new Date(Date.parse(from) - reach).toISOString() : ''),
    ).map((r) => r.sessionId)
  // The job's own: every session whose span touches the window. The
  // parent's: the same, reaching back to the one that set the job to work.
  const jobSessions = inWindow(ref.key, 0)
  const parentSessions = parent ? inWindow(parent.key, REACH_MS) : []

  // Who reported back when: the relay rows in the job's window sessions,
  // by sender — a lane's marks on the timeline.
  const msgs = new Map<string, string[]>()
  if (jobSessions.length) {
    const marks = jobSessions.map(() => '?').join(',')
    for (const r of Relay.parse(db.prepare(`SELECT peer, ts FROM messages WHERE session_id IN (${marks}) AND lane = 'relay' AND peer IS NOT NULL ORDER BY ts`).all(...jobSessions)))
      if (r.ts) msgs.set(r.peer, [...(msgs.get(r.peer) ?? []), r.ts])
  }
  const lanes: RunLane[] = loop.lanes.map((l) => ({ ...l, msgs: l.name ? (msgs.get(l.name) ?? []) : [] }))

  const o = { limit: 10_000, exact: true, steps: true, head: 400, proseHead: 20_000, lanes: false } as const
  return {
    run: { loop, parent, window: { from, to, defaulted }, sessions: { job: jobSessions, parent: parentSessions }, lanes },
    traces: { job: jobSessions.map((id) => getTrace(db, id, o)), parent: parentSessions.map((id) => getTrace(db, id, o)) },
  }
}
