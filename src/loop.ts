import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { $ } from 'bun'
import { z } from 'zod'
import { type AgentRow, iso, type JobState, listAgents, readJobState } from './agents'
import { JOB_KEY_SQL, type JobRef, jobsOfSessions, resolveJob, spawnEdges } from './job'
import { dominantModel } from './model'
import { listUsage } from './usage'

// One unattended loop, read as numbers (the attrition commander, 2026-10-15).
//
// A peek at a running loop asks five things — is it alive, did the number
// move, how far into the tranche, what are the lanes doing, what has it
// cost — and every answer was already on disk, written by someone other
// than the model: the daemon's state.json (`detail`, `tempo`, the running
// shells in `fan`), the queue file the loop rewrites at each booking (the
// tranche's base commit and its scoreboard), `git log` from that base (the
// landings), the roster (each lane's state and context), and lore's own
// ledger (the spawn edges, the fee). Nobody computed them together: the
// recap narrated "+184 this tranche" by hand, and nothing anywhere said how
// long since the last landing. This verb is that computation, zero model,
// so a band or a page can poll it and the commander writes nothing new.
//
// Two of the readings are a loop's own grammar, not the harness's, and are
// options with attrition's spellings as defaults: a LANDING is a
// first-parent commit whose subject matches `--landing` (`^Book `: the
// booking commit after each merge — 186 commits, 33 merges and 19 bookings
// stood between one base and HEAD, and only the last is the count the queue
// states), and the queue file (`--queue docs/QUEUE.md`) names the base in
// its opening line (``from `<sha>` ``) and carries score lines of the form
// `Name: label 5499 of 6,822 · label 1851/1850`. A repo that keeps neither
// still gets the job, the lanes, the running shells and the fee; `tranche`
// and `score` are null and empty, never guessed.
//
// Built to be polled, so it reads narrowly: `listJobs` folds the fee of
// every session in the index to answer for one key (500 ms, and the first
// cut called it twice); this folds the fee of the job's own sessions and
// its lanes' since the base, and the spawn edges of the job's sessions
// alone. The roster (`claude agents`, plus a tail read per live transcript
// for the context) is the one cost that stays, the same one `lore agents`
// pays.

const LANE_ITEM = /(\d+)/
const BASE_IN_QUEUE = /\bfrom `([0-9a-f]{7,40})`/
const TRANCHE_LABEL = /\*\*(the [\w-]+ tranche)\b/
const SCORE_LINE = /^([A-Z][A-Za-z ]+):\s+(.+)$/
// `label 5499 of 6,822`, `label w5499 of 6,822`, `label 1851/1850`.
const OF = /([A-Za-z][\w-]*)\s+w?(\d[\d,]*)\s+of\s+(\d[\d,]*)/g
const SLASH = /([A-Za-z][\w-]*)\s+(\d[\d,]*)\/(\d[\d,]*)\b/g
const LIVE = new Set(['working', 'blocked'])

export type LoopLane = {
  key: string
  name: string | null
  // The item number in the lane's name (`att-2761` → 2761); null when none.
  item: number | null
  // The daemon's state now when it lists the lane, else the last indexed.
  state: string | null
  live: boolean
  model: string | null
  spawnedAt: string | null
  ageMs: number | null
  // The context the lane's next turn carries (agents.ts), and whether it
  // is past `deep` — the threshold the loop asks a lane to clear at.
  ctx: number | null
  deep: boolean
  requests: number
  listUsd: number | null
  last: string | null
}

export type ScoreItem = { label: string; value: number; of: number | null; open: number | null; delta: number | null }
export type ScoreLine = { line: string; items: ScoreItem[] }

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
  tranche: {
    label: string | null
    base: string
    baseAt: string | null
    landings: number
    of: number
    first: string | null
    last: string | null
    sinceLastMs: number | null
    perHour: number | null
    // Time to `of` landings at the tranche's own rate; null at the rate's
    // zero or once there.
    etaMs: number | null
    merges: number
    commits: number
  } | null
  score: ScoreLine[]
  gate: { running: boolean; since: string | null; label: string | null } | null
  running: { kind: string | null; label: string | null; since: string | null }[]
  lanes: LoopLane[]
  spend: { jobUsd: number | null; laneUsd: number | null; totalUsd: number | null; perLanding: number | null }
  spoke: { lastPrompt: string | null; lastText: string | null; lastSent: string | null }
}

