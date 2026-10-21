import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { JOB_KEY_SQL, resolveJob, spawnEdges } from './job'
import { cwdOf, getLoop, listTranches, type Loop, type LoopLane, type LoopOpts, type Tranche } from './loop'
import { getTrace, type Trace } from './trace'

// One tranche of an unattended loop as a page's data (docs/EXPLORER.md
// §The run page): `lore loop` for the numbers, bounded to the tranche
// (`--until` the next tranche's base, off the queue's history), plus what
// the page shows that a peek at the numbers does not — the sessions whose
// words to read (the job's in the window, and its PARENT's: the steer that
// armed the tranche, which is the session active at the base commit), and
// per lane the booking that landed it and the instants it reported back.
//
// Membership is by instant against the tranche's window, never by prose:
// a commander session belongs to the tranche it started in, a steer
// session to the tranches its span touches (the pass that measures the
// forty-eighth tranche arms the forty-ninth and ends a minute before its
// base — a thirty-minute reach before the base is what catches it, and it
// is stated here, not in the data).

export type RunTranche = Tranche & { until: string | null }
export type RunLane = LoopLane & {
  // The booking commit that landed this lane's item, if one did.
  landed: { sha: string; at: string | null } | null
  // When the lane wrote to the job (a relay in the job's sessions).
  msgs: string[]
}
export type Run = {
  loop: Loop
  // Every tranche the queue's history names, oldest first, each ended by
  // the next one's base.
  tranches: RunTranche[]
  parent: { key: string; name: string | null } | null
  window: { from: string | null; to: string }
  sessions: { job: string[]; parent: string[] }
  lanes: RunLane[]
}

const Sess = z.array(z.object({ sessionId: z.string() }))
const Relay = z.array(z.object({ peer: z.string(), ts: z.string().nullable() }))
const Name = z.object({ name: z.string().nullable() }).nullable()
const REACH_MS = 30 * 60_000

export async function getRun(db: Database, q: string, opts: LoopOpts = {}): Promise<{ run: Run; traces: { job: Trace[]; parent: Trace[] } }> {
  const ref = resolveJob(db, q)
  if (!ref) throw new Error(`no job matches "${q}" — a name from \`lore jobs\`, a bridge id, the daemon's id, or a session id`)
  const cwd = cwdOf(db, ref.key)
  const listed = cwd ? await listTranches(cwd, opts.queue) : []
  const tranches: RunTranche[] = listed.map((t, i) => ({ ...t, until: listed[i + 1]?.base ?? null }))
  // A picked base that the history names ends at the next base; the open
  // tranche (or an unlisted base) runs to HEAD.
  const base = opts.base
  const picked = base ? tranches.find((t) => t.base === base.slice(0, 8)) : undefined
  const loop = await getLoop(db, ref.key, { ...opts, until: opts.until ?? picked?.until ?? undefined, lanes: opts.lanes ?? 500 })

  const edge = spawnEdges(db).get(ref.key)
  const parent = edge
    ? { key: edge.key, name: Name.parse(db.prepare('SELECT name FROM jobs WHERE bridge_key = ? OR session_id = ? ORDER BY CASE source WHEN \'state\' THEN 0 ELSE 1 END LIMIT 1').get(edge.key, edge.key) ?? null)?.name ?? null }
    : null

  const from = loop.tranche?.baseAt ?? loop.job.startedAt
  const to = loop.tranche?.endAt ?? loop.asOf
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
  // The job's own: the sessions that STARTED in the window (its previous
  // session ended at the handoff, inside the reach). The parent's: any
  // whose span touches the window, reaching back to the pass that armed it.
  const jobSessions = inWindow(ref.key, 10 * 60_000).filter((id) => {
    const first = z.object({ first: z.string().nullable() }).parse(db.prepare('SELECT first_ts AS first FROM sessions WHERE session_id = ?').get(id)).first
    return !from || (first != null && first >= new Date(Date.parse(from) - 10 * 60_000).toISOString())
  })
  const parentSessions = parent ? inWindow(parent.key, REACH_MS) : []

  // Who reported back when: the relay rows in the job's window sessions,
  // by sender — a lane's marks on the timeline.
  const msgs = new Map<string, string[]>()
  if (jobSessions.length) {
    const marks = jobSessions.map(() => '?').join(',')
    for (const r of Relay.parse(db.prepare(`SELECT peer, ts FROM messages WHERE session_id IN (${marks}) AND lane = 'relay' AND peer IS NOT NULL ORDER BY ts`).all(...jobSessions)))
      if (r.ts) msgs.set(r.peer, [...(msgs.get(r.peer) ?? []), r.ts])
  }
  const booked = loop.tranche?.booked ?? []
  const lanes: RunLane[] = loop.lanes.map((l) => ({
    ...l,
    landed: l.item != null ? (booked.filter((b) => b.item === l.item).at(-1) ?? null) : null,
    msgs: l.name ? (msgs.get(l.name) ?? []) : [],
  }))

  const o = { limit: 10_000, exact: true, steps: true, head: 400, proseHead: 20_000, lanes: false } as const
  return {
    run: { loop, tranches, parent, window: { from, to }, sessions: { job: jobSessions, parent: parentSessions }, lanes },
    traces: { job: jobSessions.map((id) => getTrace(db, id, o)), parent: parentSessions.map((id) => getTrace(db, id, o)) },
  }
}
