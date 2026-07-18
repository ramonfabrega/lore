import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

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
    content: z
      .array(z.object({ type: z.string() }).loose())
      .nullish(),
  }),
})

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
       model, boot_tokens, boot_cached, requests, output_tokens, tool_uses, first_ts, last_ts, size, mtime_ms, workflow_run_id)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET well_dir=excluded.well_dir, session_id=excluded.session_id, agent_type=excluded.agent_type,
       description=excluded.description, spawn_depth=excluded.spawn_depth, requested_model=excluded.requested_model,
       model=excluded.model, boot_tokens=excluded.boot_tokens, boot_cached=excluded.boot_cached, requests=excluded.requests,
       output_tokens=excluded.output_tokens, tool_uses=excluded.tool_uses, first_ts=excluded.first_ts,
       last_ts=excluded.last_ts, size=excluded.size, mtime_ms=excluded.mtime_ms, workflow_run_id=excluded.workflow_run_id`,
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
})
export type SpawnRow = z.infer<typeof Row> & { drift?: boolean }

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

// Spawn rows newest-first plus two rollups — the observatory's at-a-glance
// answers: byAgentType (which types run, on which verified models, at what
// boot cost, with how much cache reuse) and byWeek (the trend — did a config
// change actually move boot cost). `drift` flags a spawn whose verified model
// doesn't contain the requested alias (e.g. asked "sonnet", served fable) —
// only computable when a model parameter was actually passed.
export function listSpawns(
  db: Database,
  opts: { well?: string; exact?: boolean; agent?: string; since?: string; workflow?: string; limit: number },
): { spawns: SpawnRow[]; byAgentType: SpawnSummary[]; byWeek: SpawnTrendRow[] } {
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
           p.workflow_run_id AS workflowRunId
    ${base}
    ORDER BY p.first_ts DESC LIMIT ?`
  const spawns = z
    .array(Row)
    .parse(db.prepare(sql).all(...params, opts.limit))
    .map((r) => ({
      ...r,
      ...(r.requestedModel && r.model ? { drift: !r.model.includes(r.requestedModel) } : {}),
    }))
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
  return { spawns, byAgentType, byWeek }
}
