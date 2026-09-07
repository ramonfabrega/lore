import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { bridgeKey } from './jobs'
import { resolveSessionId } from './session'
import { listSessions } from './sessions'
import { listUsage } from './usage'

// The job as lore's unit (v18; docs/EXPLORER.md, Job).
//
// The explorer's spine was well → session, which is the harness's sharding.
// The unit the user lives in is the JOB: an agent over time, across /clears
// and daemon respawns (CLAUDE.md, the three ids). `lore` has run since
// 2026-07-17 as one bridge id over 57 sessions; `attrition` 175 sessions
// since 08-19 across several worktree wells. A job's sessions cross wells
// and a well's sessions cross jobs, so neither nests in the other.
//
// One key: the bridge id, which survives everything; else the root
// (`job_session_id`) for the pre-bridge sessions (161 of them, June to
// August), which split on a respawn and that is accepted; else the session
// itself — an interactive session is a job of one incarnation and one
// session, titled by its first prompt. Every session belongs to exactly one
// job.
//
// The NAME is a property, never the key: the daemon's `state.json` while the
// job still exists there (jobs.ts), else the name its peers used for it —
// `peer` on the receiver's copy of a message it sent, paired on msg_id —
// else null. The daemon forgets a job when the user deletes it: 17 state
// files against 67 bridge ids on 2026-09-02, and eight of the fifty
// nameless ones had their names sitting in the other side's rows.

export type JobKind = 'bridge' | 'root' | 'session'
// A session's bridge id: its own `bridge-session` record, else the one its
// job's state.json holds for its root. The second clause is what keeps a
// job's pre-bridge sessions in it — lore's first three transcripts (July
// 17) carry no bridge record, and keyed on their root alone they were a
// second "lore" that claimed the same daemon id. `s` is the sessions alias.
const JOB_BRIDGE_SQL = `COALESCE(s.bridge_key,
  (SELECT j.bridge_key FROM jobs j WHERE j.bridge_key IS NOT NULL AND s.job_session_id IS NOT NULL
     AND (j.session_id = s.job_session_id OR j.job_id = substr(s.job_session_id, 1, 8)) LIMIT 1))`
export const JOB_KEY_SQL = `COALESCE(${JOB_BRIDGE_SQL}, s.job_session_id, s.session_id)`
const JOB_KIND_SQL = `CASE WHEN ${JOB_BRIDGE_SQL} IS NOT NULL THEN 'bridge' WHEN s.job_session_id IS NOT NULL THEN 'root' ELSE 'session' END`

const PeerName = z.object({ key: z.string(), kind: z.string(), name: z.string(), n: z.number() })

// Recover the names of jobs the daemon has forgotten. A job's own sessions
// hold its SendMessage acks (lane `tool`, msg_id set); the receiver's relay
// row with the same msg_id names the sender in `peer`. One row per bridge
// (or root) that has no state.json row, `source = 'peer'`; re-derived on
// every index, so a job whose state.json turns up wins the row back.
export function backfillJobNames(db: Database): { named: number } {
  db.prepare("DELETE FROM jobs WHERE source = 'peer'").run()
  const rows = z.array(PeerName).parse(
    db
      .prepare(
        `SELECT COALESCE(s.bridge_key, s.job_session_id) AS key,
                CASE WHEN s.bridge_key IS NOT NULL THEN 'bridge' ELSE 'root' END AS kind,
                r.peer AS name, COUNT(*) AS n
         FROM messages m
         JOIN sessions s ON s.session_id = m.session_id
         JOIN messages r ON r.msg_id = m.msg_id AND r.lane = 'relay' AND r.peer IS NOT NULL
         WHERE m.lane = 'tool' AND m.msg_id IS NOT NULL
           AND COALESCE(s.bridge_key, s.job_session_id) IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.source = 'state'
                             AND ((s.bridge_key IS NOT NULL AND j.bridge_key = s.bridge_key)
                                  OR (s.bridge_key IS NULL AND (j.session_id = s.job_session_id OR j.job_id = substr(s.job_session_id, 1, 8)))))
         GROUP BY key, name
         ORDER BY key, n DESC, name`,
      )
      .all(),
  )
  const insert = db.prepare(
    `INSERT INTO jobs(job_id, session_id, bridge_key, name, source) VALUES(?, ?, ?, ?, 'peer')
     ON CONFLICT(job_id) DO NOTHING`,
  )
  const seen = new Set<string>()
  let named = 0
  for (const r of rows) {
    // Ordered n DESC within a key: the first name is the one peers used most.
    if (seen.has(r.key)) continue
    seen.add(r.key)
    insert.run(`peer:${r.key}`, r.kind === 'root' ? r.key : null, r.kind === 'bridge' ? r.key : null, r.name)
    named++
  }
  return { named }
}

