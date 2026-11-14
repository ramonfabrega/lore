import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ASK_TOOL, Ask, Envelope, RECORDS, ROLLOUT_NAME, Usage, Verdict, kindOf, parseRollout } from '../src/codex'

// The Codex fixture corpus (scripts/codex-corpus.ts): rollouts as each Codex
// version wrote them, PROJECTED through the schemas src/codex.ts reads them
// with and scrubbed of every word. Every version here must parse with every
// schema and hold the invariants the adapter leans on; a version that moves
// a field fails HERE on the day it is snapshotted. And because the repo is
// public and a rollout is a transcript, the scrub is re-checked string by
// string: this test, not the script, is what stands between a transcript and
// the remote.

const ROOT = join(import.meta.dir, 'fixtures', 'codex')
const versions = existsSync(ROOT) ? readdirSync(ROOT).filter((v) => readdirSync(join(ROOT, v)).some((f) => ROLLOUT_NAME.test(f))) : []
const fixtures = versions.flatMap((version) =>
  readdirSync(join(ROOT, version))
    .filter((f) => ROLLOUT_NAME.test(f))
    .map((file) => ({ version, file, text: readFileSync(join(ROOT, version, file), 'utf8') })),
)
const records = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => Envelope.parse(JSON.parse(l)))

// ---- the scrub, re-derived independently of the script ----------------------
const HOLE = /^\[\d+\]$/
const FAKE_ID = /^(00000000-0000-7000-8000-\d{12}|id_\d+)$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const ENUM_VALUE = /^[A-Za-z0-9_][A-Za-z0-9_.:\- ]{0,47}$/
const KIND_VALUE = /^[a-z_]+(\.[a-z_]+)*$/
const ENUM_KEYS = new Set(['type', 'role', 'phase', 'status', 'thread_source', 'originator', 'cli_version', 'model', 'model_provider', 'history_mode', 'effort', 'reasoning_effort', 'collaboration_mode_kind', 'turn_trigger', 'reason', 'name', 'namespace', 'multi_agent_version', 'codex_error_info', 'outcome', 'risk_level', 'user_authorization', 'other', 'source', 'agent_role'])
const CONSTANT: Record<string, string[]> = {
  cwd: ['/Users/u/code/fun/repo', '/Users/u/.codex/worktrees/0001/repo'],
  repository_url: ['https://github.com/u/repo.git'],
  branch: ['branch'],
  commit_hash: ['0'.repeat(40)],
}
// No work tree, no home but the placeholder one, no address. (Work PROJECT
// names are refused by the script, which reads them off the disk it runs
// on — a public test does not list them.)
const NEVER = /code\/work|\/Users\/(?!u\/)|@[a-z0-9-]+\.[a-z]{2,}/i
const REPLY = /^<send_user_message_question_reply>\n([\s\S]*)\n<\/send_user_message_question_reply>$/
const tryJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

// Why a string is allowed to be in a fixture — or null: it is not.
function allowed(key: string, v: string, parent: Record<string, unknown>): string | null {
  if (NEVER.test(v)) return null
  if (HOLE.test(v)) return 'hole'
  if (key === 'timestamp') return ISO.test(v) ? 'instant' : null
  if (key === 'id' || key.endsWith('_id')) return FAKE_ID.test(v) ? 'id' : null
  if (key === 'content_item_kinds') return KIND_VALUE.test(v) ? 'kind' : null
  if (ENUM_KEYS.has(key)) return ENUM_VALUE.test(v) ? 'enum' : null
  if (CONSTANT[key]) return CONSTANT[key].includes(v) ? 'constant' : null
  // The three strings that are structure: each must be exactly its schema,
  // holding nothing but holes, enums and fake ids.
  if (key === 'arguments' && parent.name === ASK_TOOL) {
    const ask = z.strictObject({ questions: z.array(z.strictObject({ title: z.string().optional(), question: z.string().optional(), options: z.array(z.string()).optional() })) }).safeParse(tryJson(v))
    return ask.success && ask.data.questions.every((q) => [q.title, q.question, ...(q.options ?? [])].every((s) => s === undefined || HOLE.test(s))) ? 'ask' : null
  }
  if (key === 'last_agent_message') {
    const verdict = z.strictObject({ outcome: z.string(), risk_level: z.string().nullish(), user_authorization: z.string().nullish(), rationale: z.string().nullish() }).safeParse(tryJson(v))
    if (!verdict.success) return null
    const { rationale, ...enums } = verdict.data
    return (rationale == null || HOLE.test(rationale)) && Object.values(enums).every((s) => s == null || ENUM_VALUE.test(s) || HOLE.test(s)) ? 'verdict' : null
  }
  if (key === 'output') return /^\{"accepted":(true|false)\}$/.test(v) ? 'ack' : null
  if (key === 'text') {
    const reply = z.array(z.strictObject({ questionItemId: z.string(), question: z.string(), answer: z.string() })).safeParse(tryJson(REPLY.exec(v)?.[1] ?? ''))
    if (!reply.success) return null
    return reply.data.every((r) => {
      const id = z.tuple([z.literal(ASK_TOOL), z.string().regex(FAKE_ID), z.number()]).safeParse(tryJson(r.questionItemId))
      return (id.success || HOLE.test(r.questionItemId)) && HOLE.test(r.question) && HOLE.test(r.answer)
    })
      ? 'reply'
      : null
  }
  return null
}
function walk(v: unknown, key: string, parent: Record<string, unknown>, bad: string[]) {
  if (typeof v === 'string') {
    if (!allowed(key, v, parent)) bad.push(`${key}: ${v.slice(0, 60)}`)
  } else if (Array.isArray(v)) for (const x of v) walk(x, key, parent, bad)
  else if (v && typeof v === 'object') {
    const self = z.record(z.string(), z.unknown()).parse(v)
    for (const [k, x] of Object.entries(self)) walk(x, k, self, bad)
  }
}