export type LoopOpts = {
  base?: string
  queue?: string
  landing?: string
  of?: number
  deep?: number
  lanes?: number
  now?: number
  // The live side, injected by a test: the roster and each job's state.
  live?: { rows: AgentRow[]; states: Map<string, JobState | null> }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  const r = await $`git -C ${cwd} ${args}`.quiet().nothrow()
  return r.exitCode === 0 ? r.text() : null
}

function num(s: string): number {
  return Number(s.replace(/,/g, ''))
}

// The score lines of a queue file, with their numeric items.
export function parseScore(text: string): ScoreLine[] {
  const out: ScoreLine[] = []
  for (const raw of text.split('\n')) {
    const m = SCORE_LINE.exec(raw.trim())
    if (!m?.[1] || !m[2]) continue
    const items: ScoreItem[] = []
    for (const t of m[2].matchAll(OF)) if (t[1] && t[2] && t[3]) items.push({ label: t[1], value: num(t[2]), of: num(t[3]), open: null, delta: null })
    for (const t of m[2].matchAll(SLASH)) if (t[1] && t[2] && t[3]) items.push({ label: t[1], value: num(t[2]), of: num(t[3]), open: null, delta: null })
    if (items.length) out.push({ line: m[1], items })
  }
  return out
}

// The same lines at the tranche's base, folded in as `open` and `delta`.
export function diffScore(now: ScoreLine[], open: ScoreLine[]): ScoreLine[] {
  const at = new Map(open.flatMap((l) => l.items.map((i) => [`${l.line}\t${i.label}`, i.value] as const)))
  return now.map((l) => ({
    line: l.line,
    items: l.items.map((i) => {
      const o = at.get(`${l.line}\t${i.label}`) ?? null
      return { ...i, open: o, delta: o == null ? null : i.value - o }
    }),
  }))
}