const JobsRow = z.object({
  job_id: z.string(),
  session_id: z.string().nullable(),
  bridge_key: z.string().nullable(),
  name: z.string().nullable(),
  cwd: z.string().nullable(),
  state: z.string().nullable(),
  source: z.string(),
})
type JobsRow = z.infer<typeof JobsRow>

// Every jobs row, addressable by the keys a session carries: its bridge id,
// its root, or the root's first eight characters (the daemon's id).
function jobsIndex(db: Database) {
  const rows = z.array(JobsRow).parse(db.prepare('SELECT job_id, session_id, bridge_key, name, cwd, state, source FROM jobs').all())
  const byBridge = new Map<string, JobsRow>()
  const byRoot = new Map<string, JobsRow>()
  const byJobId = new Map<string, JobsRow>()
  const byName = new Map<string, JobsRow>()
  // state.json rows first, so a name the daemon still holds beats a peer's.
  for (const r of rows.sort((a, b) => (a.source === b.source ? 0 : a.source === 'state' ? -1 : 1))) {
    if (r.bridge_key && !byBridge.has(r.bridge_key)) byBridge.set(r.bridge_key, r)
    if (r.session_id && !byRoot.has(r.session_id)) byRoot.set(r.session_id, r)
    if (r.source === 'state' && !byJobId.has(r.job_id)) byJobId.set(r.job_id, r)
    if (r.name && !byName.has(r.name)) byName.set(r.name, r)
  }
  const forKey = (key: string, kind: JobKind): JobsRow | null =>
    kind === 'bridge' ? (byBridge.get(key) ?? null) : kind === 'root' ? (byRoot.get(key) ?? byJobId.get(key.slice(0, 8)) ?? null) : null
  return { forKey, byName, byJobId, byBridge }
}

export type JobRef = { key: string; kind: JobKind }

// The name of a job by its key — for a listing that groups sessions into
// jobs and wants to say whose they are (the explorer's recent panel).
export function jobNames(db: Database): (key: string, kind: JobKind) => string | null {
  const idx = jobsIndex(db)
  return (key, kind) => idx.forKey(key, kind)?.name ?? null
}

const SessionJob = z.object({ key: z.string(), kind: z.enum(['bridge', 'root', 'session']) })

// A session's job. Null when the session is not indexed.
export function jobOfSession(db: Database, sessionId: string): JobRef | null {
  return SessionJob.nullish().parse(db.prepare(`SELECT ${JOB_KEY_SQL} AS key, ${JOB_KIND_SQL} AS kind FROM sessions s WHERE s.session_id = ?`).get(sessionId)) ?? null
}

// The same for a page's worth of sessions, in one query.
export function jobsOfSessions(db: Database, sessionIds: string[]): Map<string, JobRef> {
  if (sessionIds.length === 0) return new Map()
  const rows = z.array(SessionJob.extend({ sessionId: z.string() })).parse(
    db
      .prepare(`SELECT s.session_id AS sessionId, ${JOB_KEY_SQL} AS key, ${JOB_KIND_SQL} AS kind FROM sessions s WHERE s.session_id IN (${sessionIds.map(() => '?').join(',')})`)
      .all(...sessionIds),
  )
  return new Map(rows.map((r) => [r.sessionId, { key: r.key, kind: r.kind }]))
}

