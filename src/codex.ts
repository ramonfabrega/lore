import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { headTail, TOOL_TEXT_CAP } from './parse'
import type { Lane, Request } from './parse'

// The READ half of the Codex adapter: OpenAI Codex rollout transcripts as a
// second source for layer 1 (wiki projects/codex-adapter.md; DESIGN.md
// 2026-11-14). This file is the decode — zod at the boundary, then a pure
// parser from one rollout's text to lore's own row shapes (a session, its
// turns, its requests, its messages by lane). No database here: codexindex.ts
// stores what this returns.
//
// A rollout is `<codex home>/sessions/<YYYY>/<MM>/<DD>/rollout-<local
// stamp>-<threadId>.jsonl`, one JSON record per line, each `{type, timestamp,
// ordinal, payload}`. Measured 2026-11-14 over 454 rollouts (978 MB
// uncompressed, 266,914 records, none torn), CLI 0.58.0 through
// 0.166.0-alpha.5.1 — the desktop app ships its own alphas, so "the installed
// CLI" (0.153.4) wrote 61 of them:
//
//  - 385 of the 454 are `.jsonl.zst`: Codex compresses a rollout once it
//    rests, so a reader of `*.jsonl` alone sees the last few weeks.
//  - 20 sit in `archived_sessions/`, flat, moved there when the user archives
//    a thread. An archived thread still ran.
//  - 23 record kinds. `response_item/*` is what the model saw and said;
//    `event_msg/*` is the harness's own account of the same turn, and
//    `event_msg/item_completed` repeats every message, reasoning item and
//    command a second time (82,661 records, the largest kind). Index both
//    and every word is in the FTS twice.
//  - Every record of every thread carries `ordinal`, old CLIs included: the
//    corpus was rewritten into `history_mode: paginated` at some point, so a
//    shape here is what the CURRENT Codex wrote, not what 0.58.0 did.
//
// The schemas are `z.object` in its default STRIP mode on purpose: an unknown
// key is tolerated and dropped. That makes each schema the exact list of
// fields lore reads — and scripts/codex-corpus.ts snapshots fixtures by
// parsing real records THROUGH these schemas, so a fixture can only ever hold
// a declared field. Nothing with a dynamic key (a skills map, an AGENTS.md
// path) is declared, which is why `world_state` and `compacted` are two
// fields each.

// ---- decoders ---------------------------------------------------------------

// Codex's usage envelope. `input_tokens` INCLUDES `cached_input_tokens`
// (`total_tokens` = input + output on 21,050 of 21,050 records; cached ≤ input
// on all of them) — see `mapUsage`.
export const Usage = z.object({
  input_tokens: z.number(),
  cached_input_tokens: z.number().nullish(),
  cache_write_input_tokens: z.number().nullish(),
  output_tokens: z.number(),
  reasoning_output_tokens: z.number().nullish(),
  total_tokens: z.number().nullish(),
})
export type Usage = z.infer<typeof Usage>

// `source.subagent` names WHY a thread has a parent. Three shapes in Codex's
// own enum: a bare word (`review`, `compact`), `{other: <label>}` — the
// guardian is `{other: "guardian"}` on 328 of 328 — and `{thread_spawn}`, a
// multi_agent child (none in the corpus yet; `multi_agent` is stable in
// 0.153.4, so they will come, as more `parent_thread_id` threads).
const SubagentSource = z.union([
  z.string(),
  z.object({ other: z.string() }),
  z.object({
    thread_spawn: z.object({
      parent_thread_id: z.string().nullish(),
      depth: z.number().nullish(),
      agent_role: z.string().nullish(),
    }),
  }),
])

export const SessionMeta = z.object({
  id: z.string(),
  // The ROOT thread's id: equal to `id` on a root, the parent's on a child
  // (326 of 326 threads with a parent).
  session_id: z.string().nullish(),
  parent_thread_id: z.string().nullish(),
  thread_source: z.string().nullish(),
  originator: z.string().nullish(),
  cli_version: z.string().nullish(),
  source: z.union([z.string(), z.object({ subagent: SubagentSource })]).nullish(),
  cwd: z.string().nullish(),
  timestamp: z.string().nullish(),
  model_provider: z.string().nullish(),
  history_mode: z.string().nullish(),
  multi_agent_version: z.string().nullish(),
  subagent_history_start_ordinal: z.number().nullish(),
  // The field that keys a thread to a repo without the worktree hop.
  git: z.object({ repository_url: z.string().nullish(), commit_hash: z.string().nullish(), branch: z.string().nullish() }).nullish(),
})
export type SessionMeta = z.infer<typeof SessionMeta>

const TurnContext = z.object({
  // Absent on 0.58.0 / 0.69.0 (155 records): the context then belongs to
  // the turn that is open.
  turn_id: z.string().nullish(),
  model: z.string().nullish(),
  effort: z.string().nullish(),
  cwd: z.string().nullish(),
})

// One per REQUEST, not per turn. Three scopes ride on it; lore reads `usage`
// (this response) and derives the other two.
const TokenUsageRecord = z.object({
  response_id: z.string(),
  turn_id: z.string().nullish(),
  root_turn_id: z.string().nullish(),
  thread_id: z.string().nullish(),
  session_id: z.string().nullish(),
  usage: Usage,
  turn_token_usage: Usage.nullish(),
  thread_token_usage: Usage.nullish(),
})