describe('codex corpus', () => {
  test('at least one Codex version is snapshotted, with a worker, a guardian that judged, one that never ran, and an answered question', () => {
    expect(versions.length).toBeGreaterThan(0)
    const threads = fixtures.map((f) => parseRollout(f.text))
    expect(threads.some((t) => t?.kind === 'worker' && t.turns.length > 0)).toBe(true)
    expect(threads.some((t) => t?.kind === 'guardian' && t.turns.some((x) => x.verdict))).toBe(true)
    expect(threads.some((t) => t?.kind === 'guardian' && t.turns.length === 0)).toBe(true)
    expect(threads.some((t) => t?.questions.some((q) => q.answer != null))).toBe(true)
  })

  test('the path day is local: at least one fixture sits under a day that is not its UTC day', () => {
    const off = fixtures.filter((f) => {
      const stamp = ROLLOUT_NAME.exec(f.file)?.[1] ?? ''
      return stamp.slice(0, 10) !== (parseRollout(f.text)?.firstTs ?? '').slice(0, 10)
    })
    expect(off.length).toBeGreaterThan(0)
  })

  for (const { version, file, text } of fixtures) {
    const name = `codex ${version} ${file.slice(-17, -6)}`

    test(`${name}: the scrub held — every string is a hole, an enum, a fake id, an instant or a constant`, () => {
      const bad: string[] = []
      for (const r of records(text)) {
        const payload = z.record(z.string(), z.unknown()).parse(r.payload)
        walk(payload, '', payload, bad)
        expect(r.timestamp == null || ISO.test(r.timestamp)).toBe(true)
        expect(ENUM_VALUE.test(r.type)).toBe(true)
      }
      expect(bad).toEqual([])
      // Belt and braces, over the raw bytes: no work tree, no home, no address.
      expect(text).not.toMatch(NEVER)
    })

    test(`${name}: every record is exactly what its schema declares — no kind without a decoder, no key outside one`, () => {
      for (const r of records(text)) {
        const k = kindOf(r.type, r.payload)
        expect(k in RECORDS, `no decoder for ${k}`).toBe(true)
        const schema = RECORDS[k as keyof typeof RECORDS]
        const parsed = schema.safeParse(r.payload)
        expect(parsed.success, `${k} refused`).toBe(true)
        // Strip mode drops what a schema does not declare: a payload that
        // survives the round trip unchanged carried nothing else.
        if (parsed.success) expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(r.payload)
      }
    })

    test(`${name}: parses to a thread that holds the adapter's invariants`, () => {
      const t = parseRollout(text)
      expect(t).not.toBeNull()
      if (!t) return
      expect(t.unknown).toEqual({})
      expect(t.malformed).toEqual({})
      expect(t.cliVersion).toBe(version)
      // The thread id is in the file name, and the name's stamp is not the instant.
      expect(ROLLOUT_NAME.exec(file)?.[2]).toBe(t.threadId)
      expect(t.firstTs).toMatch(ISO)

      const raw = records(text)
      const started = new Set(raw.filter((r) => kindOf(r.type, r.payload) === 'event_msg/task_started').map((r) => RECORDS['event_msg/task_started'].parse(r.payload).turn_id))
      // A thread ran iff it started a turn — never bytes, never mtime.
      expect(t.turns.length).toBe(started.size)
      if (t.turns.length === 0) {
        expect(t.requests).toEqual([])
        expect(t.messages.filter((m) => m.lane !== 'event')).toEqual([])
        expect(t.lastActivityTs).toBeNull()
      }

      // The mapping's premise, on the raw usage: total = input + output (the
      // cache is INSIDE input), cached ≤ input, reasoning ≤ output.
      const usages = raw.flatMap((r) => {
        const k = kindOf(r.type, r.payload)
        if (k === 'token_usage_record') return [RECORDS[k].parse(r.payload).usage]
        if (k === 'event_msg/token_count') return [RECORDS[k].parse(r.payload).info?.last_token_usage].filter((u): u is z.infer<typeof Usage> => u != null && u.input_tokens > 0)
        return []
      })
      for (const u of usages) {
        if (u.total_tokens != null) expect(u.total_tokens).toBe(u.input_tokens + u.output_tokens)
        expect(u.cached_input_tokens ?? 0).toBeLessThanOrEqual(u.input_tokens)
        expect(u.reasoning_output_tokens ?? 0).toBeLessThanOrEqual(u.output_tokens)
      }
      for (const r of t.requests) {
        expect(r.input).toBeGreaterThanOrEqual(0)
        expect(r.thinking).toBeLessThanOrEqual(r.output)
        // Every request names a model, and none of them is priced.
        expect(r.model).toBeTruthy()
        expect(r.model).not.toMatch(/^claude/)
      }
      // One request per response id: records, or — on a CLI with none — counts.
      const recordIds = raw.filter((r) => r.type === 'token_usage_record').map((r) => RECORDS.token_usage_record.parse(r.payload).response_id)
      if (recordIds.length) expect(t.requests.map((r) => r.id).sort()).toEqual([...new Set(recordIds)].sort())
      else for (const r of t.requests) expect(r.usageSource).toBe('count')

      // Reasoning: every body is encrypted.
      expect(t.reasoning.encrypted).toBe(t.reasoning.records)
      expect(t.messages.filter((m) => m.lane === 'thinking')).toHaveLength(t.reasoning.summarized)

      const inputs = raw.filter((r) => kindOf(r.type, r.payload) === 'event_msg/item_completed' && RECORDS['event_msg/item_completed'].parse(r.payload).item.type === 'UserMessage').length
      if (t.kind === 'guardian') {
        // Verdict, usage, parentage — and not one row of evidence.
        expect(t.messages.filter((m) => m.lane === 'prompt' || m.lane === 'meta' || m.lane === 'relay')).toEqual([])
        expect(t.parentThreadId != null || t.threadSource === 'subagent').toBe(true)
        if (t.parentThreadId) expect(t.rootThreadId).toBe(t.parentThreadId)
        if (inputs) expect(t.withheld.records).toBeGreaterThanOrEqual(inputs)
        for (const turn of t.turns) if (turn.lastAgentMessage) expect(Verdict.safeParse(JSON.parse(turn.lastAgentMessage)).success).toBe(true)
      } else {
        expect(t.withheld).toEqual({ records: 0, chars: 0 })
        expect(t.rootThreadId).toBe(t.threadId)
        // What the user submitted is the prompt lane (or an answer) — one row
        // per input, and nothing else is in it.
        const answers = t.messages.filter((m) => m.lane === 'question' && m.type === 'answer').length
        expect(t.messages.filter((m) => m.lane === 'prompt').length + answers).toBeGreaterThanOrEqual(Math.min(inputs, 1))
        expect(t.messages.filter((m) => m.lane === 'prompt').length).toBeLessThanOrEqual(inputs)
      }

      // The question pair: every ask is a function_call whose arguments parse,
      // and every answered one was joined on its call id.
      const asks = raw.filter((r) => kindOf(r.type, r.payload) === 'response_item/function_call').map((r) => RECORDS['response_item/function_call'].parse(r.payload)).filter((c) => c.name === ASK_TOOL)
      expect(t.questions.length).toBe(asks.reduce((n, c) => n + Ask.parse(JSON.parse(c.arguments ?? '')).questions.length, 0))
      for (const q of t.questions) expect(asks.some((c) => c.call_id === q.callId)).toBe(true)
      expect(t.messages.filter((m) => m.lane === 'tool' && m.toolName === ASK_TOOL)).toEqual([])
    })
  }
})
