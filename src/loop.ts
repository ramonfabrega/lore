import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { type AgentRow, iso, type JobState, listAgents, readJobState } from './agents'
import { dayStart } from './fmt'
import { JOB_KEY_SQL, type JobRef, jobsOfSessions, resolveJob, spawnEdges } from './job'
import { dominantModel } from './model'
import { listUsage } from './usage'

// One job and the jobs it spawned, read as numbers.
//
// A peek at an agent that runs others asks four things — is it alive, what
// is it running, what are its lanes doing, what has it cost — and every
// answer is already on disk, written by someone other than the model: the
// daemon's state.json (`detail`, `tempo`, the running shells in `fan`), the
// roster (each lane's state and context), and lore's own ledger (the spawn
// edges, the fee). This verb is that computation, zero model, so a band or
// a page can poll it and the agent writes nothing new.
//
// It used to do more, and what it did was attrition's (2026-10-15 →
// 11-13): it read the repo's queue file for a tranche's base commit and
// its scoreboard, counted landings by a commit-subject regex (`^Book `),
// pulled item numbers out of subjects and lane names, and `lore tranches`
// walked the queue file's history. Every one of those was the SHAPE OF ONE
// REPO'S PROSE, with defaults spelled for it, inside a tool whose rule is
// that a fact is a field (CLAUDE.md). It broke each time the prose moved —
// `Book` against `Booking`, a count read as an item, and for good on
// 2026-11-13 when the queue stopped naming a base at all — and attrition
// itself had stopped calling it a week earlier (0 calls that week, against
// 114 of `limits` and 53 of `api job`) for a table of its own on lore's
// general verbs (`tools/tranche.py`, on `trace --steps` and `sessions`).
// That is the right split and now the only one: the loop's grammar lives
// in the loop's repo, and this reads what lore alone knows. The window is
// an instant (`--since`, `--until`), which any caller with a commit can
// make (`git show -s --format=%cI <sha>`).
//
// Built to be polled, so it reads narrowly: `listJobs` folds the fee of
// every session in the index to answer for one key (500 ms, and the first
// cut called it twice); this folds the fee of the job's own sessions and
// its lanes' inside the window, and the spawn edges of the job's sessions
// alone. The roster (`claude agents`, plus a tail read per live transcript
// for the context) is the one cost that stays, the same one `lore agents`
// pays.

const LIVE = new Set(['working', 'blocked'])

export type LoopLane = {
  key: string
  name: string | null
  // The daemon's state now when it lists the lane, else the last indexed.
  state: string | null
  live: boolean
  model: string | null
  spawnedAt: string | null
  ageMs: number | null
  // The context the lane's next turn carries (agents.ts) — a LIVE reading,
  // null once the daemon no longer lists the lane — and `peak`, the deepest
  // request it made inside the window (input + cache read + cache write),
  // which the index keeps. `deep` is the threshold a lane is asked to clear
  // at: a live lane is deep on what its next turn carries, a lane that is
  // gone on what it reached.
  ctx: number | null
  peak: number | null
  deep: boolean
  requests: number
  listUsd: number | null
  last: string | null
}

export type Loop = {
  asOf: string
  job: {
    key: string
    name: string | null
    jobId: string | null
    state: string | null
    tempo: string | null
    detail: string | null
    cwd: string | null
    sessionId: string | null
    model: string | null
    ctx: number | null
    startedAt: string | null
    updatedAt: string | null
    sessions: number
    // The last indexed activity across the job's sessions: how stale the
    // ledger side (requests, fee, edges) is.
    indexedUntil: string | null
  }
  // The window the lanes and the fee are read inside, as instants; both
  // null is the job's whole life.
  window: { since: string | null; until: string | null }
  // What is running under the job now: the daemon's `fan`, unfinished.
  running: { kind: string | null; label: string | null; since: string | null }[]
  // The lanes listed (`--lanes`, live first); `lanesTotal` counts every
  // lane in the window and `spend` sums every one, not the listed ones.
  lanes: LoopLane[]
  lanesTotal: number
  spend: { jobUsd: number | null; laneUsd: number | null; totalUsd: number | null }
  spoke: { lastPrompt: string | null; lastText: string | null; lastSent: string | null }
}

export type LoopOpts = {
  // The window: a date (the local day) or an ISO instant. Lanes spawned
  // inside it (plus any still live when it is open-ended) and the fee
  // inside it; `until` closes it, and the clock ages run to is then its
  // instant, not now.
  since?: string
  until?: string
  deep?: number
  lanes?: number
  now?: number
  // The live side, injected by a test: the roster and each job's state.
  live?: { rows: AgentRow[]; states: Map<string, JobState | null> }
}

const Ts = z.object({ ts: z.string().nullable() })
const Span = z.object({ n: z.number(), first: z.string().nullable(), last: z.string().nullable() })
const Sessions = z.array(z.object({ sessionId: z.string() }))
// The daemon's row for a key: by bridge, by root, or by the daemon id a
// root's first eight characters spell (the three ids, CLAUDE.md); a row
// the daemon still holds (`state`) before one its peers named.
const JobsRow = z.object({ jobId: z.string(), name: z.string().nullable(), state: z.string().nullable(), cwd: z.string().nullable() })