const TaskStarted = z.object({
  type: z.literal('task_started'),
  turn_id: z.string(),
  started_at: z.number().nullish(),
  model_context_window: z.number().nullish(),
  collaboration_mode_kind: z.string().nullish(),
  // WHO opened the turn, as a field (0.155+; 1,706 of 6,138 turns):
  // `composer`, `remote_ios`, `queue`, `exec` are a person; `goal` is the
  // harness continuing a goal; `guardian_review` a review request;
  // `send_user_message_async_question` an answer to a question.
  turn_attribution: z.object({ turn_trigger: z.string().nullish(), parent_turn_id: z.string().nullish() }).nullish(),
})
const TaskComplete = z.object({
  type: z.literal('task_complete'),
  turn_id: z.string(),
  completed_at: z.number().nullish(),
  duration_ms: z.number().nullish(),
  time_to_first_token_ms: z.number().nullish(),
  // What makes a turn spine readable without re-walking messages.
  last_agent_message: z.string().nullish(),
  error: z.object({ codex_error_info: z.string().nullish(), message: z.string().nullish() }).nullish(),
})
const TurnAborted = z.object({ type: z.literal('turn_aborted'), turn_id: z.string(), reason: z.string().nullish() })
// The older per-request usage event, and the ONLY one before 0.153: 111 of the
// 327 threads that ran carry no `token_usage_record` at all.
const TokenCount = z.object({
  type: z.literal('token_count'),
  info: z.object({ last_token_usage: Usage.nullish(), total_token_usage: Usage.nullish() }).nullish(),
})
// The harness's typed account of one item of a turn. Only `UserMessage` is
// read: it is what was SUBMITTED to the turn — the authorship field.
const ItemCompleted = z.object({
  type: z.literal('item_completed'),
  turn_id: z.string().nullish(),
  item: z.object({
    type: z.string(),
    id: z.string().nullish(),
    client_id: z.string().nullish(),
    status: z.string().nullish(),
    content: z.array(z.object({ type: z.string(), text: z.string().nullish() })).nullish(),
  }),
})
const ThreadSettingsApplied = z.object({
  type: z.literal('thread_settings_applied'),
  thread_settings: z.object({ model: z.string().nullish(), reasoning_effort: z.string().nullish() }).nullish(),
})
const ThreadGoalUpdated = z.object({ type: z.literal('thread_goal_updated'), goal: z.object({ status: z.string().nullish() }).nullish() })

const ContentItem = z.object({ type: z.string(), text: z.string().nullish() })
const Message = z.object({
  type: z.literal('message'),
  role: z.string(),
  phase: z.string().nullish(),
  content: z.array(ContentItem).nullish(),
  // What each content item IS, in Codex's own vocabulary (`user.text`,
  // `environments.environment_context`, `agents_md.instructions`,
  // `goal.internal_context`, `plugins.recommendations`…). Present on newer
  // CLIs; null on the rest, where the UserMessage item decides.
  internal_chat_message_metadata_passthrough: z.object({ content_item_kinds: z.array(z.string()).nullish(), turn_id: z.string().nullish() }).nullish(),
})
// THE BODY IS ENCRYPTED. `encrypted_content` is on 21,750 of 21,750 reasoning
// records and lore cannot read it. The plaintext is `summary`: short
// headlines on a minority (3,335 records, 4,617 items, 168,761 chars). A
// thread with an empty thinking lane thought; it did not say what.
const Reasoning = z.object({
  type: z.literal('reasoning'),
  summary: z.array(z.object({ type: z.string(), text: z.string().nullish() })).nullish(),
  encrypted_content: z.string().nullish(),
})
const FunctionCall = z.object({ type: z.literal('function_call'), name: z.string(), namespace: z.string().nullish(), arguments: z.string().nullish(), call_id: z.string() })
const ToolOutput = z.union([z.string(), z.array(ContentItem)]).nullish()
const FunctionCallOutput = z.object({ type: z.literal('function_call_output'), call_id: z.string(), output: ToolOutput })
const CustomToolCall = z.object({ type: z.literal('custom_tool_call'), name: z.string(), input: z.string().nullish(), call_id: z.string(), status: z.string().nullish() })
const CustomToolCallOutput = z.object({ type: z.literal('custom_tool_call_output'), call_id: z.string(), output: ToolOutput })
const ToolSearchCall = z.object({ type: z.literal('tool_search_call'), call_id: z.string().nullish(), status: z.string().nullish(), arguments: z.object({ query: z.string().nullish() }).nullish() })
const WebSearchCall = z.object({ type: z.literal('web_search_call'), status: z.string().nullish(), action: z.object({ type: z.string().nullish(), query: z.string().nullish() }).nullish() })

