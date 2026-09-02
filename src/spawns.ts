import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { modelDrift } from './model'

// The spawn observatory (lore#5): every subagent leaves a transcript at
// <projectsDir>/<well>/<sessionId>/subagents/agent-<id>.jsonl plus a
// meta.json. Workflow-orchestrated agents nest one level deeper —
// subagents/workflows/wf_<runId>/agent-<id>.jsonl — and index as ordinary
// spawn rows tagged with that workflow_run_id (the join key for the per-run
// rollups in workflows.ts). Indexed, they answer the fan-out doctrine's
// questions as a query instead of hand-spelunked jq: which model ACTUALLY
// served the spawn (first-request `message.model` — the spawn parameter and
// completion notification are never trusted), what the boot envelope cost,
// and what the run totaled. Assistant records are streaming snapshots —
// several lines per API request sharing one `message.id` — so requests
// dedupe by that id.

const Meta = z.object({
  agentType: z.string().nullish(),
  description: z.string().nullish(),
  spawnDepth: z.number().nullish(),
  model: z.string().nullish(),
})

const Usage = z.object({
  input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
})

const AssistantRecord = z.object({
  type: z.literal('assistant'),
  timestamp: z.string().nullish(),
  message: z.object({
    id: z.string().nullish(),
    model: z.string().nullish(),
    usage: Usage.nullish(),
    stop_reason: z.string().nullish(),
    content: z
      .array(z.object({ type: z.string() }).loose())
      .nullish(),
  }),
})

// A finished spawn's last assistant record carries a terminal stop_reason.
// Without one the transcript is mid-flight OR the terminal usage update never
// landed (observed 2026-07-24: a final record held 22k chars of content but
// output_tokens 6 and stop_reason null — the harness reported ~71.7k for the
// same spawn). Either way the token totals are a floor, not a measurement, and
// silently reporting them as fact corrupts the fan-out ledger.
const TERMINAL_STOP = new Set(['end_turn', 'stop_sequence', 'max_tokens'])

type SpawnFile = {
  wellDir: string
  sessionId: string
  agentId: string
  path: string
  metaPath: string
  size: number
  mtimeMs: number
  workflowRunId: string | null
}

export type SpawnIndexStats = {
  spawnFiles: number
  spawnsIndexed: number
  spawnsSkipped: number
  durationMs: number
}

function scanSpawnFiles(projectsDir: string): SpawnFile[] {
  if (!existsSync(projectsDir)) return []
  const files: SpawnFile[] = []
  for (const well of readdirSync(projectsDir)) {
    const wellPath = join(projectsDir, well)
    let entries: string[]
    try {
      entries = readdirSync(wellPath)
    } catch {
      continue
    }
    for (const entry of entries) {
      const subDir = join(wellPath, entry, 'subagents')
      if (!existsSync(subDir)) continue
      const collect = (dir: string, workflowRunId: string | null) => {
        for (const f of readdirSync(dir)) {
          if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue
          const path = join(dir, f)
          const st = statSync(path)
          files.push({
            wellDir: well,
            sessionId: entry,
            agentId: f.slice('agent-'.length, -'.jsonl'.length),
            path,
            metaPath: join(dir, f.replace(/\.jsonl$/, '.meta.json')),
            size: st.size,
            mtimeMs: st.mtimeMs,
            workflowRunId,
          })
        }
      }
      collect(subDir, null)
      // Workflow-orchestrated agents: subagents/workflows/wf_<runId>/agent-*.jsonl
      const wfDir = join(subDir, 'workflows')
      if (!existsSync(wfDir)) continue
      for (const run of readdirSync(wfDir)) {
        if (!run.startsWith('wf_')) continue
        collect(join(wfDir, run), run)
      }
    }
  }
  return files
}