function sessionsOf(db: Database, key: string): string[] {
  return Sessions.parse(db.prepare(`SELECT s.session_id AS sessionId FROM sessions s WHERE ${JOB_KEY_SQL} = ? ORDER BY s.first_ts`).all(key)).map((r) => r.sessionId)
}

function spanOf(db: Database, key: string): { n: number; first: string | null; last: string | null } {
  return Span.parse(
    db.prepare(`SELECT COUNT(*) AS n, MIN(s.first_ts) AS first, MAX(COALESCE(s.last_activity_ts, s.last_ts)) AS last FROM sessions s WHERE ${JOB_KEY_SQL} = ?`).get(key),
  )
}

function jobsRowOf(db: Database, key: string): z.infer<typeof JobsRow> | null {
  return JobsRow.nullable().parse(
    db
      .prepare(
        `SELECT job_id AS jobId, name, state, cwd FROM jobs
         WHERE bridge_key = ? OR session_id = ? OR job_id = substr(?, 1, 8)
         ORDER BY CASE source WHEN 'state' THEN 0 ELSE 1 END LIMIT 1`,
      )
      .get(key, key, key) ?? null,
  )
}

function lastTs(db: Database, sessions: string[], where: string): string | null {
  if (sessions.length === 0) return null
  const marks = sessions.map(() => '?').join(',')
  return Ts.parse(db.prepare(`SELECT MAX(ts) AS ts FROM messages WHERE session_id IN (${marks}) AND ${where}`).get(...sessions)).ts
}

// The fee of a set of sessions inside a window: requests, list price, and
// the models that served them.
function feeOf(db: Database, sessions: string[], since: string | undefined, until?: string): { requests: number; listUsd: number | null; models: { model: string; requests: number }[] } {
  if (sessions.length === 0) return { requests: 0, listUsd: 0, models: [] }
  const u = listUsage(db, { by: 'session', sessions, since, until, limit: 100_000, split: true })
  const models = new Map<string, number>()
  for (const r of u.rows) for (const m of r.models ?? []) models.set(m.model, (models.get(m.model) ?? 0) + m.requests)
  return {
    requests: u.totals.requests,
    listUsd: u.totals.listUsd,
    models: [...models].map(([model, requests]) => ({ model, requests })).sort((a, b) => b.requests - a.requests),
  }
}

// The deepest context any request of a set of sessions carried inside a
// window: what a lane REACHED, which outlives the roster's live reading.
const Peak = z.object({ peak: z.number().nullable() })
function peakOf(db: Database, sessions: string[], since: string | undefined, until?: string): number | null {
  if (sessions.length === 0) return null
  const marks = sessions.map(() => '?').join(',')
  return Peak.parse(
    db
      .prepare(
        `SELECT MAX(input_tokens + cache_read_tokens + cache_write_tokens) AS peak FROM requests
         WHERE session_id IN (${marks}) AND (? IS NULL OR ts >= ?) AND (? IS NULL OR ts <= ?)`,
      )
      .get(...sessions, since ?? null, since ?? null, until ?? null, until ?? null),
  ).peak
}