// Every record kind the corpus holds, with the schema that reads it. A kind
// missing here is counted in `unknown` by the parser and FAILS the corpus
// test: a new Codex writes a new kind, and the day it is snapshotted is the
// day to say what it is.
export const RECORDS = {
  session_meta: SessionMeta,
  turn_context: TurnContext,
  token_usage_record: TokenUsageRecord,
  // The harness's world (instructions, skills, tools, AGENTS.md), written
  // whole or as a delta. Structure only: every value in it is injection.
  world_state: z.object({ full: z.boolean().nullish() }),
  // A context compaction. Carries `replacement_history` and, on a guardian's
  // parent, `guardian_history` — the transcript re-embedded once more. Never
  // read past the window number.
  compacted: z.object({ window_number: z.number().nullish() }),
  'event_msg/task_started': TaskStarted,
  'event_msg/task_complete': TaskComplete,
  'event_msg/turn_aborted': TurnAborted,
  'event_msg/token_count': TokenCount,
  'event_msg/item_completed': ItemCompleted,
  'event_msg/thread_settings_applied': ThreadSettingsApplied,
  'event_msg/thread_goal_updated': ThreadGoalUpdated,
  'response_item/message': Message,
  'response_item/reasoning': Reasoning,
  'response_item/function_call': FunctionCall,
  'response_item/function_call_output': FunctionCallOutput,
  'response_item/custom_tool_call': CustomToolCall,
  'response_item/custom_tool_call_output': CustomToolCallOutput,
  'response_item/tool_search_call': ToolSearchCall,
  'response_item/tool_search_output': z.object({ type: z.literal('tool_search_output'), call_id: z.string().nullish(), status: z.string().nullish() }),
  'response_item/web_search_call': WebSearchCall,
  // Encrypted compaction state and a tool-list delta: presence only.
  'response_item/compaction': z.object({ type: z.literal('compaction'), id: z.string().nullish() }),
  'response_item/additional_tools': z.object({ type: z.literal('additional_tools'), role: z.string().nullish() }),
} as const
export type RecordKind = keyof typeof RECORDS

export const Envelope = z.object({ type: z.string(), timestamp: z.string().nullish(), ordinal: z.number().nullish(), payload: z.unknown() })
const PayloadType = z.object({ type: z.string() })

export function kindOf(type: string, payload: unknown): string {
  if (type !== 'response_item' && type !== 'event_msg') return type
  const p = PayloadType.safeParse(payload)
  return `${type}/${p.success ? p.data.type : '?'}`
}
const isKind = (k: string): k is RecordKind => k in RECORDS

// A guardian's verdict: the JSON its final message is (3,129 verdicts
// carry all four fields; 110 carry `outcome` alone; 29 turns ended with none).
export const Verdict = z.object({
  outcome: z.string(),
  risk_level: z.string().nullish(),
  user_authorization: z.string().nullish(),
  rationale: z.string().nullish(),
})

// `request_user_input_async`: the question tool. A `function_call` carries
// `questions[]`; the answer arrives later as a user message whose whole text
// is one `<send_user_message_question_reply>` element around a JSON array,
// each entry naming its question by `questionItemId` — the triple
// `["request_user_input_async", <call_id>, <index>]`, JSON-encoded as a
// string. A PAIR of records joined on that key: 45 calls over 35 turns in
// the corpus, 33 offering options, 28 answered, 10 of those typing free text
// against the options offered.
export const ASK_TOOL = 'request_user_input_async'
export const Ask = z.object({
  questions: z.array(z.object({ title: z.string().nullish(), question: z.string().nullish(), options: z.array(z.string()).nullish() })),
})
const QuestionItemId = z.tuple([z.string(), z.string(), z.number()])
export const Reply = z.array(z.object({ questionItemId: z.union([z.string(), QuestionItemId]), question: z.string().nullish(), answer: z.string().nullish() }))
const REPLY_ELEMENT = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/
const AskAck = z.object({ accepted: z.boolean() })