export function parseQueueHead(text: string): { label: string | null; base: string | null } {
  return { label: TRANCHE_LABEL.exec(text)?.[1] ?? null, base: BASE_IN_QUEUE.exec(text)?.[1] ?? null }
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

// The fee of a set of sessions from an instant: requests, list price, and
// the models that served them.
function feeOf(db: Database, sessions: string[], since: string | undefined): { requests: number; listUsd: number | null; models: { model: string; requests: number }[] } {
  if (sessions.length === 0) return { requests: 0, listUsd: 0, models: [] }
  const u = listUsage(db, { by: 'session', sessions, since, limit: 100_000, split: true })
  const models = new Map<string, number>()
  for (const r of u.rows) for (const m of r.models ?? []) models.set(m.model, (models.get(m.model) ?? 0) + m.requests)
  return {
    requests: u.totals.requests,
    listUsd: u.totals.listUsd,
    models: [...models].map(([model, requests]) => ({ model, requests })).sort((a, b) => b.requests - a.requests),
  }
}

export async function getLoop(db: Database, q: string, opts: LoopOpts = {}): Promise<Loop> {
  const ref: JobRef | null = resolveJob(db, q)
  if (!ref) throw new Error(`no job matches "${q}" — a name from \`lore jobs\`, a bridge id, the daemon's id, or a session id`)
  const now = opts.now ?? Date.now()
  const of = opts.of ?? 20
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

  // The tranche: the base named by the queue (or `--base`), and the
  // landings from it on the first-parent line.
  let tranche: Loop['tranche'] = null
  let score: ScoreLine[] = []
  const queueRel = opts.queue ?? 'docs/QUEUE.md'
  const queuePath = cwd ? join(cwd, queueRel) : null
  const queueText = queuePath && existsSync(queuePath) ? await Bun.file(queuePath).text() : null
  const head = queueText ? parseQueueHead(queueText) : { label: null, base: null }
  const base = opts.base ?? head.base
  if (queueText) score = parseScore(queueText)
  if (cwd && base) {
    const landing = new RegExp(opts.landing ?? '^Book ')
    const [log, baseAtRaw, open] = await Promise.all([
      git(cwd, ['log', '--first-parent', '--format=%H%x09%cI%x09%P%x09%s', `${base}..HEAD`]),
      git(cwd, ['show', '-s', '--format=%cI', base]),
      queueText ? git(cwd, ['show', `${base}:${queueRel}`]) : Promise.resolve(null),
    ])
    if (log != null) {
      const rows = log
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('\t'))
        .map(([, at, parents, subject]) => ({ at: iso(at ?? null), merge: (parents ?? '').split(' ').length > 1, subject: subject ?? '' }))
      const landings = rows.filter((r) => landing.test(r.subject))
      const first = landings.at(-1)?.at ?? null
      const last = landings[0]?.at ?? null
      const baseAt = iso(baseAtRaw?.trim() ?? null)
      const hours = baseAt ? (now - Date.parse(baseAt)) / 3_600_000 : null
      const perHour = hours && hours > 0 ? round2(landings.length / hours) : null
      const left = of - landings.length
      tranche = {
        label: head.label,
        base,
        baseAt,
        landings: landings.length,
        of,
        first,
        last,
        sinceLastMs: last ? now - Date.parse(last) : null,
        perHour,
        etaMs: perHour && left > 0 ? Math.round((left / perHour) * 3_600_000) : null,
        merges: rows.filter((r) => r.merge).length,
        commits: rows.length,
      }
      if (open != null) score = diffScore(score, parseScore(open))
    }
  }
  const baseAt = tranche?.baseAt ?? null
  const since = baseAt ?? undefined

  // The lanes: the jobs this one spawned (the edges in its own sessions'
  // transcripts), those of this tranche by spawn instant, plus any still
  // live. Each lane is a whole job: its sessions, its fee since the base.
  const spawnedAt = new Map<string, string | null>()
  for (const sid of sessions) for (const [k, e] of spawnEdges(db, { sessionId: sid })) if (e.key === ref.key && !spawnedAt.has(k)) spawnedAt.set(k, e.ts)
  const lanes: LoopLane[] = [...spawnedAt]
    .map(([key, at]): LoopLane => {
      const jr = jobsRowOf(db, key)
      const r = byKey.get(key) ?? (jr ? byId.get(jr.jobId) : undefined) ?? null
      const lsp = spanOf(db, key)
      const fee = feeOf(db, sessionsOf(db, key), since)
      const ctx = r?.ctx ?? null
      const name = jr?.name ?? r?.name ?? null
      const item = LANE_ITEM.exec(name ?? '')?.[1]
      const spawned = iso(at ?? lsp.first)
      return {
        key,
        name,
        item: item == null ? null : Number(item),
        state: r?.state ?? jr?.state ?? null,
        live: r != null && LIVE.has(r.state),
        model: r?.model ?? dominantModel(fee.models),
        spawnedAt: spawned,
        ageMs: spawned ? now - Date.parse(spawned) : null,
        ctx,
        deep: ctx != null && ctx >= deep,
        requests: fee.requests,
        listUsd: fee.listUsd,
        last: lsp.last,
      }
    })
    .filter((l) => l.live || !baseAt || (l.spawnedAt != null && l.spawnedAt >= baseAt))
    .sort((a, b) => Number(b.live) - Number(a.live) || (b.spawnedAt ?? '').localeCompare(a.spawnedAt ?? ''))
    .slice(0, laneCap)

  // What is running under the job now: the daemon's `fan`, the gate first.
  const fan = (state?.fan ?? []).map((f) => ({ kind: f.kind ?? null, label: f.label ?? null, since: iso(f.startedAt ?? null), done: f.doneAt != null }))
  const running = fan.filter((f) => !f.done).map(({ kind, label, since }) => ({ kind, label, since }))
  const gateRun = fan.find((f) => !f.done && /gate/i.test(f.label ?? ''))
  const gateLast = fan.find((f) => /gate/i.test(f.label ?? ''))
  const gate = gateRun ? { running: true, since: gateRun.since, label: gateRun.label } : gateLast ? { running: false, since: null, label: gateLast.label } : null

  // The fee since the base: the job's own sessions, and its lanes' (whole
  // jobs, each inside the tranche); the whole job when there is no base.
  const ownFee = feeOf(db, sessions, since)
  const jobUsd = sessions.length ? ownFee.listUsd : null
  const laneUsd = lanes.length ? (lanes.every((l) => l.listUsd != null) ? round2(lanes.reduce((n, l) => n + (l.listUsd ?? 0), 0)) : null) : 0
  const totalUsd = jobUsd == null || laneUsd == null ? null : round2(jobUsd + laneUsd)
  const landings = tranche?.landings ?? 0

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
    tranche,
    score,
    gate,
    running,
    lanes,
    spend: { jobUsd, laneUsd, totalUsd, perLanding: totalUsd != null && landings > 0 ? round2(totalUsd / landings) : null },
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