export async function indexSpawns(
  db: Database,
  opts: { projectsDir: string; full?: boolean },
): Promise<SpawnIndexStats> {
  const started = performance.now()
  const files = scanSpawnFiles(opts.projectsDir)

  const findSpawn = db.prepare('SELECT size, mtime_ms FROM spawns WHERE agent_id = ?')
  const Existing = z.object({ size: z.number(), mtime_ms: z.number() }).nullish()
  const upsert = db.prepare(
    `INSERT INTO spawns(well_dir, session_id, agent_id, agent_type, description, spawn_depth, requested_model,
       model, boot_tokens, boot_cached, requests, output_tokens, tool_uses, first_ts, last_ts, size, mtime_ms, workflow_run_id,
       last_stop_reason)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET well_dir=excluded.well_dir, session_id=excluded.session_id, agent_type=excluded.agent_type,
       description=excluded.description, spawn_depth=excluded.spawn_depth, requested_model=excluded.requested_model,
       model=excluded.model, boot_tokens=excluded.boot_tokens, boot_cached=excluded.boot_cached, requests=excluded.requests,
       output_tokens=excluded.output_tokens, tool_uses=excluded.tool_uses, first_ts=excluded.first_ts,
       last_ts=excluded.last_ts, size=excluded.size, mtime_ms=excluded.mtime_ms, workflow_run_id=excluded.workflow_run_id,
       last_stop_reason=excluded.last_stop_reason`,
  )

  let spawnsIndexed = 0
  let spawnsSkipped = 0

  for (const f of files) {
    const existing = Existing.parse(findSpawn.get(f.agentId))
    if (!opts.full && existing && existing.size === f.size && existing.mtime_ms === f.mtimeMs) {
      spawnsSkipped++
      continue
    }

    let meta: z.infer<typeof Meta> = {}
    if (existsSync(f.metaPath)) {
      try {
        meta = Meta.parse(JSON.parse(await Bun.file(f.metaPath).text()))
      } catch {
        // malformed meta — index the transcript side anyway
      }
    }

    let model: string | null = null
    let bootTokens: number | null = null
    let bootCached: number | null = null
    let firstTs: string | null = null
    let lastTs: string | null = null
    let toolUses = 0
    let lastStopReason: string | null = null
    // Per-request bookkeeping: streaming snapshots repeat usage, so keep the
    // max output_tokens seen per message.id and sum at the end.
    const outputByRequest = new Map<string, number>()

    for (const line of (await Bun.file(f.path).text()).split('\n')) {
      if (!line.trim()) continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        continue // torn tail write — the file is appended live
      }
      const ts = z.object({ timestamp: z.string().nullish() }).loose().safeParse(raw)
      if (ts.success && ts.data.timestamp) {
        firstTs ??= ts.data.timestamp
        lastTs = ts.data.timestamp
      }
      const rec = AssistantRecord.safeParse(raw)
      if (!rec.success) continue
      const msg = rec.data.message
      const reqId = msg.id ?? `line-${outputByRequest.size}`
      if (!outputByRequest.has(reqId)) {
        // First snapshot of the first request carries the boot envelope.
        if (outputByRequest.size === 0) {
          model = msg.model ?? null
          const u = msg.usage
          bootTokens = u
            ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
            : null
          bootCached = u ? (u.cache_read_input_tokens ?? 0) : null
        }
        outputByRequest.set(reqId, 0)
      }
      const out = msg.usage?.output_tokens ?? 0
      if (out > (outputByRequest.get(reqId) ?? 0)) outputByRequest.set(reqId, out)
      lastStopReason = msg.stop_reason ?? null
      for (const block of msg.content ?? []) if (block.type === 'tool_use') toolUses++
    }

    let outputTokens = 0
    for (const v of outputByRequest.values()) outputTokens += v

    upsert.run(
      f.wellDir,
      f.sessionId,
      f.agentId,
      meta.agentType ?? null,
      meta.description ?? null,
      meta.spawnDepth ?? null,
      meta.model ?? null,
      model,
      bootTokens,
      bootCached,
      outputByRequest.size,
      outputTokens,
      toolUses,
      firstTs,
      lastTs,
      f.size,
      f.mtimeMs,
      f.workflowRunId,
      lastStopReason,
    )
    spawnsIndexed++
  }

  return {
    spawnFiles: files.length,
    spawnsIndexed,
    spawnsSkipped,
    durationMs: Math.round(performance.now() - started),
  }
}

const Row = z.object({
  well: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  agentType: z.string().nullable(),
  description: z.string().nullable(),
  requestedModel: z.string().nullable(),
  model: z.string().nullable(),
  bootTokens: z.number().nullable(),
  bootCached: z.number().nullable(),
  requests: z.number(),
  outputTokens: z.number(),
  toolUses: z.number(),
  first: z.string().nullable(),
  durationMs: z.number().nullable(),
  workflowRunId: z.string().nullable(),
  lastStopReason: z.string().nullable(),
})
export type SpawnRow = Omit<z.infer<typeof Row>, 'lastStopReason'> & {
  drift?: boolean
  telemetryPartial?: true
  lastStopReason?: string | null
}

export type SpawnSummary = {
  agentType: string | null
  n: number
  avgBoot: number | null
  bootReusePct: number | null
  models: string
}