function json(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

// The reply envelope, decoded — a structured element, not a prose shape: the
// text must be exactly the element, its body a JSON array of the schema, and
// each key the triple. Anything short of that is an ordinary message.
export function decodeReply(text: string): { callId: string; index: number; answer: string }[] | null {
  const body = REPLY_ELEMENT.exec(text)?.[1]
  if (body == null) return null
  const parsed = Reply.safeParse(json(body))
  if (!parsed.success || parsed.data.length === 0) return null
  const out: { callId: string; index: number; answer: string }[] = []
  for (const r of parsed.data) {
    const id = QuestionItemId.safeParse(typeof r.questionItemId === 'string' ? json(r.questionItemId) : r.questionItemId)
    if (!id.success || id.data[0] !== ASK_TOOL) return null
    out.push({ callId: id.data[1], index: id.data[2], answer: r.answer ?? '' })
  }
  return out
}

// ---- lore's row shapes --------------------------------------------------------

// `question` is the lane Codex adds: what the agent ASKED the user mid-run and
// what came back, as its own stream rather than two rows lost in `tool`.
// (Claude Code's AskUserQuestion is the same thing and is not indexed this way
// yet.)
export type CodexLane = Lane | 'question'

// `worker` is a thread a person (or `codex exec`) drives; `guardian` is a
// judge thread minted by a worker to review its planned actions; `subagent`
// is any other thread with a parent (multi_agent children).
export type ThreadKind = 'worker' | 'guardian' | 'subagent'

export type CodexMessage = {
  ordinal: number
  ts: string | null
  lane: CodexLane
  // The record's own word: `user`, `assistant`, `developer`, `reasoning`,
  // `function_call`, `custom_tool_call_output`, `ask`, `answer`, …
  type: string
  text: string
  turnId: string | null
  toolName?: string
  // call_id: pairs a call with its output, and an ask with its answer.
  toolUseId?: string
  // relay lane: the thread that sent it (a subagent's parent).
  peer?: string
}

// lore's Request (parse.ts) — the four billed classes plus thinking — with the
// turn it belongs to and where the reading came from.
export type CodexRequest = Request & {
  ts: string | null
  turnId: string | null
  // `record` is a `token_usage_record` (keyed by its response id). `count` is
  // the older `token_count` event, used only when a thread has no record at
  // all: it carries no id (lore names it by ordinal) and a re-emission repeats
  // it, so one whose thread total did not move is not a request.
  usageSource: 'record' | 'count'
}

export type CodexTurn = {
  turnId: string
  n: number
  startedTs: string | null
  completedTs: string | null
  durationMs: number | null
  ttftMs: number | null
  model: string | null
  effort: string | null
  trigger: string | null
  // What was submitted to open the turn: the user's words on a worker, null
  // on a guardian (its input is evidence, withheld).
  opener: string | null
  lastAgentMessage: string | null
  aborted: string | null
  error: string | null
  verdict: z.infer<typeof Verdict> | null
  requests: number
  output: number
  // Every tool call of the turn: custom_tool_call + function_call + searches.
  // `execs` is the custom_tool_call share — the wiki's headline "tool calls".
  tools: number
  execs: number
  questions: number
}

export type CodexQuestion = {
  callId: string
  index: number
  turnId: string | null
  askedTs: string | null
  title: string | null
  options: string[] | null
  accepted: boolean | null
  answer: string | null
  answeredTs: string | null
  // The answer is not one of the options offered: the user typed their own.
  freeText: boolean | null
}

export type CodexThread = {
  threadId: string
  // The root thread of the tree this one belongs to (itself, for a root).
  rootThreadId: string
  parentThreadId: string | null
  kind: ThreadKind
  threadSource: string | null
  originator: string | null
  cliVersion: string | null
  cwd: string | null
  git: { repositoryUrl: string | null; commitHash: string | null; branch: string | null } | null
  model: string | null
  lines: number
  firstTs: string | null
  lastTs: string | null
  lastActivityTs: string | null
  turns: CodexTurn[]
  requests: CodexRequest[]
  messages: CodexMessage[]
  questions: CodexQuestion[]
  // Reasoning records seen, and how many said anything in plaintext.
  reasoning: { records: number; summarized: number; encrypted: number }
  // What was read and deliberately NOT indexed: on a guardian, every
  // user/developer record (the policy and the worker's transcript re-embedded
  // as evidence — 115 MB of it across 45 judges when first measured).
  withheld: { records: number; chars: number }
  // Record kinds with no decoder, and records a decoder refused.
  unknown: Record<string, number>
  malformed: Record<string, number>
}

// ---- the token mapping --------------------------------------------------------

// Codex `input_tokens` INCLUDES `cached_input_tokens`; lore's `input` IS the
// uncached input (usage.ts). Map them one-for-one and the attrition thread
// reads 256.0M on a lane lore's convention wants at 4.75M — 54x over, and a
// wrong list price the day a rate exists. Subtract.
// `reasoning_output_tokens` is a sub-count of output (≤ output on every
// record), which is exactly what lore's `thinking` is.
// `cache_write_input_tokens` is 0 on all 21,050 records, so whether `input`
// includes it too cannot be measured here; it is carried and not subtracted.
export function mapUsage(u: Usage): Pick<Request, 'input' | 'cacheWrite' | 'cacheWrite5m' | 'cacheWrite1h' | 'cacheRead' | 'output' | 'thinking'> {
  const cached = u.cached_input_tokens ?? 0
  return {
    input: Math.max(0, u.input_tokens - cached),
    cacheWrite: u.cache_write_input_tokens ?? 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: cached,
    output: u.output_tokens,
    thinking: u.reasoning_output_tokens ?? 0,
  }
}

// ---- thread kind ------------------------------------------------------------

// A guardian is `thread_source: guardian_review` — or, before that label
// existed (0.131 – 0.145: 7 threads, 2 of them with no `parent_thread_id`),
// `thread_source: subagent` with `source.subagent.other: guardian`, which is
// on the new ones too. Every OTHER thread with a parent or a subagent source
// is a subagent and is NOT a guardian: its input is its parent's instruction,
// not evidence, and its output is work, not a verdict.
export function threadKind(m: SessionMeta): ThreadKind {
  const sub = m.source && typeof m.source === 'object' ? m.source.subagent : null
  if (m.thread_source === 'guardian_review') return 'guardian'
  if (sub && typeof sub === 'object' && 'other' in sub && sub.other === 'guardian') return 'guardian'
  if (sub != null || m.parent_thread_id || m.thread_source === 'subagent') return 'subagent'
  return 'worker'
}

// ---- instants ---------------------------------------------------------------

// `started_at` / `completed_at` are epoch SECONDS (4,160 of 4,160), and they
// are the turn's real instants. The record's own `timestamp` usually agrees —
// but 28 guardian threads of 0.153.4 stamp EVERY record with the thread's
// creation instant, turns that ran an hour later included. So a turn's
// instants come off its own fields first, and a message or request stamped
// outside its turn is moved to the nearer end of it: on a thread with real
// stamps this changes nothing, and on those 28 a request lands in the day it
// was made rather than the day its thread was born.
function instant(epochSeconds: number | null | undefined): string | null {
  return typeof epochSeconds === 'number' && epochSeconds > 0 ? new Date(epochSeconds * 1000).toISOString() : null
}
function within(ts: string | null, t: { startedTs: string | null; completedTs: string | null }): string | null {
  if (!ts) return t.startedTs
  if (t.startedTs && ts < t.startedTs) return t.startedTs
  // completed_at is floored to the second: a stamp inside that second is real.
  if (t.completedTs && Date.parse(ts) - Date.parse(t.completedTs) > 1000) return t.completedTs
  return ts
}

// ---- the parser -------------------------------------------------------------

const WORK_LANES = new Set<CodexLane>(['prompt', 'text', 'thinking', 'tool', 'relay', 'question'])
const texts = (items: { text?: string | null }[] | null | undefined) =>
  (items ?? [])
    .map((c) => c.text ?? '')
    .filter(Boolean)
    .join('\n\n')

// One rollout's text → one thread. Pure: no disk, no clock. Null when the
// text holds no `session_meta` (not a rollout). A torn last line is skipped —
// a live rollout is appended while it is read.
export function parseRollout(text: string): CodexThread | null {
  let meta: SessionMeta | null = null
  let kind: ThreadKind = 'worker'
  const turns = new Map<string, CodexTurn>()
  let open: CodexTurn | null = null
  let model: string | null = null
  let effort: string | null = null
  const records = new Map<string, CodexRequest>()
  const counts: CodexRequest[] = []
  let lastTotal: number | null = null
  const messages: CodexMessage[] = []
  const questions = new Map<string, CodexQuestion>()
  const asks = new Set<string>()
  // role=user records of the open turn with no `content_item_kinds`, waiting
  // to learn whether a UserMessage item claims them.
  let pending: { message: CodexMessage; body: string }[] = []
  const reasoning = { records: 0, summarized: 0, encrypted: 0 }
  const withheld = { records: 0, chars: 0 }
  const unknown: Record<string, number> = {}
  const malformed: Record<string, number> = {}
  let lines = 0
  let firstTs: string | null = null
  let lastTs: string | null = null
  let lastActivityTs: string | null = null
  let seq = 0

  const flush = () => {
    for (const p of pending) messages.push(p.message)
    pending = []
  }
  const push = (m: CodexMessage) => {
    messages.push(m)
    if (m.ts && WORK_LANES.has(m.lane)) lastActivityTs = m.ts
  }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const env = Envelope.safeParse(json(line))
    if (!env.success) continue
    lines++
    const { type, payload } = env.data
    const ts = env.data.timestamp ?? null
    const ordinal = env.data.ordinal ?? seq
    seq = ordinal + 1
    if (ts) {
      firstTs ??= ts
      lastTs = ts
    }
    const k = kindOf(type, payload)
    if (!isKind(k)) {
      unknown[k] = (unknown[k] ?? 0) + 1
      continue
    }
    const bad = () => {
      malformed[k] = (malformed[k] ?? 0) + 1
    }
    const turnId = open?.turnId ?? null
    const base = { ordinal, ts, turnId }

    switch (k) {
      case 'session_meta': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        // A resumed thread re-states its meta; the first one is the thread.
        if (!meta) {
          meta = p.data
          kind = threadKind(p.data)
        }
        break
      }
      case 'turn_context': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        model = p.data.model ?? model
        effort = p.data.effort ?? effort
        const t = (p.data.turn_id ? turns.get(p.data.turn_id) : null) ?? open
        if (t) {
          t.model = p.data.model ?? t.model
          t.effort = p.data.effort ?? t.effort
        }
        break
      }
      case 'event_msg/thread_settings_applied': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        // The model before any turn has said its own (a zero-turn thread has
        // no turn_context at all).
        model ??= p.data.thread_settings?.model ?? null
        effort ??= p.data.thread_settings?.reasoning_effort ?? null
        break
      }
      case 'event_msg/task_started': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        flush()
        open = {
          turnId: p.data.turn_id,
          n: turns.size + 1,
          startedTs: instant(p.data.started_at) ?? ts,
          completedTs: null,
          durationMs: null,
          ttftMs: null,
          model,
          effort,
          trigger: p.data.turn_attribution?.turn_trigger ?? null,
          opener: null,
          lastAgentMessage: null,
          aborted: null,
          error: null,
          verdict: null,
          requests: 0,
          output: 0,
          tools: 0,
          execs: 0,
          questions: 0,
        }
        // A turn id seen twice is one turn (a resume replays the event).
        if (!turns.has(open.turnId)) turns.set(open.turnId, open)
        else open = turns.get(open.turnId) ?? open
        break
      }
      case 'event_msg/task_complete': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        flush()
        const t = turns.get(p.data.turn_id)
        if (t) {
          t.completedTs = instant(p.data.completed_at) ?? ts
          t.durationMs = p.data.duration_ms ?? null
          t.ttftMs = p.data.time_to_first_token_ms ?? null
          t.lastAgentMessage = p.data.last_agent_message ?? null
          t.error = p.data.error ? (p.data.error.codex_error_info ?? 'error') : null
          if (kind === 'guardian' && t.lastAgentMessage) t.verdict = Verdict.safeParse(json(t.lastAgentMessage)).data ?? null
        }
        if (p.data.error) messages.push({ ...base, turnId: p.data.turn_id, lane: 'event', type: 'task_complete', text: `error: ${p.data.error.codex_error_info ?? 'error'}` })
        if (open?.turnId === p.data.turn_id) open = null
        break
      }
      case 'event_msg/turn_aborted': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        flush()
        const t = turns.get(p.data.turn_id)
        if (t) {
          t.aborted = p.data.reason ?? 'aborted'
          t.completedTs ??= ts
        }
        messages.push({ ...base, turnId: p.data.turn_id, lane: 'event', type: 'turn_aborted', text: `turn_aborted: ${p.data.reason ?? ''}`.trim() })
        if (open?.turnId === p.data.turn_id) open = null
        break
      }
      case 'token_usage_record': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        const turn = p.data.turn_id ?? turnId
        const t = turn ? turns.get(turn) : null
        records.set(p.data.response_id, {
          id: p.data.response_id,
          model: t?.model ?? model,
          effort: t?.effort ?? effort,
          stopReason: null,
          ...mapUsage(p.data.usage),
          ts,
          turnId: turn,
          usageSource: 'record',
        })
        break
      }
      case 'event_msg/token_count': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        const last = p.data.info?.last_token_usage
        const total = p.data.info?.total_token_usage?.total_tokens ?? null
        // A re-emission (the rate-limit half of the event arriving again)
        // repeats the totals: 661 of 4,810 on the threads that need this.
        if (!last || total == null || total === lastTotal) break
        lastTotal = total
        // A child thread opens on its parent's running total with a last
        // usage of zero: a carried balance, not a request.
        if (last.input_tokens === 0 && last.output_tokens === 0) break
        counts.push({ id: `count:${ordinal}`, model: open?.model ?? model, effort: open?.effort ?? effort, stopReason: null, ...mapUsage(last), ts, turnId, usageSource: 'count' })
        break
      }
      case 'event_msg/item_completed': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        // Everything but the turn's INPUT is a second copy of a response_item.
        if (p.data.item.type !== 'UserMessage') break
        const body = texts(p.data.item.content)
        if (!body) break
        // The model-visible copy of this same input, if it was waiting.
        const twin = pending.findIndex((x) => x.body === body)
        if (twin >= 0) pending.splice(twin, 1)
        // A guardian's input is the review request: the worker's transcript,
        // re-embedded. Already counted off its response_item; never indexed.
        if (kind === 'guardian') break
        const t = (p.data.turn_id ? turns.get(p.data.turn_id) : null) ?? open
        const answers = decodeReply(body)
        if (answers) {
          // An answer is the user's words: it opens its turn on the spine,
          // and is filed in the question lane beside what it answers.
          if (t) t.opener ??= answers.map((a) => a.answer).join('\n')
          for (const a of answers) {
            const q = questions.get(`${a.callId}/${a.index}`)
            if (q && q.answer == null) {
              q.answer = a.answer
              q.answeredTs = ts
              q.freeText = q.options ? !q.options.includes(a.answer) : null
            }
            push({ ...base, turnId: t?.turnId ?? turnId, lane: 'question', type: 'answer', text: a.answer, toolName: ASK_TOOL, toolUseId: a.callId })
          }
          break
        }
        if (t) t.opener ??= body
        // A subagent's input is its PARENT's instruction: another agent's
        // words, which is what the relay lane is.
        if (kind === 'subagent') push({ ...base, turnId: t?.turnId ?? turnId, lane: 'relay', type: 'user', text: body, ...(meta?.parent_thread_id ? { peer: meta.parent_thread_id } : {}) })
        else push({ ...base, turnId: t?.turnId ?? turnId, lane: 'prompt', type: 'user', text: body })
        break
      }
      case 'response_item/message': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        const body = texts(p.data.content)
        if (p.data.role === 'assistant') {
          if (body) push({ ...base, lane: 'text', type: p.data.phase ?? 'assistant', text: body })
          break
        }
        // user / developer: the context the harness assembled for the model.
        if (kind === 'guardian') {
          withheld.records++
          withheld.chars += body.length
          break
        }
        if (!body) break
        const message: CodexMessage = { ...base, lane: 'meta', type: p.data.role, text: body }
        if (p.data.role !== 'user') {
          messages.push(message)
          break
        }
        // AUTHORSHIP IS A FIELD. A role=user record is the turn's input only
        // if Codex says so: `content_item_kinds` all `user.*`, or — on CLIs
        // older than that field — a UserMessage item of the same turn carrying
        // the same text. The input itself is indexed off that item (above),
        // so its model-visible copy is dropped; everything else under
        // role=user is injection (`<recommended_plugins>`, AGENTS.md,
        // `<environment_context>`, a goal's `<goal_context>`) and is `meta`.
        const kinds = p.data.internal_chat_message_metadata_passthrough?.content_item_kinds
        if (kinds?.length) {
          if (!kinds.every((x) => x.startsWith('user.'))) messages.push(message)
        } else pending.push({ message, body })
        break
      }
      case 'response_item/reasoning': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        reasoning.records++
        if (p.data.encrypted_content) reasoning.encrypted++
        const said = (p.data.summary ?? [])
          .map((s) => s.text ?? '')
          .filter(Boolean)
          .join('\n')
        // An encrypted body still happened: the turn was working.
        if (ts) lastActivityTs = ts
        if (!said) break
        reasoning.summarized++
        push({ ...base, lane: 'thinking', type: 'reasoning', text: said })
        break
      }
      case 'response_item/function_call': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        if (open) open.tools++
        if (p.data.name === ASK_TOOL) {
          asks.add(p.data.call_id)
          const ask = Ask.safeParse(json(p.data.arguments ?? ''))
          if (!ask.success) {
            bad()
            break
          }
          ask.data.questions.forEach((q, index) => {
            const title = q.title ?? q.question ?? null
            questions.set(`${p.data.call_id}/${index}`, { callId: p.data.call_id, index, turnId, askedTs: ts, title, options: q.options ?? null, accepted: null, answer: null, answeredTs: null, freeText: null })
            if (open) open.questions++
            push({ ...base, lane: 'question', type: 'ask', text: [title ?? '', ...(q.options ?? []).map((o) => `- ${o}`)].join('\n').trim(), toolName: ASK_TOOL, toolUseId: p.data.call_id })
          })
          break
        }
        const name = p.data.namespace ? `${p.data.namespace}:${p.data.name}` : p.data.name
        push({ ...base, lane: 'tool', type: 'function_call', text: `${name} ${(p.data.arguments ?? '').slice(0, TOOL_TEXT_CAP)}`, toolName: name, toolUseId: p.data.call_id })
        break
      }
      case 'response_item/custom_tool_call': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        if (open) {
          open.tools++
          open.execs++
        }
        push({ ...base, lane: 'tool', type: 'custom_tool_call', text: `${p.data.name} ${(p.data.input ?? '').slice(0, TOOL_TEXT_CAP)}`, toolName: p.data.name, toolUseId: p.data.call_id })
        break
      }
      case 'response_item/function_call_output':
      case 'response_item/custom_tool_call_output': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        const out = typeof p.data.output === 'string' ? p.data.output : texts(p.data.output)
        if (asks.has(p.data.call_id)) {
          // The ack of an ask says only whether it was queued.
          const ack = AskAck.safeParse(json(out))
          for (const q of questions.values()) if (q.callId === p.data.call_id) q.accepted = ack.success ? ack.data.accepted : null
          break
        }
        push({ ...base, lane: 'tool', type: p.data.type, text: headTail(out), toolUseId: p.data.call_id })
        break
      }
      case 'response_item/tool_search_call': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        if (open) open.tools++
        push({ ...base, lane: 'tool', type: 'tool_search_call', text: `tool_search ${p.data.arguments?.query ?? ''}`.trim(), toolName: 'tool_search', ...(p.data.call_id ? { toolUseId: p.data.call_id } : {}) })
        break
      }
      case 'response_item/web_search_call': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        if (open) open.tools++
        push({ ...base, lane: 'tool', type: 'web_search_call', text: `web_search ${p.data.action?.query ?? ''}`.trim(), toolName: 'web_search' })
        break
      }
      case 'compacted': {
        const p = RECORDS[k].safeParse(payload)
        if (!p.success) {
          bad()
          break
        }
        messages.push({ ...base, lane: 'event', type: 'compacted', text: `compacted: window ${p.data.window_number ?? '?'}` })
        break
      }
      // Structure only: nothing in these is lore's to index.
      case 'world_state':
      case 'event_msg/thread_goal_updated':
      case 'response_item/tool_search_output':
      case 'response_item/compaction':
      case 'response_item/additional_tools':
        if (!RECORDS[k].safeParse(payload).success) bad()
        break
    }
  }
  flush()
  if (!meta) return null
  const m: SessionMeta = meta

  // A thread's requests are its token_usage_records; the count events stand
  // in only where there is not one record.
  const requests = records.size ? [...records.values()] : counts
  for (const r of requests) {
    const t = r.turnId ? turns.get(r.turnId) : null
    if (!t) continue
    t.requests++
    t.output += r.output
    r.model ??= t.model
  }
  messages.sort((a, b) => a.ordinal - b.ordinal)
  for (const x of [...messages, ...requests]) {
    const t = x.turnId ? turns.get(x.turnId) : null
    if (t) x.ts = within(x.ts, t)
  }
  const all = [...turns.values()]
  // Activity and the thread's end, re-read off the instants as corrected.
  const latest = (xs: (string | null)[], seed: string | null) => xs.reduce<string | null>((m, x) => (x && (!m || x > m) ? x : m), seed)
  const active = latest([...messages.filter((x) => WORK_LANES.has(x.lane)).map((x) => x.ts), ...requests.map((r) => r.ts)], lastActivityTs)
  const ended = latest([active, ...all.map((t) => t.completedTs ?? t.startedTs)], lastTs)
  return {
    threadId: m.id,
    rootThreadId: m.session_id ?? m.id,
    parentThreadId: m.parent_thread_id ?? null,
    kind,
    threadSource: m.thread_source ?? null,
    originator: m.originator ?? null,
    cliVersion: m.cli_version ?? null,
    cwd: m.cwd ?? null,
    git: m.git ? { repositoryUrl: m.git.repository_url ?? null, commitHash: m.git.commit_hash ?? null, branch: m.git.branch ?? null } : null,
    model: all.find((t) => t.model)?.model ?? model,
    lines,
    // The thread's own instant (UTC), never the path's day (local).
    firstTs: m.timestamp ?? firstTs,
    lastTs: ended,
    lastActivityTs: active,
    turns: all,
    requests,
    messages,
    questions: [...questions.values()],
    reasoning,
    withheld,
    unknown,
    malformed,
  }
}

