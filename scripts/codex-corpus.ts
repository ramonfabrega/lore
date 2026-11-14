#!/usr/bin/env bun
// Snapshot Codex's rollout shapes into a per-version fixture corpus, the way
// scripts/harness-corpus.ts snapshots the Claude daemon's: Codex's record
// shapes are as undocumented and move as often (23 kinds across fifteen CLI
// versions on 2026-11-14), and src/codex.ts is one decoder per kind.
// test/codex-corpus.test.ts parses every fixture with every schema and holds
// the invariants the adapter leans on, so a version that moves a field fails
// a test the day it is snapshotted.
//
// Usage: bun scripts/codex-corpus.ts [--version <cli-version>]… [--max <records>]
//          → test/fixtures/codex/<cli-version>/rollout-<stamp>-<id>.jsonl
//        Per version, the SMALLEST eligible thread of each shape: a worker
//        that ran tools and reasoned, a guardian that judged, a guardian
//        that never ran, and (any version) a worker with an answered
//        question. A version dir already holding fixtures is replaced.
//
// The repo is PUBLIC and a rollout is a transcript, so a fixture is not a
// scrubbed copy — it is a PROJECTION. Each record is parsed through the
// schema src/codex.ts reads it with (zod strip mode: only declared fields
// survive, so no dynamic key — a skill name, an AGENTS.md path — can ride
// along), and then every string is replaced unless its KEY says it is an
// enum, an id or an instant:
//   - enum-like keys (type, role, model, originator, tool name, verdict
//     outcome…) keep a value that looks like one, and lose anything else;
//   - ids are remapped to counters, consistently, so every join still holds
//     (thread ↔ parent, call ↔ output, ask ↔ answer) and none is real;
//   - timestamps and numbers stay (token counts and durations are the shape);
//   - cwd, repository url, branch and commit become constants;
//   - everything else — prompts, messages, tool input and output, reasoning
//     summaries, rationales, question titles, options and answers — becomes
//     `[<length>]`.
// Threads are taken from PERSONAL trees only: a cwd, remote or branch under
// ~/code/work, or naming a work project, is never read past its session_meta,
// and a guardian is taken only when its parent qualifies too (its input IS
// its parent's transcript). The test re-checks every string of every fixture.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODEX_DIR } from '../src/config'
import { ASK_TOOL, Ask, Envelope, RECORDS, Reply, SessionMeta, Verdict, kindOf, listRollouts, readRollout, threadKind } from '../src/codex'

const HOME = homedir()
const root = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(root, 'test', 'fixtures', 'codex')

const argv = process.argv.slice(2)
const only = argv.flatMap((a, i) => (a === '--version' && argv[i + 1] ? [argv[i + 1]!] : []))
const maxAt = argv.indexOf('--max')
const MAX = maxAt >= 0 ? Number(argv[maxAt + 1]) : 400

// ---- eligibility: personal trees only ---------------------------------------
// What a work thread looks like, read off the disk rather than written
// here: the work tree's path, and the name of every project checked out
// under it. The repo is public; a list of employers' project names is not
// something it should carry either.
const WORK_TREE = join(HOME, 'code', 'work')
const WORK = new RegExp(['code/work', ...(existsSync(WORK_TREE) ? readdirSync(WORK_TREE).filter((d) => d.length > 2 && !d.startsWith('.')) : [])].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
const PERSONAL = [join(HOME, 'code', 'fun'), join(HOME, 'code', 'personal')]
function eligible(m: SessionMeta): boolean {
  const cwd = m.cwd ?? ''
  if (!cwd || [cwd, m.git?.repository_url ?? '', m.git?.branch ?? ''].some((s) => WORK.test(s))) return false
  if (PERSONAL.some((p) => cwd === p || cwd.startsWith(`${p}/`))) return true
  const wt = /\/\.codex\/worktrees\/[^/]+\/([^/]+)/.exec(cwd)
  return wt != null && PERSONAL.some((p) => existsSync(join(p, wt[1]!)))
}

// ---- the scrub --------------------------------------------------------------
export const ENUM_KEYS = new Set(['type', 'role', 'phase', 'status', 'thread_source', 'originator', 'cli_version', 'model', 'model_provider', 'history_mode', 'effort', 'reasoning_effort', 'collaboration_mode_kind', 'turn_trigger', 'reason', 'name', 'namespace', 'multi_agent_version', 'codex_error_info', 'outcome', 'risk_level', 'user_authorization', 'other', 'source', 'agent_role'])
const ENUM_VALUE = /^[A-Za-z0-9_][A-Za-z0-9_.:\- ]{0,47}$/
const KIND_VALUE = /^[a-z_]+(\.[a-z_]+)*$/
const ID_KEY = /^(id|[a-z_]*_id)$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const hole = (s: string) => `[${s.length}]`

const ids = new Map<string, string>()
function mapId(v: string): string {
  let to = ids.get(v)
  if (!to) {
    const n = ids.size + 1
    to = UUID.test(v) ? `00000000-0000-7000-8000-${String(n).padStart(12, '0')}` : `id_${n}`
    ids.set(v, to)
  }
  return to
}
const parse = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}
const REPLY = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/