export async function getLoop(db: Database, q: string, opts: LoopOpts = {}): Promise<Loop> {
  const ref: JobRef | null = resolveJob(db, q)
  if (!ref) throw new Error(`no job matches "${q}" — a name from \`lore jobs\`, a bridge id, the daemon's id, or a session id`)
  const now = opts.now ?? Date.now()
  const deep = opts.deep ?? 300_000
  const laneCap = opts.lanes ?? 12
  const own = jobsRowOf(db, ref.key)
  const sessions = sessionsOf(db, ref.key)
  const span = spanOf(db, ref.key)

  // The live side: the roster, each row keyed to its job through its live
  // session (jobsOfSessions) or its daemon id (the jobs row).
  const live = opts.live ?? (await roster(db))
  const byKey = new Map<string, AgentRow>()
  const byId = new Map<string, AgentRow>()
  const keyed = jobsOfSessions(db, live.rows.map((r) => r.sessionId).filter((s): s is string => s != null))
  for (const r of live.rows) {
    const k = r.sessionId ? keyed.get(r.sessionId)?.key : undefined
    if (k && !byKey.has(k)) byKey.set(k, r)
    if (r.id && !byId.has(r.id)) byId.set(r.id, r)
  }
  const me = byKey.get(ref.key) ?? (own ? byId.get(own.jobId) : undefined) ?? null
  const state = me?.id ? (live.states.get(me.id) ?? null) : null
  const cwd = me?.cwd ?? own?.cwd ?? null

  // The window, as instants. A closed one is measured to its end, not to now.
  const since = opts.since ? dayStart(opts.since) : null
  const until = opts.until ? dayStart(opts.until) : null
  const clock = until ? Date.parse(until) : now

  // The lanes: the jobs this one spawned (the edges in its own sessions'
  // transcripts), those of the window by spawn instant, plus any still
  // live. Each lane is a whole job: its sessions, its fee inside the window.
  // The edges are the WHOLE index's, where the first spawn of a job wins:
  // read one session at a time, any answer naming another job's ref made
  // that job a child. And a job's own PARENT is never its lane: a commander
  // and its steer each end on `ccc clear <the other> --then …`, so each
  // reads as the other's spawn, and a steer was once listed as a 33-day-old
  // live lane and billed for the pass.
  const edges = spawnEdges(db)
  const parent = edges.get(ref.key)?.key ?? null
  const spawnedAt = new Map<string, string | null>()
  for (const [k, e] of edges) if (e.key === ref.key && k !== parent) spawnedAt.set(k, e.ts)
  const allLanes: LoopLane[] = [...spawnedAt]
    .map(([key, at]): LoopLane => {
      const jr = jobsRowOf(db, key)
      const r = byKey.get(key) ?? (jr ? byId.get(jr.jobId) : undefined) ?? null
      const lsp = spanOf(db, key)
      const laneSessions = sessionsOf(db, key)
      const fee = feeOf(db, laneSessions, since ?? undefined, until ?? undefined)
      const peak = peakOf(db, laneSessions, since ?? undefined, until ?? undefined)
      const live = r != null && LIVE.has(r.state)
      const ctx = r?.ctx ?? null
      const spawned = iso(at ?? lsp.first)
      return {
        key,
        name: jr?.name ?? r?.name ?? null,
        state: r?.state ?? jr?.state ?? null,
        live,
        model: r?.model ?? dominantModel(fee.models),
        spawnedAt: spawned,
        ageMs: spawned ? clock - Date.parse(spawned) : null,
        ctx,
        peak,
        deep: live && ctx != null ? ctx >= deep : peak != null && peak >= deep,
        requests: fee.requests,
        listUsd: fee.listUsd,
        last: lsp.last,
      }
    })
    .filter((l) => (l.live && !until) || !since || (l.spawnedAt != null && l.spawnedAt >= since && (!until || l.spawnedAt <= until)))
    .sort((a, b) => Number(b.live) - Number(a.live) || (b.spawnedAt ?? '').localeCompare(a.spawnedAt ?? ''))
  const lanes = allLanes.slice(0, laneCap)

  const running = (state?.fan ?? []).filter((f) => f.doneAt == null).map((f) => ({ kind: f.kind ?? null, label: f.label ?? null, since: iso(f.startedAt ?? null) }))

  // The fee inside the window: the job's own sessions, and its lanes'
  // (whole jobs); the whole job when there is no window.
  const ownFee = feeOf(db, sessions, since ?? undefined, until ?? undefined)
  const jobUsd = sessions.length ? ownFee.listUsd : null
  const laneUsd = allLanes.length ? (allLanes.every((l) => l.listUsd != null) ? round2(allLanes.reduce((n, l) => n + (l.listUsd ?? 0), 0)) : null) : 0
  const totalUsd = jobUsd == null || laneUsd == null ? null : round2(jobUsd + laneUsd)

  return {
    asOf: new Date(now).toISOString(),
    job: {
      key: ref.key,
      name: own?.name ?? me?.name ?? null,
      jobId: me?.id ?? own?.jobId ?? null,
      state: me?.state ?? own?.state ?? null,
      tempo: me?.tempo ?? null,
      detail: me?.detail ?? null,
      cwd,
      sessionId: me?.sessionId ?? sessions.at(-1) ?? null,
      model: me?.model ?? dominantModel(ownFee.models),
      ctx: me?.ctx ?? null,
      startedAt: me?.startedAt ?? span.first,
      updatedAt: me?.updatedAt ?? null,
      sessions: span.n,
      indexedUntil: span.last,
    },
    window: { since, until },
    running,
    lanes,
    lanesTotal: allLanes.length,
    spend: { jobUsd, laneUsd, totalUsd },
    spoke: {
      lastPrompt: lastTs(db, sessions, "lane = 'prompt' AND type = 'user'"),
      lastText: lastTs(db, sessions, "lane = 'text'"),
      lastSent: lastTs(db, sessions, "lane = 'tool' AND type = 'assistant' AND tool_name = 'SendMessage'"),
    },
  }
}

// The roster and the state files behind it, read once per call.
async function roster(db: Database): Promise<{ rows: AgentRow[]; states: Map<string, JobState | null> }> {
  let rows: AgentRow[] = []
  try {
    rows = await listAgents(db)
  } catch {
    // No daemon (or `claude agents` failed): the live side is empty and
    // every live field reads null — the ledger side still answers.
    rows = []
  }
  const states = new Map<string, JobState | null>()
  await Promise.all(rows.map(async (r) => r.id && states.set(r.id, await readJobState(r.id))))
  return { rows, states }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
