import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { CodexLane } from './codex'
import { dayStart } from './fmt'

// `lore codex` — the read surface over one Codex thread (DESIGN.md
// 2026-11-14). Its verbs are the throwaway slicer's that two miners read the
// first Codex threads with at ingest #28 (`meta` / `turns` / `turn N` / `user`
// / `agent` / `tools` / `grep`), which died with the job that wrote it:
// `turns` is the whole instrument — one row per turn, what was asked, what
// came back, what it cost — and it is cheap because Codex writes
// `last_agent_message` on every `task_complete`. `user`, `agent` and `tools`
// are `messages --lane prompt|text|tool`; `grep` is `lore search --source
// codex --session <id>`.

const flat = (s: string | null, n: number) => {
  if (s == null) return null
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const Thread = z.object({
  threadId: z.string(),
  rootThreadId: z.string(),
  parent: z.string().nullable(),
  kind: z.string(),
  threadSource: z.string().nullable(),
  originator: z.string().nullable(),
  cli: z.string().nullable(),
  cwd: z.string().nullable(),
  repo: z.string().nullable(),
  repoPath: z.string().nullable(),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  model: z.string().nullable(),
  path: z.string(),
  archived: z.number(),
  lines: z.number(),
  first: z.string().nullable(),
  last: z.string().nullable(),
  lastActivity: z.string().nullable(),
  turns: z.number(),
  reasoning: z.number(),
  reasoningSummarized: z.number(),
  withheldRecords: z.number(),
  withheldChars: z.number(),
})
export type CodexThreadRow = z.infer<typeof Thread>

const THREAD_SQL = `SELECT thread_id AS threadId, root_thread_id AS rootThreadId, parent_thread_id AS parent, kind, thread_source AS threadSource,
  originator, cli_version AS cli, cwd, repo, repo_path AS repoPath, branch, commit_hash AS "commit", model, path, archived, lines,
  first_ts AS first, last_ts AS last, last_activity_ts AS lastActivity, turns, reasoning_records AS reasoning,
  reasoning_summarized AS reasoningSummarized, withheld_records AS withheldRecords, withheld_chars AS withheldChars
  FROM codex_threads`

// A thread by id or unique prefix. Thread ids are time-ordered, so a worker
// and a guardian minted in the same instant share their first characters
// (the attrition thread and one of its judges both begin `01a08412`): when a
// prefix names several threads and exactly ONE of them is not a guardian,
// that one is meant. Anything else ambiguous is an error that lists them.
export function resolveThread(db: Database, id: string): CodexThreadRow {
  const rows = z.array(Thread).parse(db.prepare(`${THREAD_SQL} WHERE thread_id LIKE ? ORDER BY first_ts LIMIT 50`).all(`${id}%`))
  if (rows.length === 0) throw new Error(`No Codex thread starts with "${id}" — \`lore sessions --source codex\` lists them (and \`lore index\` reads ~/.codex).`)
  if (rows.length === 1) return rows[0]!
  const exact = rows.find((r) => r.threadId === id)
  if (exact) return exact
  const workers = rows.filter((r) => r.kind !== 'guardian')
  if (workers.length === 1) return workers[0]!
  throw new Error(`"${id}" names ${rows.length} Codex threads: ${rows.slice(0, 8).map((r) => `${r.threadId} (${r.kind})`).join(', ')}`)
}

const Totals = z.object({ requests: z.number(), input: z.number(), cacheWrite: z.number(), cacheRead: z.number(), output: z.number(), thinking: z.number(), counted: z.number() })
const totalsOf = (db: Database, threadId: string) =>
  Totals.parse(
    db
      .prepare(
        `SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
                COALESCE(SUM(cache_read_tokens), 0) AS cacheRead, COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(thinking_tokens), 0) AS thinking, COALESCE(SUM(usage_source = 'count'), 0) AS counted
         FROM codex_requests WHERE thread_id = ?`,
      )
      .get(threadId),
  )

const Child = z.object({ threadId: z.string(), kind: z.string(), first: z.string().nullable(), turns: z.number(), verdicts: z.number(), model: z.string().nullable(), output: z.number() })
const LaneCount = z.object({ lane: z.string(), n: z.number() })

// `meta`: what the thread is, without opening it.
export function getCodexMeta(db: Database, id: string) {
  const t = resolveThread(db, id)
  const usage = totalsOf(db, t.threadId)
  const children = z.array(Child).parse(
    db
      .prepare(
        `SELECT c.thread_id AS threadId, c.kind, c.first_ts AS first, c.turns, c.model,
                (SELECT COUNT(*) FROM codex_turns v WHERE v.thread_id = c.thread_id AND v.verdict_outcome IS NOT NULL) AS verdicts,
                (SELECT COALESCE(SUM(output_tokens), 0) FROM codex_requests r WHERE r.thread_id = c.thread_id) AS output
         FROM codex_threads c WHERE c.parent_thread_id = ? ORDER BY c.first_ts, c.thread_id`,
      )
      .all(t.threadId),
  )
  const lanes = z.array(LaneCount).parse(db.prepare('SELECT lane, COUNT(*) AS n FROM codex_messages WHERE thread_id = ? GROUP BY lane ORDER BY n DESC').all(t.threadId))
  const outcomes = z.array(z.object({ outcome: z.string(), n: z.number() })).parse(
    db
      .prepare(
        `SELECT v.verdict_outcome AS outcome, COUNT(*) AS n FROM codex_turns v JOIN codex_threads c ON c.thread_id = v.thread_id
         WHERE (c.parent_thread_id = ? OR c.thread_id = ?) AND v.verdict_outcome IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
      )
      .all(t.threadId, t.threadId),
  )
  const { archived, reasoning, reasoningSummarized, withheldRecords, withheldChars, ...thread } = t
  const { counted, ...tokens } = usage
  return {
    source: 'codex' as const,
    ...thread,
    archived: archived === 1,
    // `ran` is the turn count, never the file: a guardian minted and never
    // used is 40 KB of file and zero turns.
    ran: t.turns > 0,
    usage: { ...tokens, listUsd: null, ...(counted ? { fromTokenCount: counted } : {}) },
    // Every reasoning body is encrypted; `summarized` of them carry plaintext.
    reasoning: { records: reasoning, summarized: reasoningSummarized, encrypted: true },
    ...(withheldRecords ? { withheld: { records: withheldRecords, chars: withheldChars } } : {}),
    lanes: Object.fromEntries(lanes.map((l) => [l.lane, l.n])),
    // The judges (and any subagents) this thread minted. Most never ran.
    children: { count: children.length, ran: children.filter((c) => c.turns > 0).length, verdicts: children.reduce((n, c) => n + c.verdicts, 0), output: children.reduce((n, c) => n + c.output, 0) },
    ...(outcomes.length ? { outcomes: Object.fromEntries(outcomes.map((o) => [o.outcome, o.n])) } : {}),
    childThreads: children.filter((c) => c.turns > 0),
  }
}

const Turn = z.object({
  n: z.number(),
  turnId: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  ms: z.number().nullable(),
  ttftMs: z.number().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  trigger: z.string().nullable(),
  opener: z.string().nullable(),
  reply: z.string().nullable(),
  aborted: z.string().nullable(),
  error: z.string().nullable(),
  outcome: z.string().nullable(),
  risk: z.string().nullable(),
  authorization: z.string().nullable(),
  requests: z.number(),
  output: z.number(),
  tools: z.number(),
  execs: z.number(),
  questions: z.number(),
  inputs: z.number(),
})
const TURN_SQL = `SELECT u.n, u.turn_id AS turnId, u.started_ts AS startedAt, u.completed_ts AS completedAt, u.duration_ms AS ms, u.ttft_ms AS ttftMs,
  u.model, u.effort, u.trigger, u.opener, u.last_agent_message AS reply, u.aborted, u.error,
  u.verdict_outcome AS outcome, u.verdict_risk AS risk, u.verdict_authorization AS "authorization",
  u.requests, u.output_tokens AS output, u.tools, u.execs, u.questions,
  (SELECT COUNT(*) FROM codex_messages m WHERE m.thread_id = u.thread_id AND m.turn_id = u.turn_id AND m.lane IN ('prompt', 'relay')) AS inputs
  FROM codex_turns u`

function turnRow(t: z.infer<typeof Turn>, head: number, guardian: boolean) {
  const { opener, reply, outcome, risk, authorization, aborted, error, inputs, ttftMs, effort, trigger, questions, ...rest } = t
  return {
    ...rest,
    ...(trigger ? { trigger } : {}),
    // What was submitted to open the turn (null: nobody typed it — a goal
    // continuation, or a guardian, whose input is evidence and is withheld),
    // and how many more messages arrived while it ran.
    opener: flat(opener, head),
    ...(inputs > 1 ? { steers: inputs - 1 } : {}),
    // Codex's own closing text for the turn. On a guardian it is the verdict.
    reply: guardian && outcome ? null : flat(reply, head),
    ...(outcome ? { verdict: { outcome, risk, authorization } } : {}),
    ...(questions ? { questions } : {}),
    ...(aborted ? { aborted } : {}),
    ...(error ? { error } : {}),
    // A turn with no completion and no abort: still running, or cut off.
    ...(!t.completedAt && !aborted ? { open: true } : {}),
  }
}

// `turns`: the spine. Totals cover the whole thread; --limit takes the
// NEWEST n and renders them oldest-first, like `lore sessions`.
export function getCodexTurns(db: Database, id: string, opts: { head: number; limit: number; since?: string; until?: string }) {
  const t = resolveThread(db, id)
  const where = ['u.thread_id = ?']
  const params: (string | number)[] = [t.threadId]
  if (opts.since) {
    where.push('u.started_ts >= ?')
    params.push(dayStart(opts.since))
  }
  if (opts.until) {
    where.push('u.started_ts < ?')
    params.push(dayStart(opts.until))
  }
  const rows = z.array(Turn).parse(db.prepare(`SELECT * FROM (${TURN_SQL} WHERE ${where.join(' AND ')} ORDER BY u.n DESC LIMIT ?) ORDER BY n`).all(...params, opts.limit))
  const usage = totalsOf(db, t.threadId)
  const sums = z
    .object({ tools: z.number(), execs: z.number(), questions: z.number(), ms: z.number(), aborted: z.number(), errored: z.number(), open: z.number() })
    .parse(
      db
        .prepare(
          `SELECT COALESCE(SUM(tools), 0) AS tools, COALESCE(SUM(execs), 0) AS execs, COALESCE(SUM(questions), 0) AS questions,
                  COALESCE(SUM(duration_ms), 0) AS ms, COALESCE(SUM(aborted IS NOT NULL), 0) AS aborted, COALESCE(SUM(error IS NOT NULL), 0) AS errored,
                  COALESCE(SUM(completed_ts IS NULL AND aborted IS NULL), 0) AS open
           FROM codex_turns WHERE thread_id = ?`,
        )
        .get(t.threadId),
    )
  return {
    source: 'codex' as const,
    threadId: t.threadId,
    kind: t.kind,
    repo: t.repo,
    branch: t.branch,
    model: t.model,
    first: t.first,
    last: t.lastActivity ?? t.last,
    ...(t.parent ? { parent: t.parent } : {}),
    totals: { turns: t.turns, requests: usage.requests, input: usage.input, cacheRead: usage.cacheRead, output: usage.output, thinking: usage.thinking, listUsd: null, ...sums },
    count: rows.length,
    turns: rows.map((r) => turnRow(r, opts.head, t.kind === 'guardian')),
  }
}

const Message = z.object({ ordinal: z.number(), ts: z.string().nullable(), lane: z.string(), type: z.string(), turn: z.number().nullable(), toolName: z.string().nullable(), callId: z.string().nullable(), peer: z.string().nullable(), text: z.string() })
const Question = z.object({ callId: z.string(), index: z.number(), turn: z.number().nullable(), askedAt: z.string().nullable(), title: z.string().nullable(), options: z.string().nullable(), accepted: z.number().nullable(), answer: z.string().nullable(), answeredAt: z.string().nullable(), freeText: z.number().nullable() })

function messagesOf(db: Database, threadId: string, opts: { lanes: CodexLane[]; turnId?: string; since?: string; until?: string; limit: number; head?: number }) {
  const where = ['m.thread_id = ?', `m.lane IN (${opts.lanes.map(() => '?').join(',')})`]
  const params: (string | number)[] = [threadId, ...opts.lanes]
  if (opts.turnId) {
    where.push('m.turn_id = ?')
    params.push(opts.turnId)
  }
  if (opts.since) {
    where.push('m.ts >= ?')
    params.push(dayStart(opts.since))
  }
  if (opts.until) {
    where.push('m.ts < ?')
    params.push(dayStart(opts.until))
  }
  const rows = z.array(Message).parse(
    db
      .prepare(
        `SELECT m.ordinal, m.ts, m.lane, m.type, u.n AS turn, m.tool_name AS toolName, m.call_id AS callId, m.peer, f.text
         FROM codex_messages m JOIN codex_messages_fts f ON f.rowid = m.id
         LEFT JOIN codex_turns u ON u.thread_id = m.thread_id AND u.turn_id = m.turn_id
         WHERE ${where.join(' AND ')} ORDER BY m.ordinal LIMIT ?`,
      )
      .all(...params, opts.limit),
  )
  return rows.map(({ toolName, callId, peer, text, ...m }) => ({
    ...m,
    ...(toolName ? { toolName } : {}),
    ...(callId ? { callId } : {}),
    ...(peer ? { peer } : {}),
    text: opts.head != null && text.length > opts.head ? `${text.slice(0, opts.head)}…` : text,
  }))
}

function questionsOf(db: Database, threadId: string, turnId?: string) {
  const rows = z.array(Question).parse(
    db
      .prepare(
        `SELECT q.call_id AS callId, q.idx AS "index", u.n AS turn, q.asked_ts AS askedAt, q.title, q.options, q.accepted, q.answer,
                q.answered_ts AS answeredAt, q.free_text AS freeText
         FROM codex_questions q LEFT JOIN codex_turns u ON u.thread_id = q.thread_id AND u.turn_id = q.turn_id
         WHERE q.thread_id = ? ${turnId ? 'AND q.turn_id = ?' : ''} ORDER BY q.asked_ts, q.idx`,
      )
      .all(...(turnId ? [threadId, turnId] : [threadId])),
  )
  return rows.map(({ options, accepted, freeText, ...q }) => ({
    ...q,
    options: options ? z.array(z.string()).parse(JSON.parse(options)) : null,
    accepted: accepted == null ? null : accepted === 1,
    // The user typed their own answer against the options offered.
    freeText: freeText == null ? null : freeText === 1,
  }))
}

// `turn N`: one turn opened — the row `turns` gives, whole, and what was
// said inside it in order. Tool traffic is opt-in (`--lane tool`), as on
// `lore session`.
export function getCodexTurn(db: Database, id: string, n: number, opts: { lanes: CodexLane[]; limit: number; head?: number }) {
  const t = resolveThread(db, id)
  const row = Turn.nullish().parse(db.prepare(`${TURN_SQL} WHERE u.thread_id = ? AND u.n = ?`).get(t.threadId, n))
  if (!row) throw new Error(`Thread ${t.threadId} has ${t.turns} turn${t.turns === 1 ? '' : 's'}; there is no turn ${n}.`)
  const messages = messagesOf(db, t.threadId, { lanes: opts.lanes, turnId: row.turnId, limit: opts.limit, head: opts.head })
  const questions = questionsOf(db, t.threadId, row.turnId)
  return {
    source: 'codex' as const,
    threadId: t.threadId,
    kind: t.kind,
    repo: t.repo,
    turn: { ...turnRow(row, Number.MAX_SAFE_INTEGER, t.kind === 'guardian'), opener: row.opener, reply: row.reply },
    lanes: opts.lanes,
    count: messages.length,
    messages,
    ...(questions.length ? { questions } : {}),
  }
}

// `messages`: one thread's lanes in order — `user` is `--lane prompt`,
// `agent` is `--lane text`, `tools` is `--lane tool`.
export function getCodexMessages(db: Database, id: string, opts: { lanes: CodexLane[]; since?: string; until?: string; limit: number; head?: number }) {
  const t = resolveThread(db, id)
  const messages = messagesOf(db, t.threadId, opts)
  return { source: 'codex' as const, threadId: t.threadId, kind: t.kind, repo: t.repo, lanes: opts.lanes, count: messages.length, messages }
}

// `questions`: every question the agent asked the user mid-run, with what
// came back — one thread's, or all of them.
export function getCodexQuestions(db: Database, id?: string) {
  if (id) {
    const t = resolveThread(db, id)
    const questions = questionsOf(db, t.threadId)
    return { source: 'codex' as const, threadId: t.threadId, repo: t.repo, ...tally(questions), questions }
  }
  const threads = z.array(z.object({ threadId: z.string(), repo: z.string().nullable() })).parse(
    db.prepare('SELECT DISTINCT q.thread_id AS threadId, t.repo FROM codex_questions q JOIN codex_threads t ON t.thread_id = q.thread_id ORDER BY t.first_ts').all(),
  )
  const questions = threads.flatMap((t) => questionsOf(db, t.threadId).map((q) => ({ threadId: t.threadId, repo: t.repo, ...q })))
  return { source: 'codex' as const, threads: threads.length, ...tally(questions), questions }
}
function tally(qs: { options: string[] | null; answer: string | null; freeText: boolean | null }[]) {
  return { count: qs.length, withOptions: qs.filter((q) => q.options).length, answered: qs.filter((q) => q.answer != null).length, freeText: qs.filter((q) => q.freeText).length }
}