function scrubString(key: string, v: string, parent: Record<string, unknown>): string {
  if (key === 'timestamp') return ISO.test(v) ? v : hole(v)
  if (ID_KEY.test(key)) return mapId(v)
  if (key === 'content_item_kinds') return KIND_VALUE.test(v) ? v : hole(v)
  if (ENUM_KEYS.has(key)) return ENUM_VALUE.test(v) && !WORK.test(v) ? v : hole(v)
  if (key === 'cwd') return v.includes('/.codex/worktrees/') ? '/Users/u/.codex/worktrees/0001/repo' : '/Users/u/code/fun/repo'
  if (key === 'repository_url') return 'https://github.com/u/repo.git'
  if (key === 'branch') return 'branch'
  if (key === 'commit_hash') return '0'.repeat(40)
  // Three strings are structure the adapter decodes. Each is projected
  // through its own schema and scrubbed the same way; a string that does not
  // parse as one is prose.
  if (key === 'arguments' && parent.name === ASK_TOOL) {
    const ask = Ask.safeParse(parse(v))
    if (ask.success) return JSON.stringify({ questions: ask.data.questions.map((q) => ({ ...(q.title != null ? { title: hole(q.title) } : {}), ...(q.question != null ? { question: hole(q.question) } : {}), ...(q.options ? { options: q.options.map(hole) } : {}) })) })
  }
  if (key === 'last_agent_message') {
    const verdict = Verdict.safeParse(parse(v))
    if (verdict.success) return JSON.stringify(scrub(verdict.data))
  }
  if (key === 'output' && /^\{"accepted":(true|false)\}$/.test(v.trim())) return v.trim()
  if (key === 'text') {
    const reply = Reply.safeParse(parse(REPLY.exec(v)?.[1] ?? ''))
    if (reply.success)
      return `<send_user_message_question_reply>\n${JSON.stringify(
        reply.data.map((r) => {
          const id = typeof r.questionItemId === 'string' ? parse(r.questionItemId) : r.questionItemId
          const triple = Array.isArray(id) && id[0] === ASK_TOOL && typeof id[1] === 'string' && typeof id[2] === 'number' ? JSON.stringify([ASK_TOOL, mapId(id[1]), id[2]]) : hole(String(r.questionItemId))
          return { questionItemId: triple, question: hole(r.question ?? ''), answer: hole(r.answer ?? '') }
        }),
      )}\n</send_user_message_question_reply>`
  }
  return hole(v)
}

function scrub(v: unknown, key = '', parent: Record<string, unknown> = {}): unknown {
  if (typeof v === 'string') return scrubString(key, v, parent)
  if (Array.isArray(v)) return v.map((x) => scrub(x, key, parent))
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    const self = Object.fromEntries(Object.entries(v))
    for (const [k, x] of Object.entries(self)) o[k] = scrub(x, k, self)
    return o
  }
  return v
}

// One rollout → its projection, or why not.
function project(text: string): { lines: string[]; unknown: Record<string, number>; refused: Record<string, number> } {
  const lines: string[] = []
  const unknown: Record<string, number> = {}
  const refused: Record<string, number> = {}
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const env = Envelope.safeParse(parse(line))
    if (!env.success) continue
    const k = kindOf(env.data.type, env.data.payload)
    if (!(k in RECORDS)) {
      unknown[k] = (unknown[k] ?? 0) + 1
      continue
    }
    const p = RECORDS[k as keyof typeof RECORDS].safeParse(env.data.payload)
    if (!p.success) {
      refused[k] = (refused[k] ?? 0) + 1
      continue
    }
    lines.push(JSON.stringify({ type: env.data.type, timestamp: env.data.timestamp, ordinal: env.data.ordinal, payload: scrub(p.data) }))
  }
  return { lines, unknown, refused }
}