// Anything a person or a page might hold → the job. A name (`lore`), a
// bridge id in any spelling (`session_X`, `cse_X`, bare), the daemon's job
// id, a root, or a session id / unique prefix. Null when nothing matches.
export function resolveJob(db: Database, q: string): JobRef | null {
  const idx = jobsIndex(db)
  const named = idx.byName.get(q)
  if (named) {
    if (named.bridge_key) return { key: named.bridge_key, kind: 'bridge' }
    if (named.session_id) {
      const viaRoot = rootOrBridge(db, named.session_id)
      if (viaRoot) return viaRoot
    }
  }
  const key = bridgeKey(q)
  if (key) {
    const hit = z.object({ n: z.number() }).parse(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE bridge_key = ?').get(key))
    if (hit.n > 0 || idx.byBridge.has(key)) return { key, kind: 'bridge' }
  }
  const daemon = idx.byJobId.get(q)
  if (daemon) {
    if (daemon.bridge_key) return { key: daemon.bridge_key, kind: 'bridge' }
    if (daemon.session_id) {
      const viaRoot = rootOrBridge(db, daemon.session_id)
      if (viaRoot) return viaRoot
    }
  }
  const asRoot = rootOrBridge(db, q)
  if (asRoot) return asRoot
  let sid: string
  try {
    sid = resolveSessionId(db, q, {})
  } catch {
    return null
  }
  return z
    .object({ key: z.string(), kind: z.enum(['bridge', 'root', 'session']) })
    .parse(db.prepare(`SELECT ${JOB_KEY_SQL} AS key, ${JOB_KIND_SQL} AS kind FROM sessions s WHERE s.session_id = ?`).get(sid))
}

// A root names a job only for sessions without a bridge id; when any
// session under that root carries one, the bridge is the job.
function rootOrBridge(db: Database, root: string): JobRef | null {
  const r = z
    .object({ n: z.number(), bridge: z.string().nullable() })
    .parse(db.prepare(`SELECT COUNT(*) AS n, MAX(${JOB_BRIDGE_SQL}) AS bridge FROM sessions s WHERE s.job_session_id = ?`).get(root))
  if (r.n === 0) return null
  return r.bridge ? { key: r.bridge, kind: 'bridge' } : { key: root, kind: 'root' }
}

const GroupRow = z.object({
  key: z.string(),
  kind: z.enum(['bridge', 'root', 'session']),
  sessions: z.number(),
  incarnations: z.number(),
  first: z.string().nullable(),
  last: z.string().nullable(),
  lines: z.number(),
  wells: z.string(),
  paths: z.string().nullable(),
  latest: z.string(),
})
const SessionKey = z.object({ sessionId: z.string(), key: z.string() })
const SpawnRow = z.object({ key: z.string(), result: z.string() })

// The repo a path belongs to: a worktree's checkout is its base repo's
// (`<repo>/.claude/worktrees/<name>` → `<repo>`), so a commander in one
// worktree and its workers in others group under one root.
export function repoOf(p: string | null | undefined): string | null {
  if (!p) return null
  const i = p.indexOf('/.claude/worktrees/')
  return i >= 0 ? p.slice(0, i) : p
}

// The fleet tree's edges: which job SPAWNED which. The daemon records no
// parentage (state.json's `children[]` are links, a worker's file names no
// parent — checked 2026-09-07), but the spawning session's transcript does:
// a `ccc spawn … --json` call answers with the child's daemon id as `ref`,
// and the harness's own `backgrounded · <id>` line carries the same. The id
// is the root session's first eight characters, so the child's job key is
// read off its sessions. Exact from the ledger, no inference: a child whose
// transcript is not indexed yet has no edge until it is.
const CHILD_ID = /"ref"\s*:\s*"([0-9a-f]{8})|backgrounded · ([0-9a-f]{8})/
export function spawnEdges(db: Database): Map<string, string> {
  const rows = z.array(SpawnRow).parse(
    db
      .prepare(
        `SELECT ${JOB_KEY_SQL} AS key, f2.text AS result
         FROM messages m JOIN messages_fts f ON f.rowid = m.id
         JOIN sessions s ON s.session_id = m.session_id
         JOIN messages m2 ON m2.tool_use_id = m.tool_use_id AND m2.session_id = m.session_id AND m2.type = 'user' AND m2.lane = 'tool'
         JOIN messages_fts f2 ON f2.rowid = m2.id
         WHERE m.type = 'assistant' AND m.lane = 'tool' AND m.tool_name = 'Bash' AND f.text LIKE '%spawn%'
         ORDER BY m.ts`,
      )
      .all(),
  )
  const childKey = db.prepare(`SELECT ${JOB_KEY_SQL} AS key FROM sessions s WHERE substr(s.job_session_id, 1, 8) = ? OR substr(s.session_id, 1, 8) = ? LIMIT 1`)
  const parentOf = new Map<string, string>()
  for (const r of rows) {
    const m = CHILD_ID.exec(r.result)
    const id = m?.[1] ?? m?.[2]
    if (!id) continue
    const child = z.object({ key: z.string() }).nullable().parse(childKey.get(id, id) ?? null)
    // The first spawn wins: a respawn of the same job by the same parent is
    // the same edge, and a different parent reusing a name is a new job.
    if (child && child.key !== r.key && !parentOf.has(child.key)) parentOf.set(child.key, r.key)
  }
  return parentOf
}
const KeyKind = z.object({ key: z.string(), kind: z.enum(['bridge', 'root', 'session']) })
const PeerRow = z.object({ key: z.string(), peer: z.string(), n: z.number() })

export type JobRow = {
  key: string
  kind: JobKind
  // The name, and whose word it is: the daemon's (`state`) or a peer's.
  name: string | null
  nameSource: 'state' | 'peer' | null
  // The daemon's id and last-indexed state, while the job still exists there.
  jobId: string | null
  state: string | null
  cwd: string | null
  first: string | null
  last: string | null
  sessions: number
  // Distinct roots under the bridge: every daemon respawn minted one.
  incarnations: number
  lines: number
  wells: string[]
  models: { model: string; requests: number }[]
  requests: number
  output: number
  listUsd: number | null
  // Every agent this job exchanged a message with, by name.
  peers: string[]
  // The repo this job works in — its cwd, or its first well, with a
  // worktree folded into its base checkout (repoOf). The fleet tree groups
  // on it.
  repo: string | null
  // The job that spawned this one (spawnEdges): exact, from the parent's
  // transcript; null for a job the user launched or whose parent is not
  // indexed. The tree hangs on it.
  parent: { key: string; name: string | null } | null
  // The newest session: what the job is on now.
  latest: { sessionId: string; firstPrompt: string | null; openedBy: string | null } | null
}

// The jobs, newest activity first. Background jobs by default; `all` adds
// interactive sessions as one-session jobs. `key` narrows to one.
export function listJobs(db: Database, opts: { all?: boolean; since?: string; limit: number; key?: string }): JobRow[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (opts.key) {
    where.push(`${JOB_KEY_SQL} = ?`)
    params.push(opts.key)
  } else if (!opts.all) where.push('(s.bridge_key IS NOT NULL OR s.job_session_id IS NOT NULL)')
  const having = opts.since ? 'HAVING MAX(COALESCE(s.last_activity_ts, s.last_ts)) >= ?' : ''
  if (opts.since) params.push(opts.since)
  params.push(opts.limit)
  const groups = z.array(GroupRow).parse(
    db
      .prepare(
        `SELECT ${JOB_KEY_SQL} AS key, ${JOB_KIND_SQL} AS kind,
                COUNT(*) AS sessions, COUNT(DISTINCT s.job_session_id) AS incarnations,
                MIN(s.first_ts) AS first, MAX(COALESCE(s.last_activity_ts, s.last_ts)) AS last,
                SUM(s.lines) AS lines, GROUP_CONCAT(DISTINCT w.dir) AS wells, GROUP_CONCAT(DISTINCT COALESCE(w.real_path, w.dir)) AS paths,
                (SELECT s2.session_id FROM sessions s2 WHERE COALESCE(s2.bridge_key, s2.job_session_id, s2.session_id) = ${JOB_KEY_SQL}
                 ORDER BY COALESCE(s2.last_activity_ts, s2.last_ts) DESC, s2.first_ts DESC LIMIT 1) AS latest
         FROM sessions s JOIN wells w ON w.id = s.well_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         GROUP BY key ${having}
         ORDER BY last DESC, first DESC LIMIT ?`,
      )
      .all(...params),
  )
  if (groups.length === 0) return []
  const idx = jobsIndex(db)
  const keys = new Set(groups.map((g) => g.key))
  // session → job key, for folding the per-session usage and relay rows.
  const keyOf = new Map(
    z.array(SessionKey).parse(db.prepare(`SELECT s.session_id AS sessionId, ${JOB_KEY_SQL} AS key FROM sessions s`).all()).map((r) => [r.sessionId, r.key]),
  )
  const usage = new Map<string, { requests: number; output: number; listUsd: number; priced: boolean; models: Map<string, number> }>()
  for (const r of listUsage(db, { by: 'session', limit: 1_000_000, split: true }).rows) {
    const key = keyOf.get(r.key)
    if (!key || !keys.has(key)) continue
    const u = usage.get(key) ?? { requests: 0, output: 0, listUsd: 0, priced: false, models: new Map() }
    u.requests += r.requests
    u.output += r.output
    if (r.listUsd != null) {
      u.listUsd += r.listUsd
      u.priced = true
    }
    for (const m of r.models ?? []) u.models.set(m.model, (u.models.get(m.model) ?? 0) + m.requests)
    usage.set(key, u)
  }
  // Peers: who wrote to this job (the relay rows in its sessions name the
  // sender), and whom it wrote to (relay rows elsewhere whose `peer` is this
  // job's name sit in the receiver's sessions).
  const kindOf = new Map(z.array(KeyKind).parse(db.prepare(`SELECT DISTINCT ${JOB_KEY_SQL} AS key, ${JOB_KIND_SQL} AS kind FROM sessions s`).all()).map((g) => [g.key, g.kind]))
  const nameOf = (key: string) => idx.forKey(key, kindOf.get(key) ?? 'session')?.name ?? null
  const keyOfName = new Map<string, string>()
  for (const key of kindOf.keys()) {
    const n = nameOf(key)
    if (n && !keyOfName.has(n)) keyOfName.set(n, key)
  }
  const peers = new Map<string, Set<string>>()
  const add = (key: string, peer: string) => {
    if (!keys.has(key)) return
    const set = peers.get(key) ?? new Set()
    set.add(peer)
    peers.set(key, set)
  }
  const relays = z.array(PeerRow).parse(
    db
      .prepare(
        `SELECT ${JOB_KEY_SQL} AS key, m.peer, COUNT(*) AS n FROM messages m JOIN sessions s ON s.session_id = m.session_id
         WHERE m.lane = 'relay' AND m.peer IS NOT NULL GROUP BY key, m.peer`,
      )
      .all(),
  )
  for (const r of relays) {
    add(r.key, r.peer)
    const sender = keyOfName.get(r.peer)
    const receiver = nameOf(r.key)
    if (sender && receiver) add(sender, receiver)
  }
  const latest = new Map(listSessions(db, { sessions: groups.map((g) => g.latest), limit: groups.length }).map((s) => [s.sessionId, s]))
  const parentOf = spawnEdges(db)
  return groups.map((g) => {
    const j = idx.forKey(g.key, g.kind)
    const u = usage.get(g.key)
    const l = latest.get(g.latest)
    const parentKey = parentOf.get(g.key) ?? null
    return {
      key: g.key,
      kind: g.kind,
      name: j?.name ?? null,
      nameSource: j ? (j.source === 'peer' ? 'peer' : 'state') : null,
      jobId: j && j.source === 'state' ? j.job_id : null,
      state: j?.state ?? null,
      cwd: j?.cwd ?? null,
      first: g.first,
      last: g.last,
      sessions: g.sessions,
      incarnations: g.incarnations,
      lines: g.lines,
      wells: g.wells.split(','),
      models: [...(u?.models ?? [])].map(([model, requests]) => ({ model, requests })).sort((a, b) => b.requests - a.requests || (a.model < b.model ? -1 : 1)),
      requests: u?.requests ?? 0,
      output: u?.output ?? 0,
      listUsd: u?.priced ? u.listUsd : null,
      peers: [...(peers.get(g.key) ?? [])].sort(),
      repo: repoOf(j?.cwd ?? g.paths?.split(',')[0] ?? null),
      parent: parentKey ? { key: parentKey, name: nameOf(parentKey) } : null,
      latest: l ? { sessionId: l.sessionId, firstPrompt: l.firstPrompt, openedBy: l.openedBy } : null,
    }
  })
}