export type SpawnTrendRow = {
  week: string
  agentType: string | null
  n: number
  avgBoot: number | null
  bootReusePct: number | null
}

// The --session guard (09-02, found by ccc reading `count: 0` as an index
// gap). `lore agents` prints a background job's `id` and its `sessionId` as
// sibling fields; the `id` is what a reader copies, and it ALSO resolves as a
// real session — the stub left behind in the base well when `/clear` or
// `/model` re-shards the transcript to a new id. So the wrong one of two
// adjacent ids answers `count: 0`, a plausible number, at exactly the moment
// the fan-out doctrine says to verify a model. A silent wrong answer is worse
// than a 404: on an empty --session, say what the prefix actually resolved to
// and which job-mate holds the spawns.
export type SessionMiss = {
  asked: string
  matched: { sessionId: string; lines: number }[]
  siblings: { sessionId: string; job: string; spawns: number; lines: number }[]
}

const Matched = z.object({ sessionId: z.string(), lines: z.number() })
const Sibling = z.object({ sessionId: z.string(), job: z.string(), spawns: z.number(), lines: z.number() })

function explainSessionMiss(db: Database, asked: string): SessionMiss {
  const like = `${asked}%`
  const matched = z
    .array(Matched)
    .parse(
      db
        .prepare('SELECT session_id AS sessionId, lines FROM sessions WHERE session_id LIKE ? ORDER BY lines DESC LIMIT 5')
        .all(like),
    )
  // A job's sessions are keyed by the id it started with: the root carries no
  // job_session_id, every /clear after it points back at that root. So the job
  // key is COALESCE(job_session_id, session_id) — for an interactive session
  // that is just itself, a singleton job with no mates, which is the right
  // answer for it too.
  const roots = z
    .array(z.object({ job: z.string() }))
    .parse(
      db
        .prepare('SELECT DISTINCT COALESCE(job_session_id, session_id) AS job FROM sessions WHERE session_id LIKE ?')
        .all(like),
    )
    .map((r) => r.job)
  if (!roots.length) return { asked, matched, siblings: [] }
  const siblings = z
    .array(Sibling)
    .parse(
      db
        .prepare(
          `SELECT s.session_id AS sessionId, COALESCE(s.job_session_id, s.session_id) AS job,
                  COUNT(p.id) AS spawns, s.lines
             FROM sessions s JOIN spawns p ON p.session_id = s.session_id
            WHERE COALESCE(s.job_session_id, s.session_id) IN (${roots.map(() => '?').join(',')})
            GROUP BY s.session_id
            ORDER BY spawns DESC, s.lines DESC`,
        )
        .all(...roots),
    )
    .filter((s) => !matched.some((m) => m.sessionId === s.sessionId))
  return { asked, matched, siblings }
}