// ---- the census: every eligible thread, by what it holds --------------------
type Cand = { path: string; stamp: string; version: string; kind: string; records: number; turns: number; tools: number; reasoning: number; answered: number; requests: number; parent: string | null; id: string }
const { files, imported } = listRollouts(CODEX_DIR)
const metas = new Map<string, SessionMeta>()
const cands: Cand[] = []
for (const f of files) {
  const text = await readRollout(f.path)
  const first = text.slice(0, text.indexOf('\n') >>> 0)
  const env = Envelope.safeParse(parse(first))
  const meta = env.success ? SessionMeta.safeParse(env.data.payload) : null
  if (!meta?.success) continue
  metas.set(meta.data.id, meta.data)
  if (!eligible(meta.data)) continue
  const count = (needle: string) => text.split(needle).length - 1
  cands.push({
    path: f.path,
    stamp: f.localStamp,
    id: meta.data.id,
    version: meta.data.cli_version ?? 'unknown',
    kind: threadKind(meta.data),
    parent: meta.data.parent_thread_id ?? null,
    records: count('\n'),
    turns: count('"type":"task_started"'),
    tools: count('"type":"custom_tool_call"') + count('"type":"function_call"'),
    reasoning: count('"type":"reasoning"'),
    requests: count('"type":"token_usage_record"') + count('"type":"token_count"'),
    answered: meta.data.parent_thread_id ? 0 : count('<send_user_message_question_reply>'),
  })
}
const parentOk = (c: Cand) => c.parent != null && metas.has(c.parent) && eligible(metas.get(c.parent)!)
const smallest = (xs: Cand[]) => xs.filter((c) => c.records <= MAX).sort((a, b) => a.records - b.records)[0]

const versions = [...new Set(cands.map((c) => c.version))].filter((v) => only.length === 0 || only.includes(v)).sort()
const report: string[] = []
const taken = new Set<string>()
const write = (c: Cand, why: string) => {
  if (taken.has(c.path)) return
  taken.add(c.path)
  return readRollout(c.path).then((text) => {
    const { lines, unknown, refused } = project(text)
    const dir = join(OUT, c.version)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `rollout-${c.stamp}-${mapId(c.id)}.jsonl`), `${lines.join('\n')}\n`)
    const odd = [...Object.entries(unknown).map(([k, n]) => `UNKNOWN ${k}×${n}`), ...Object.entries(refused).map(([k, n]) => `REFUSED ${k}×${n}`)]
    report.push(`  ${c.version}  ${why.padEnd(22)} ${String(lines.length).padStart(5)} records${odd.length ? `  ${odd.join(' ')}` : ''}`)
  })
}
for (const v of versions) {
  const dir = join(OUT, v)
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.startsWith('rollout-')) rmSync(join(dir, f))
  const of = cands.filter((c) => c.version === v)
  const worker = smallest(of.filter((c) => c.kind === 'worker' && c.turns > 0 && c.tools > 0 && c.reasoning > 0 && c.requests > 0)) ?? smallest(of.filter((c) => c.kind === 'worker' && c.turns > 0))
  const judge = smallest(of.filter((c) => c.kind === 'guardian' && c.turns >= 2 && parentOk(c)))
  const idle = smallest(of.filter((c) => c.kind === 'guardian' && c.turns === 0 && parentOk(c)))
  if (worker) await write(worker, 'worker')
  if (judge) await write(judge, 'guardian')
  if (idle) await write(idle, 'guardian, zero turns')
  if (!worker && !judge && !idle) report.push(`  ${v}  nothing eligible under ${MAX} records`)
}
// A question and its answer, wherever the smallest one is.
const asked = cands.filter((c) => c.kind === 'worker' && c.answered > 0 && (only.length === 0 || only.includes(c.version))).sort((a, b) => a.records - b.records)[0]
if (asked) await write(asked, 'worker, answered ask')

console.error(`codex corpus: ${files.length} rollouts (${imported} imports left out), ${cands.length} under a personal tree → ${OUT}`)
console.error(report.join('\n'))
