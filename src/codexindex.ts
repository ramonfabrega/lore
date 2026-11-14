import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { CodexLane } from './codex'
import { listRollouts, parseRollout, readImports, readRollout, repoHop, repoKey } from './codex'
import { day, dayStart } from './fmt'
import { ftsMatch } from './fts'

// The Codex adapter's index half (DESIGN.md 2026-11-14): `lore index`'s
// second scanner, and the Codex side of the verbs that take `--source`.
// Codex rows live in `codex_*` tables of their own (db.ts): the source
// dimension is WHICH TABLES a verb reads, so nothing that reads Claude's can
// change by accident — and a schema bump, which rebuilds 3 GB and drops the
// `jobs` rows that have no source, is not spent on it.

export const SOURCES = ['claude', 'codex', 'all'] as const
export type Source = (typeof SOURCES)[number]

export type CodexIndexStats = {
  // Rollouts that are Codex's own, after the exclusion list.
  threads: number
  indexed: number
  skipped: number
  // Left out: Codex's imports of Claude Code transcripts, and files whose
  // session_meta names another thread than their file name does (or one on
  // the exclusion list) — never indexed under either id.
  imported: number
  refused: number
  messages: number
  requests: number
  // Record kinds with no decoder, summed over what was indexed this run: a
  // new Codex writing something lore has not been taught.
  unknown: Record<string, number>
  durationMs: number
}

const Existing = z.object({ size: z.number(), mtime_ms: z.number() }).nullish()