// Spawn rows newest-first plus two rollups — the observatory's at-a-glance
// answers: byAgentType (which types run, on which verified models, at what
// boot cost, with how much cache reuse) and byWeek (the trend — did a config
// change actually move boot cost). `drift` flags a spawn whose verified model
// doesn't contain the requested alias (e.g. asked "sonnet", served fable) —
// only computable when a model parameter was actually passed.
export function listSpawns(
  db: Database,
  opts: { well?: string; exact?: boolean; agent?: string; since?: string; workflow?: string; session?: string; limit: number },
): {
  spawns: SpawnRow[]
  partialTelemetry: number
  byAgentType: SpawnSummary[]
  byWeek: SpawnTrendRow[]
  sessionMiss?: SessionMiss
} {
  const where: string[] = []
  const params: (string | number)[] = []
  if (opts.well) {
    where.push(opts.exact ? '(p.well_dir = ? OR w.real_path = ?)' : '(p.well_dir LIKE ? OR w.real_path LIKE ?)')
    const v = opts.exact ? opts.well : `%${opts.well}%`
    params.push(v, v)
  }
  if (opts.agent) {
    where.push('p.agent_type = ?')
    params.push(opts.agent)
  }
  if (opts.since) {
    where.push('p.first_ts >= ?')
    params.push(opts.since)
  }
  if (opts.workflow) {
    // Run-id prefix match (run ids are long; `wf_390a` should just work).
    where.push('p.workflow_run_id LIKE ?')
    params.push(`${opts.workflow}%`)
  }
  if (opts.session) {
    // "which agents did THIS session spawn" — id prefix, same ergonomics as
    // `lore session`. Before this, attribution meant --well + --since and
    // hoping only one session sat in the window.
    where.push('p.session_id LIKE ?')
    params.push(`${opts.session}%`)
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const base = `
    FROM spawns p
    LEFT JOIN wells w ON w.dir = p.well_dir
    ${whereClause}`
  const sql = `
    SELECT p.well_dir AS well, p.session_id AS sessionId, p.agent_id AS agentId, p.agent_type AS agentType,
           p.description, p.requested_model AS requestedModel, p.model, p.boot_tokens AS bootTokens,
           p.boot_cached AS bootCached,
           p.requests, p.output_tokens AS outputTokens, p.tool_uses AS toolUses, p.first_ts AS first,
           CAST(ROUND((julianday(p.last_ts) - julianday(p.first_ts)) * 86400000) AS INTEGER) AS durationMs,
           p.workflow_run_id AS workflowRunId, p.last_stop_reason AS lastStopReason
    ${base}
    ORDER BY p.first_ts DESC LIMIT ?`
  const spawns = z
    .array(Row)
    .parse(db.prepare(sql).all(...params, opts.limit))
    .map(({ lastStopReason, ...r }) => ({
      ...r,
      ...(r.requestedModel && r.model ? { drift: modelDrift(r.requestedModel, r.model) === true } : {}),
      // Surfaced only when the run didn't end cleanly — a floor-not-measurement
      // warning plus the reason ('tool_use' = interrupted mid-tool, null = the
      // terminal usage row never landed), not fields to skim past on every
      // healthy row.
      ...(TERMINAL_STOP.has(lastStopReason ?? '') ? {} : { telemetryPartial: true as const, lastStopReason }),
    }))
  // Counted over ALL matches, not just the limited page: a ledger reader needs
  // to know unreliable rows exist even when they fall past the row limit.
  const terminalList = [...TERMINAL_STOP].map((s) => `'${s}'`).join(',')
  const partialTelemetry = z
    .object({ n: z.number() })
    .parse(
      db
        .prepare(
          `SELECT COUNT(*) AS n ${base} ${whereClause ? 'AND' : 'WHERE'}
             (p.last_stop_reason IS NULL OR p.last_stop_reason NOT IN (${terminalList}))`,
        )
        .get(...params),
    ).n
  // Boot cache reuse: what share of the boot envelope was served from cache
  // (0% = full-freight cache write — historically half of all runs).
  const reuse = `CAST(ROUND(100.0 * SUM(p.boot_cached) / NULLIF(SUM(p.boot_tokens), 0)) AS INTEGER)`
  const summarySql = `
    SELECT p.agent_type AS agentType, COUNT(*) AS n,
           CAST(AVG(p.boot_tokens) AS INTEGER) AS avgBoot,
           ${reuse} AS bootReusePct,
           GROUP_CONCAT(DISTINCT p.model) AS models
    ${base}
    GROUP BY p.agent_type ORDER BY n DESC`
  const byAgentType = z
    .array(
      z.object({
        agentType: z.string().nullable(),
        n: z.number(),
        avgBoot: z.number().nullable(),
        bootReusePct: z.number().nullable(),
        models: z.string().nullable(),
      }),
    )
    .parse(db.prepare(summarySql).all(...params))
    .map((r) => ({ ...r, models: r.models ?? '' }))
  // The trend view — lore#6's whole point: boot cost by agentType × ISO week,
  // so config changes (lean profiles, plugin diets) show up as a step.
  const trendSql = `
    SELECT strftime('%Y-W%W', p.first_ts) AS week, p.agent_type AS agentType, COUNT(*) AS n,
           CAST(AVG(p.boot_tokens) AS INTEGER) AS avgBoot,
           ${reuse} AS bootReusePct
    ${base}
    ${whereClause ? 'AND' : 'WHERE'} p.first_ts IS NOT NULL
    GROUP BY week, p.agent_type ORDER BY week, n DESC`
  const byWeek = z
    .array(
      z.object({
        week: z.string(),
        agentType: z.string().nullable(),
        n: z.number(),
        avgBoot: z.number().nullable(),
        bootReusePct: z.number().nullable(),
      }),
    )
    .parse(db.prepare(trendSql).all(...params))
  // Only when --session is the reason nothing came back: a 0-count that no
  // filter explains is a fact about the corpus, not a mis-copied id.
  const sessionMiss = opts.session && !spawns.length ? explainSessionMiss(db, opts.session) : undefined
  return { spawns, partialTelemetry, byAgentType, byWeek, ...(sessionMiss ? { sessionMiss } : {}) }
}
