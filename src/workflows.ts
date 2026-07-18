import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

// The workflow observatory (companion to spawns.ts): every Workflow run
// persists <session>/workflows/wf_<runId>.json — runId, timestamp (written at
// completion), taskId, and the FULL script, whose leading `export const meta`
// literal self-describes the run (name, description, declared phases). One
// row per run; the agents live in spawns tagged with workflow_run_id, so the
// per-run cost/model rollups here are joins, not re-parses.

const RunJson = z.object({
  runId: z.string(),
  timestamp: z.string().nullish(),
  taskId: z.string().nullish(),
  script: z.string(),
})

const Phase = z.object({ title: z.string(), detail: z.string().optional() })
export type WorkflowMeta = {
  name: string | null
  description: string | null
  phases: z.infer<typeof Phase>[]
}

// Slice a balanced {...} or [...] from src starting at `open`, tracking quote
// state so braces inside string literals don't miscount.
function sliceBalanced(src: string, open: number): string | null {
  const openCh = src[open]
  const closeCh = openCh === '{' ? '}' : ']'
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === openCh) depth++
    else if (ch === closeCh && --depth === 0) return src.slice(open, i + 1)
  }
  return null
}

function strField(block: string, key: string): string | null {
  const m = block.match(new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`))
  return m?.[2] ?? null
}

// The meta block is contractually a pure object literal at the top of the
// script; headline fields come out via the brace matcher + field regexes —
// transcript-derived JS is data, never evaluated. Best-effort by design: a
// harness format drift degrades to null fields, never a failed index (the
// script itself is stored verbatim either way).
export function extractMeta(script: string): WorkflowMeta {
  const at = script.indexOf('export const meta')
  const braceAt = at >= 0 ? script.indexOf('{', at) : -1
  const block = braceAt >= 0 ? sliceBalanced(script, braceAt) : null
  if (!block) return { name: null, description: null, phases: [] }

  let phasesBlock: string | null = null
  const phases: z.infer<typeof Phase>[] = []
  const pAt = block.search(/\bphases\s*:/)
  if (pAt >= 0) {
    const bracketAt = block.indexOf('[', pAt)
    phasesBlock = bracketAt >= 0 ? sliceBalanced(block, bracketAt) : null
    if (phasesBlock) {
      for (let i = phasesBlock.indexOf('{'); i >= 0; i = phasesBlock.indexOf('{', i)) {
        const entry = sliceBalanced(phasesBlock, i)
        if (!entry) break
        const title = strField(entry, 'title')
        const detail = strField(entry, 'detail')
        if (title !== null) phases.push({ title, ...(detail !== null ? { detail } : {}) })
        i += entry.length
      }
    }
  }
  // name/description read from meta minus the phases block, so a phase's own
  // fields can never shadow the top-level ones.
  const head = phasesBlock ? block.replace(phasesBlock, '') : block
  return { name: strField(head, 'name'), description: strField(head, 'description'), phases }
}

type RunFile = { wellDir: string; sessionId: string; path: string; size: number; mtimeMs: number }

export type WorkflowIndexStats = {
  runFiles: number
  runsIndexed: number
  runsSkipped: number
  durationMs: number
}

function scanRunFiles(projectsDir: string): RunFile[] {
  if (!existsSync(projectsDir)) return []
  const files: RunFile[] = []
  for (const well of readdirSync(projectsDir)) {
    const wellPath = join(projectsDir, well)
    let entries: string[]
    try {
      entries = readdirSync(wellPath)
    } catch {
      continue
    }
    for (const entry of entries) {
      const wfDir = join(wellPath, entry, 'workflows')
      if (!existsSync(wfDir)) continue
      for (const f of readdirSync(wfDir)) {
        if (!f.startsWith('wf_') || !f.endsWith('.json')) continue
        const path = join(wfDir, f)
        const st = statSync(path)
        files.push({ wellDir: well, sessionId: entry, path, size: st.size, mtimeMs: st.mtimeMs })
      }
    }
  }
  return files
}

export async function indexWorkflowRuns(
  db: Database,
  opts: { projectsDir: string; full?: boolean },
): Promise<WorkflowIndexStats> {
  const started = performance.now()
  const files = scanRunFiles(opts.projectsDir)

  const findRun = db.prepare('SELECT size, mtime_ms FROM workflow_runs WHERE run_id = ?')
  const Existing = z.object({ size: z.number(), mtime_ms: z.number() }).nullish()
  const upsert = db.prepare(
    `INSERT INTO workflow_runs(run_id, well_dir, session_id, name, description, phases, task_id, script, recorded_ts, size, mtime_ms)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET well_dir=excluded.well_dir, session_id=excluded.session_id, name=excluded.name,
       description=excluded.description, phases=excluded.phases, task_id=excluded.task_id, script=excluded.script,
       recorded_ts=excluded.recorded_ts, size=excluded.size, mtime_ms=excluded.mtime_ms`,
  )

  let runsIndexed = 0
  let runsSkipped = 0

  for (const f of files) {
    let run: z.infer<typeof RunJson>
    try {
      run = RunJson.parse(JSON.parse(await Bun.file(f.path).text()))
    } catch {
      continue // torn/foreign json — never aborts the scan
    }
    const existing = Existing.parse(findRun.get(run.runId))
    if (!opts.full && existing && existing.size === f.size && existing.mtime_ms === f.mtimeMs) {
      runsSkipped++
      continue
    }
    const meta = extractMeta(run.script)
    upsert.run(
      run.runId,
      f.wellDir,
      f.sessionId,
      meta.name,
      meta.description,
      meta.phases.length ? JSON.stringify(meta.phases) : null,
      run.taskId ?? null,
      run.script,
      run.timestamp ?? null,
      f.size,
      f.mtimeMs,
    )
    runsIndexed++
  }

  return {
    runFiles: files.length,
    runsIndexed,
    runsSkipped,
    durationMs: Math.round(performance.now() - started),
  }
}

const Row = z.object({
  runId: z.string(),
  well: z.string(),
  sessionId: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  phases: z.string().nullable(),
  taskId: z.string().nullable(),
  agents: z.number(),
  outputTokens: z.number().nullable(),
  bootTokens: z.number().nullable(),
  bootReusePct: z.number().nullable(),
  models: z.string().nullable(),
  drift: z.number(),
  first: z.string().nullable(),
  durationMs: z.number().nullable(),
})
export type WorkflowRunRow = Omit<z.infer<typeof Row>, 'phases'> & { phases: z.infer<typeof Phase>[] }

export type WorkflowNameSummary = {
  name: string | null
  n: number
  avgAgents: number | null
  avgOutputTokens: number | null
  bootReusePct: number | null
}

// Run rows newest-first plus the byName rollup — the catalog: which workflows
// exist (same meta.name across runs = same workflow evolving), how often they
// run, what a run costs. Cost/model columns join from spawns, so they carry
// the observatory's guarantees: verified models, `drift` counts agents whose
// served model doesn't contain the requested alias.
export function listWorkflowRuns(
  db: Database,
  opts: { well?: string; exact?: boolean; name?: string; since?: string; limit: number },
): { runs: WorkflowRunRow[]; byName: WorkflowNameSummary[] } {
  const where: string[] = []
  const params: (string | number)[] = []
  if (opts.well) {
    where.push(opts.exact ? '(r.well_dir = ? OR w.real_path = ?)' : '(r.well_dir LIKE ? OR w.real_path LIKE ?)')
    const v = opts.exact ? opts.well : `%${opts.well}%`
    params.push(v, v)
  }
  if (opts.name) {
    where.push('r.name LIKE ?')
    params.push(`%${opts.name}%`)
  }
  if (opts.since) {
    where.push('r.recorded_ts >= ?')
    params.push(opts.since)
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const base = `
    FROM workflow_runs r
    LEFT JOIN wells w ON w.dir = r.well_dir
    LEFT JOIN spawns s ON s.workflow_run_id = r.run_id
    ${whereClause}`
  const reuse = `CAST(ROUND(100.0 * SUM(s.boot_cached) / NULLIF(SUM(s.boot_tokens), 0)) AS INTEGER)`
  const sql = `
    SELECT r.run_id AS runId, r.well_dir AS well, r.session_id AS sessionId, r.name, r.description,
           r.phases, r.task_id AS taskId,
           COUNT(s.id) AS agents,
           SUM(s.output_tokens) AS outputTokens,
           SUM(s.boot_tokens) AS bootTokens,
           ${reuse} AS bootReusePct,
           GROUP_CONCAT(DISTINCT s.model) AS models,
           SUM(CASE WHEN s.requested_model IS NOT NULL AND s.model IS NOT NULL
                     AND instr(s.model, s.requested_model) = 0 THEN 1 ELSE 0 END) AS drift,
           COALESCE(MIN(s.first_ts), r.recorded_ts) AS first,
           CAST(ROUND((julianday(MAX(s.last_ts)) - julianday(MIN(s.first_ts))) * 86400000) AS INTEGER) AS durationMs
    ${base}
    GROUP BY r.id
    ORDER BY first DESC LIMIT ?`
  const runs = z
    .array(Row)
    .parse(db.prepare(sql).all(...params, opts.limit))
    .map((r) => ({ ...r, phases: r.phases ? z.array(Phase).parse(JSON.parse(r.phases)) : [] }))
  const summarySql = `
    WITH per_run AS (
      SELECT r.id, r.name, COUNT(s.id) AS agents, SUM(s.output_tokens) AS out,
             SUM(s.boot_tokens) AS boot, SUM(s.boot_cached) AS cached
      ${base}
      GROUP BY r.id
    )
    SELECT name, COUNT(*) AS n,
           CAST(AVG(agents) AS INTEGER) AS avgAgents,
           CAST(AVG(out) AS INTEGER) AS avgOutputTokens,
           CAST(ROUND(100.0 * SUM(cached) / NULLIF(SUM(boot), 0)) AS INTEGER) AS bootReusePct
    FROM per_run GROUP BY name ORDER BY n DESC`
  const byName = z
    .array(
      z.object({
        name: z.string().nullable(),
        n: z.number(),
        avgAgents: z.number().nullable(),
        avgOutputTokens: z.number().nullable(),
        bootReusePct: z.number().nullable(),
      }),
    )
    .parse(db.prepare(summarySql).all(...params))
  return { runs, byName }
}