export async function indexCodex(db: Database, opts: { codexHome: string; full?: boolean }): Promise<CodexIndexStats> {
  const started = performance.now()
  const { files, imported } = listRollouts(opts.codexHome)
  const find = db.prepare('SELECT size, mtime_ms FROM codex_threads WHERE thread_id = ?')
  const wipe = [
    db.prepare('DELETE FROM codex_messages_fts WHERE rowid IN (SELECT id FROM codex_messages WHERE thread_id = ?)'),
    db.prepare('DELETE FROM codex_messages WHERE thread_id = ?'),
    db.prepare('DELETE FROM codex_requests WHERE thread_id = ?'),
    db.prepare('DELETE FROM codex_turns WHERE thread_id = ?'),
    db.prepare('DELETE FROM codex_questions WHERE thread_id = ?'),
    db.prepare('DELETE FROM codex_threads WHERE thread_id = ?'),
  ]
  const insertThread = db.prepare(
    `INSERT INTO codex_threads(thread_id, root_thread_id, parent_thread_id, kind, thread_source, originator, cli_version, cwd, repo, repo_path,
       branch, commit_hash, model, path, archived, size, mtime_ms, lines, first_ts, last_ts, last_activity_ts, turns,
       reasoning_records, reasoning_summarized, withheld_records, withheld_chars)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertTurn = db.prepare(
    `INSERT INTO codex_turns(thread_id, turn_id, n, started_ts, completed_ts, duration_ms, ttft_ms, model, effort, trigger, opener,
       last_agent_message, aborted, error, verdict_outcome, verdict_risk, verdict_authorization, requests, output_tokens, tools, execs, questions)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertRequest = db.prepare(
    `INSERT OR REPLACE INTO codex_requests(thread_id, response_id, turn_id, ts, model, effort, input_tokens, cache_write_tokens,
       cache_read_tokens, output_tokens, thinking_tokens, usage_source)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertMsg = db.prepare('INSERT INTO codex_messages(thread_id, ordinal, ts, lane, type, turn_id, tool_name, call_id, peer) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const insertFts = db.prepare('INSERT INTO codex_messages_fts(rowid, text) VALUES(?, ?)')
  const insertQuestion = db.prepare(
    `INSERT OR REPLACE INTO codex_questions(thread_id, call_id, idx, turn_id, asked_ts, title, options, accepted, answer, answered_ts, free_text)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const bool = (b: boolean | null) => (b == null ? null : b ? 1 : 0)

  const stats: CodexIndexStats = { threads: files.length, indexed: 0, skipped: 0, imported, refused: 0, messages: 0, requests: 0, unknown: {}, durationMs: 0 }
  // The exclusion list again, against what the file SAYS it is: a rollout's
  // name is not its identity.
  const excluded = readImports(opts.codexHome)
  for (const f of files) {
    const existing = Existing.parse(find.get(f.threadId))
    if (!opts.full && existing && existing.size === f.size && existing.mtime_ms === f.mtimeMs) {
      stats.skipped++
      continue
    }
    const t = parseRollout(await readRollout(f.path))
    if (!t || t.threadId !== f.threadId || excluded.has(t.threadId)) {
      stats.refused++
      continue
    }
    const hop = repoHop(t.cwd)
    db.transaction(() => {
      for (const w of wipe) w.run(t.threadId)
      insertThread.run(
        t.threadId,
        t.rootThreadId,
        t.parentThreadId,
        t.kind,
        t.threadSource,
        t.originator,
        t.cliVersion,
        t.cwd,
        repoKey(t, hop),
        hop?.repoPath ?? null,
        t.git?.branch ?? null,
        t.git?.commitHash ?? null,
        t.model,
        f.path,
        f.archived ? 1 : 0,
        f.size,
        f.mtimeMs,
        t.lines,
        t.firstTs,
        t.lastTs,
        t.lastActivityTs,
        t.turns.length,
        t.reasoning.records,
        t.reasoning.summarized,
        t.withheld.records,
        t.withheld.chars,
      )
      for (const x of t.turns)
        insertTurn.run(t.threadId, x.turnId, x.n, x.startedTs, x.completedTs, x.durationMs, x.ttftMs, x.model, x.effort, x.trigger, x.opener, x.lastAgentMessage, x.aborted, x.error, x.verdict?.outcome ?? null, x.verdict?.risk_level ?? null, x.verdict?.user_authorization ?? null, x.requests, x.output, x.tools, x.execs, x.questions)
      for (const r of t.requests) insertRequest.run(t.threadId, r.id, r.turnId, r.ts, r.model, r.effort, r.input, r.cacheWrite, r.cacheRead, r.output, r.thinking, r.usageSource)
      for (const m of t.messages) {
        const row = insertMsg.run(t.threadId, m.ordinal, m.ts, m.lane, m.type, m.turnId, m.toolName ?? null, m.toolUseId ?? null, m.peer ?? null)
        insertFts.run(row.lastInsertRowid, m.text)
      }
      for (const q of t.questions) insertQuestion.run(t.threadId, q.callId, q.index, q.turnId, q.askedTs, q.title, q.options ? JSON.stringify(q.options) : null, bool(q.accepted), q.answer, q.answeredTs, bool(q.freeText))
    })()
    stats.indexed++
    stats.messages += t.messages.length
    stats.requests += t.requests.length
    for (const [k, n] of Object.entries(t.unknown)) stats.unknown[k] = (stats.unknown[k] ?? 0) + n
  }
  stats.durationMs = Math.round(performance.now() - started)
  return stats
}

// ---- sessions ---------------------------------------------------------------

const ThreadRow = z.object({
  sessionId: z.string(),
  repo: z.string().nullable(),
  repoPath: z.string().nullable(),
  kind: z.string(),
  parent: z.string().nullable(),
  first: z.string().nullable(),
  last: z.string().nullable(),
  idleUntil: z.string().nullable(),
  lines: z.number(),
  turns: z.number(),
  prompts: z.number(),
  questions: z.number(),
  workDir: z.string().nullable(),
  branch: z.string().nullable(),
  cli: z.string().nullable(),
  originator: z.string().nullable(),
  archived: z.number(),
  firstPrompt: z.string().nullable(),
  reasoning: z.number(),
  reasoningSummarized: z.number(),
  guardians: z.number(),
  guardiansRan: z.number(),
  verdicts: z.number(),
})
const ModelRow = z.object({ sessionId: z.string(), model: z.string(), requests: z.number() })

// A Codex thread in the shape `lore sessions` lists a Claude session, with
// what a thread has instead: `repo` where a session has `well` (the key —
// codex.ts repoKey), `turns` (task_started: 0 is a thread that never ran),
// and its judges rolled up rather than listed — `guardians` minted for it,
// how many `guardiansRan`, the `verdicts` they returned. `reasoning` counts
// reasoning records against `reasoningSummarized`, the ones with any
// plaintext: the body is encrypted on all of them.
export type CodexSessionRow = Omit<z.infer<typeof ThreadRow>, 'archived'> & {
  source: 'codex'
  firstAt: string | null
  lastAt: string | null
  archived: boolean
  models: { model: string; requests: number }[]
}

export function listCodexSessions(
  db: Database,
  // `repo` is matched against the repo key, the repo path and the cwd — a
  // thread has no well, and `--well` on the CLI is this for a Codex row.
  // Guardians are left out unless asked for: 328 judges against 76 workers.
  opts: { repo?: string; exact?: boolean; since?: string; limit: number; guardians?: boolean; sessions?: string[] },
): CodexSessionRow[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (opts.sessions) {
    if (opts.sessions.length === 0) return []
    where.push(`t.thread_id IN (${opts.sessions.map(() => '?').join(',')})`)
    params.push(...opts.sessions)
  }
  if (!opts.guardians && !opts.sessions) where.push(`t.kind != 'guardian'`)
  if (opts.repo) {
    where.push(opts.exact ? '(t.repo = ? OR t.repo_path = ? OR t.cwd = ?)' : '(t.repo LIKE ? OR t.repo_path LIKE ? OR t.cwd LIKE ?)')
    const v = opts.exact ? opts.repo : `%${opts.repo}%`
    params.push(v, v, v)
  }
  if (opts.since) {
    // The instant, never the rollout's path: the path's day is local.
    where.push('COALESCE(t.last_activity_ts, t.last_ts) >= ?')
    params.push(dayStart(opts.since))
  }
  const sql = `
    SELECT p.*,
      (SELECT COUNT(*) FROM codex_messages m WHERE m.thread_id = p.sessionId AND m.lane = 'prompt') AS prompts,
      (SELECT COUNT(*) FROM codex_questions q WHERE q.thread_id = p.sessionId) AS questions,
      (SELECT f.text FROM codex_messages m JOIN codex_messages_fts f ON f.rowid = m.id
        WHERE m.thread_id = p.sessionId AND m.lane IN ('prompt', 'relay') ORDER BY m.ordinal LIMIT 1) AS firstPrompt,
      (SELECT COUNT(*) FROM codex_threads g WHERE g.parent_thread_id = p.sessionId AND g.kind = 'guardian') AS guardians,
      (SELECT COUNT(*) FROM codex_threads g WHERE g.parent_thread_id = p.sessionId AND g.kind = 'guardian' AND g.turns > 0) AS guardiansRan,
      (SELECT COUNT(*) FROM codex_turns v JOIN codex_threads g ON g.thread_id = v.thread_id
        WHERE g.parent_thread_id = p.sessionId AND g.kind = 'guardian' AND v.verdict_outcome IS NOT NULL) AS verdicts
    FROM (
      SELECT t.thread_id AS sessionId, t.repo, t.repo_path AS repoPath, t.kind, t.parent_thread_id AS parent, t.first_ts AS first,
             COALESCE(t.last_activity_ts, t.last_ts) AS last,
             CASE WHEN t.last_activity_ts IS NOT NULL AND t.last_ts > t.last_activity_ts THEN t.last_ts END AS idleUntil,
             t.lines, t.turns, t.cwd AS workDir, t.branch, t.cli_version AS cli, t.originator, t.archived,
             t.reasoning_records AS reasoning, t.reasoning_summarized AS reasoningSummarized
      FROM codex_threads t
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.first_ts DESC, t.thread_id LIMIT ?
    ) p ORDER BY p.first, p.sessionId`
  const picked = z.array(ThreadRow).parse(db.prepare(sql).all(...params, opts.limit))
  const models = new Map<string, { model: string; requests: number }[]>()
  if (picked.length) {
    const rows = z.array(ModelRow).parse(
      db
        .prepare(
          `SELECT thread_id AS sessionId, model, COUNT(*) AS requests FROM codex_requests
           WHERE model IS NOT NULL AND thread_id IN (${picked.map(() => '?').join(',')}) GROUP BY 1, 2 ORDER BY 3 DESC, 2`,
        )
        .all(...picked.map((r) => r.sessionId)),
    )
    for (const r of rows) (models.get(r.sessionId) ?? models.set(r.sessionId, []).get(r.sessionId)!).push({ model: r.model, requests: r.requests })
  }
  return picked.map((r) => {
    const flat = r.firstPrompt?.replace(/\s+/g, ' ').trim() ?? null
    return {
      source: 'codex' as const,
      ...r,
      archived: r.archived === 1,
      first: day(r.first) || null,
      last: day(r.last) || null,
      firstAt: r.first,
      lastAt: r.last,
      idleUntil: day(r.idleUntil) || null,
      firstPrompt: flat && flat.length > 140 ? `${flat.slice(0, 140)}…` : flat,
      models: models.get(r.sessionId) ?? [],
    }
  })
}

// ---- search -----------------------------------------------------------------

const Hit = z.object({
  repo: z.string().nullable(),
  repoPath: z.string().nullable(),
  sessionId: z.string(),
  kind: z.string(),
  // The turn the hit sits in — Codex's transaction key.
  turnId: z.string().nullable(),
  ts: z.string().nullable(),
  lane: z.string(),
  gitBranch: z.string().nullable(),
  snippet: z.string(),
})
export type CodexHit = z.infer<typeof Hit> & { source: 'codex' }

// Full-text over Codex's own FTS table. Its ranks are its own: a bm25 score
// is relative to the table it was computed in, so a Codex hit is never
// interleaved with a Claude one by rank — `search --source all` returns the
// two lists side by side.
export function searchCodex(
  db: Database,
  query: string,
  opts: { lanes: CodexLane[]; repo?: string; exact?: boolean; since?: string; until?: string; session?: string; limit: number },
): CodexHit[] {
  const parts: string[] = []
  const params: (string | number)[] = [...opts.lanes]
  if (opts.repo) {
    parts.push(opts.exact ? 'AND (t.repo = ? OR t.repo_path = ? OR t.cwd = ?)' : 'AND (t.repo LIKE ? OR t.repo_path LIKE ? OR t.cwd LIKE ?)')
    const v = opts.exact ? opts.repo : `%${opts.repo}%`
    params.push(v, v, v)
  }
  if (opts.since) {
    parts.push('AND m.ts >= ?')
    params.push(dayStart(opts.since))
  }
  if (opts.until) {
    parts.push('AND m.ts < ?')
    params.push(dayStart(opts.until))
  }
  if (opts.session) {
    parts.push('AND m.thread_id LIKE ?')
    params.push(`${opts.session}%`)
  }
  const sql = `
    SELECT t.repo, t.repo_path AS repoPath, m.thread_id AS sessionId, t.kind, m.turn_id AS turnId, m.ts, m.lane, t.branch AS gitBranch,
           snippet(codex_messages_fts, 0, '«', '»', ' … ', 24) AS snippet
    FROM codex_messages_fts f
    JOIN codex_messages m ON m.id = f.rowid
    JOIN codex_threads t ON t.thread_id = m.thread_id
    WHERE codex_messages_fts MATCH ? AND m.lane IN (${opts.lanes.map(() => '?').join(',')}) ${parts.join(' ')}
    ORDER BY rank LIMIT ?`
  return ftsMatch(query, (q) => z.array(Hit).parse(db.prepare(sql).all(q, ...params, opts.limit))).map((h) => ({ source: 'codex' as const, ...h }))
}

// ---- usage: the relation `listUsage` reads when asked for Codex --------------

// usage.ts aggregates `requests r JOIN sessions s JOIN wells w`. This is the
// same three aliases over the Codex tables, so one aggregation serves both
// sources and neither can drift from the other: `r` in lore's token classes
// (a Codex cache write has no TTL split, so the 1-hour slice is 0), `s` the
// thread, `w.dir` the repo key.
export const CODEX_USAGE_FROM = `
  (SELECT thread_id AS session_id, ts, model, input_tokens, cache_write_tokens, 0 AS cache_write_1h_tokens,
          cache_read_tokens, output_tokens, thinking_tokens FROM codex_requests) r
  JOIN (SELECT thread_id AS session_id, first_ts FROM codex_threads) s ON s.session_id = r.session_id
  JOIN (SELECT thread_id, COALESCE(repo, cwd, '?') AS dir, COALESCE(repo_path, cwd) AS real_path FROM codex_threads) w ON w.thread_id = r.session_id`