// ---- the repo key -----------------------------------------------------------

// `git@github.com:owner/name.git`, `https://github.com/owner/name(.git)` and
// `ssh://git@github.com/owner/name` are one repo: `github.com/owner/name`.
export function normalizeRepoUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+?)(?:\.git)?\/?$/i.exec(url.trim())
  return m ? `${m[1]!.toLowerCase()}/${m[2]}` : null
}

const WorktreeOwner = z.object({ ownerThreadId: z.string().nullish() })
export type RepoHop = { repoPath: string; worktree: string | null; ownerThreadId: string | null }

// The worktree hop. Codex's cwd is USUALLY `<codex home>/worktrees/<id>/<repo>`,
// whose `.git` FILE reads `gitdir: <repo>/.git/worktrees/<name>`; the repo side
// keeps `codex-thread.json` naming the thread that owns the worktree. Exact
// and two-way — no slug to verify. But a worktree is deleted when its thread
// is done (5 of 15 still on disk, 2026-11-14), so the hop is what the disk
// still knows, taken at index time and kept; `session_meta.git` is the key
// that never needed the disk.
// A cwd under `<repo>/.claude/worktrees/<name>` folds like a Claude worktree
// (31 worker threads were run from inside one), and a plain checkout is
// itself. `read` is injected so the parser stays testable off disk.
export function repoHop(cwd: string | null, read: (path: string) => string | null = readOrNull): RepoHop | null {
  if (!cwd) return null
  const codex = /^(.*\/worktrees\/[^/]+\/[^/]+)(?:\/|$)/.exec(cwd)
  if (codex && cwd.includes('/.codex/')) {
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(read(join(codex[1]!, '.git')) ?? '')?.[1]
    const at = gitdir?.indexOf('/.git/worktrees/') ?? -1
    if (!gitdir || at < 0) return null
    const owner = WorktreeOwner.safeParse(json(read(join(gitdir, 'codex-thread.json')) ?? ''))
    return { repoPath: gitdir.slice(0, at), worktree: gitdir.slice(at + '/.git/worktrees/'.length), ownerThreadId: owner.success ? (owner.data.ownerThreadId ?? null) : null }
  }
  const claude = cwd.indexOf('/.claude/worktrees/')
  if (claude >= 0) return { repoPath: cwd.slice(0, claude), worktree: cwd.slice(claude + '/.claude/worktrees/'.length).split('/')[0] ?? null, ownerThreadId: null }
  return { repoPath: cwd, worktree: null, ownerThreadId: null }
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// What a Codex thread keys to instead of a well: the REPO. The remote's
// normalized url when `session_meta.git` has one (433 of 454) — it survives
// the worktree, the checkout and the machine — else the local repo path the
// hop found, else the cwd.
export function repoKey(t: Pick<CodexThread, 'cwd' | 'git'>, hop: RepoHop | null): string | null {
  return normalizeRepoUrl(t.git?.repositoryUrl) ?? hop?.repoPath ?? t.cwd
}

// ---- the files --------------------------------------------------------------

// `rollout-<YYYY-MM-DD>T<HH-MM-SS>-<threadId>.jsonl[.zst]`. The stamp — and
// the `<YYYY>/<MM>/<DD>` directories above it — is the LOCAL wall clock of the
// machine that minted the thread; the records inside are UTC. 150 of 454
// rollouts sit under a day that is not their UTC day. Nothing filters on it.
export const ROLLOUT_NAME = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/

export type RolloutFile = { path: string; threadId: string; localStamp: string; size: number; mtimeMs: number; archived: boolean; compressed: boolean }

// `~/.codex/external_agent_session_imports.json`: Codex's ledger of the
// Claude Code transcripts it IMPORTED as threads of its own. Every
// `imported_thread_id` is a rollout on disk (50 of 50: 39 under sessions/, 11
// archived) that is a copy of a session lore already indexes from its real
// source. THIS FILE IS THE EXCLUSION LIST: index one and the same
// conversation answers twice under two ids, with its tokens counted twice.
export const Imports = z.object({ records: z.array(z.object({ imported_thread_id: z.string(), source_path: z.string().nullish() })) })
export function readImports(codexHome: string): Set<string> {
  const parsed = Imports.safeParse(json(readOrNull(join(codexHome, 'external_agent_session_imports.json')) ?? ''))
  return new Set(parsed.success ? parsed.data.records.map((r) => r.imported_thread_id) : [])
}

// Every rollout under the Codex home that is Codex's own: `sessions/` (by
// local day) and `archived_sessions/` (flat), compressed or not, MINUS the
// imports. A thread present twice (mid-compression, or archived and live)
// is listed once, by its newest file.
export function listRollouts(codexHome: string): { files: RolloutFile[]; imported: number } {
  const excluded = readImports(codexHome)
  const byThread = new Map<string, RolloutFile>()
  let imported = 0
  const walk = (dir: string, archived: boolean) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) {
        walk(path, archived)
        continue
      }
      const m = ROLLOUT_NAME.exec(e.name)
      if (!m) continue
      if (excluded.has(m[2]!)) {
        imported++
        continue
      }
      const st = statSync(path)
      const f: RolloutFile = { path, threadId: m[2]!, localStamp: m[1]!, size: st.size, mtimeMs: Math.floor(st.mtimeMs), archived, compressed: m[3] != null }
      const seen = byThread.get(f.threadId)
      if (!seen || seen.mtimeMs < f.mtimeMs) byThread.set(f.threadId, f)
    }
  }
  walk(join(codexHome, 'sessions'), false)
  walk(join(codexHome, 'archived_sessions'), true)
  return { files: [...byThread.values()].sort((a, b) => a.path.localeCompare(b.path)), imported }
}

export async function readRollout(path: string): Promise<string> {
  const bytes = await Bun.file(path).bytes()
  return new TextDecoder().decode(path.endsWith('.zst') ? Bun.zstdDecompressSync(bytes) : bytes)
}
