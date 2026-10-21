import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { sentMessage } from './envelope'
import { JOB_KEY_SQL, resolveJob } from './job'
import { resolveSessionId } from './session'
import { getTrace, type Trace, type Transaction } from './trace'

// The conversation: one session (or a job across its /clears) read as a
// dialogue — what was said, by whom, in order — with the tool work between
// a message and its answer folded to one line. A PROJECTION of the trace
// (docs/EXPLORER.md): every beat here is a trace field at a cursor, and the
// block view is the same data with the work unfolded.
//
// What counts as speech: the message that opened the turn (the user's, a
// slash command, a peer's relay, a harness notification — chipped, muted),
// every text the assistant emitted — its notes between runs of work ("The
// gates table is in. Next, in parallel…" is the assistant talking, and the
// terminal showed it as such) and its closing reply — a message read
// mid-turn from the user or a peer, and a SendMessage out. The block view
// treats a note as the heading of the phase under it; here it is a line of
// dialogue and the phase is the fold after it. A harness notification read
// mid-turn is counted on the work beat it was read inside and is not a
// beat: fourteen of them in one turn would be fourteen bubbles saying
// "background command finished".

export type Work = {
  kind: 'work'
  // Instruction cursor range [from, to) in the transaction — the block
  // view's tables for exactly these rows are the fold.
  from: number
  to: number
  instructions: number
  steps: number
  errors: number
  ms: number | null
  listUsd: number | null
  tools: { tool: string; n: number }[]
  // Harness notifications read inside the run.
  notifications: number
}
export type Said = { kind: 'said'; at: number; ts: string | null; text: string }
export type Heard = { kind: 'you' | 'peer'; at: number; ts: string | null; tag: string | null; text: string }
export type SentOut = {
  kind: 'sent'
  at: number
  ts: string | null
  to: string | null
  name: string | null
  agent: string | null
  summary: string | null
  message: string | null
  delivered: boolean | null
}
export type Beat = Work | Said | Heard | SentOut

export type Turn = {
  sessionId: string
  // The spine's number: harness injections are unnumbered there and here.
  n: number | null
  kind: Transaction['kind']
  tag: string | null
  promptId: string | null
  ts: string | null
  // The whole message, envelope off (trace.ts): at `proseHead`, never `head`.
  message: string
  beats: Beat[]
  reply: string
  // When the reply landed: the turn's start plus its wall time.
  replyTs: string | null
  model: string | null
  steps: number
  instructions: number
  errors: number
  listUsd: number | null
  ms: number | null
}

export type Conversation = {
  // The sessions read, in order — one for a session, every one of a job's.
  sessions: Trace['session'][]
  job: { key: string; name: string | null } | null
  models: { model: string; requests: number }[]
  totals: {
    sessions: number
    turns: Trace['totals']['turns']
    beats: { work: number; said: number; you: number; peer: number; sent: number }
    steps: number
    instructions: number
    listUsd: number | null
    ms: number | null
  }
  turns: Turn[]
}

// The projection over one trace. Pure: the page and the CLI call this on
// the same `getTrace` and cannot disagree.
export function conversationOf(trace: Trace): Turn[] {
  let n = 0
  return trace.transactions.map((x) => {
    const numbered = x.kind !== 'meta'
    if (numbered) n++
    return {
      sessionId: trace.session.sessionId,
      n: numbered ? n : null,
      kind: x.kind,
      tag: x.tag,
      promptId: x.promptId,
      ts: x.ts,
      message: x.message ?? x.prompt,
      beats: beatsOf(x),
      reply: x.reply,
      replyTs: x.ts && x.ms != null ? new Date(Date.parse(x.ts) + x.ms).toISOString() : null,
      model: x.model,
      steps: x.steps,
      instructions: x.instructions.length,
      errors: x.errors,
      listUsd: x.listUsd,
      ms: x.ms,
    }
  })
}

// The beats of one turn, in reading order. Events sit at an instruction
// cursor: a note at `at` precedes instruction `at`; a message read at `at`
// was delivered with the result of `at - 1`, so it too precedes `at`; a
// SendMessage IS instruction `at`. Ties resolve in that order. The runs of
// instructions between events are the work beats.
export function beatsOf(x: Transaction): Beat[] {
  type Ev = { at: number; rank: number; beat: Said | Heard | SentOut }
  const events: Ev[] = []
  for (const r of x.received) {
    if (r.kind === 'meta') continue
    events.push({ at: r.at, rank: 0, beat: { kind: r.kind === 'prompt' ? 'you' : 'peer', at: r.at, ts: r.ts, tag: r.tag, text: r.text } })
  }
  for (const note of x.notes) events.push({ at: note.at, rank: 1, beat: { kind: 'said', at: note.at, ts: note.ts, text: note.body ?? note.text } })
  x.instructions.forEach((ix, i) => {
    if (ix.tool !== 'SendMessage') return
    events.push({
      at: i,
      rank: 2,
      beat: {
        kind: 'sent',
        at: i,
        ts: ix.ts,
        to: ix.to ?? null,
        name: ix.toName ?? null,
        agent: ix.toAgent ?? null,
        summary: summaryOf(ix.input),
        message: sentMessage(ix.input),
        delivered: ix.delivered ?? null,
      },
    })
  })
  events.sort((a, b) => a.at - b.at || a.rank - b.rank)

  const beats: Beat[] = []
  let cursor = 0
  const work = (from: number, to: number) => {
    if (to > from) beats.push(workOf(x, from, to))
  }
  for (const e of events) {
    work(cursor, e.at)
    beats.push(e.beat)
    // A send is an instruction and is consumed; the others sit before one.
    cursor = e.beat.kind === 'sent' ? e.at + 1 : Math.max(cursor, e.at)
  }
  work(cursor, x.instructions.length)
  return beats
}

function workOf(x: Transaction, from: number, to: number): Work {
  const ix = x.instructions.slice(from, to)
  const reqs = new Set<string>()
  const tools = new Map<string, number>()
  let errors = 0
  for (const i of ix) {
    if (i.requestId) reqs.add(i.requestId)
    tools.set(i.tool, (tools.get(i.tool) ?? 0) + 1)
    if (i.error) errors++
  }
  const fees = x.requests ? x.requests.filter((r) => reqs.has(r.requestId)) : []
  const priced = x.requests != null && fees.every((r) => r.listUsd != null)
  const listUsd = priced ? round2(fees.reduce((s, r) => s + (r.listUsd ?? 0), 0)) : null
  const t0 = ix[0]?.ts
  const tail = ix[ix.length - 1]
  const ms = t0 && tail?.ts ? Date.parse(tail.ts) + (tail.ms ?? 0) - Date.parse(t0) : null
  const last = to === x.instructions.length
  return {
    kind: 'work',
    from,
    to,
    instructions: ix.length,
    steps: reqs.size,
    errors,
    ms,
    listUsd,
    tools: [...tools].map(([tool, n]) => ({ tool, n })),
    notifications: x.received.filter((r) => r.kind === 'meta' && r.at >= from && (r.at < to || (last && r.at === to))).length,
  }
}

function summaryOf(input: string): string | null {
  try {
    const o = JSON.parse(input) as Record<string, unknown>
    return typeof o.summary === 'string' ? o.summary : null
  } catch {
    return /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input)?.[1]?.replace(/\\(.)/g, '$1') ?? null
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

const PROSE = 20_000

// One session, or every session of a job in order (across /clears — each
// session opens with its `/clear`, which reads as the row it is). A session
// id or unique prefix is tried first; then a job by name, bridge id, daemon
// id or root. `tail` keeps the newest n rows: the "orient me after an hour
// away" read.
export function getConversation(
  db: Database,
  q: string,
  opts: { tail?: number; head?: number; proseHead?: number; well?: string; exact?: boolean } = {},
): Conversation {
  let traces: Trace[]
  let job: Conversation['job'] = null
  try {
    traces = [getTrace(db, resolveSessionId(db, q, { well: opts.well, exact: opts.exact }), traceOpts(opts))]
  } catch (e) {
    const ref = resolveJob(db, q)
    if (!ref) throw e
    const read = jobTraces(db, ref.key, opts)
    if (!read) throw e
    job = read.job
    traces = read.traces
  }
  return conversationFrom(traces, job, opts.tail)
}

function traceOpts(opts: { head?: number; proseHead?: number }) {
  return { limit: 10_000, exact: true, steps: true, head: opts.head ?? 160, proseHead: opts.proseHead ?? PROSE } as const
}

// Every session of a job, traced, in order — the job's conversation page
// and the verb's job form read the same list. Null when the key has no
// sessions in the index.
export function jobTraces(db: Database, key: string, opts: { head?: number; proseHead?: number } = {}): { traces: Trace[]; job: NonNullable<Conversation['job']> } | null {
  const members = z
    .array(z.object({ sessionId: z.string(), name: z.string().nullable() }))
    .parse(
      db
        .prepare(
          `SELECT s.session_id AS sessionId, j.name AS name FROM sessions s
           LEFT JOIN jobs j ON (s.bridge_key IS NOT NULL AND j.bridge_key = s.bridge_key) OR j.session_id = s.job_session_id
           WHERE ${JOB_KEY_SQL} = ? ORDER BY s.first_ts, s.session_id`,
        )
        .all(key),
    )
  if (members.length === 0) return null
  // No lane ledger per session: the job's head has its own, and the ledger
  // is the one fleet-wide fold in a trace (trace.ts) — 47 sessions paid it
  // 47 times, 17 of the page's 21 cold seconds.
  const o = { ...traceOpts(opts), lanes: false }
  return { job: { key, name: members.find((m) => m.name)?.name ?? null }, traces: members.map((m) => getTrace(db, m.sessionId, o)) }
}

export function conversationFrom(traces: Trace[], job: Conversation['job'], tail?: number): Conversation {
  const all = traces.flatMap(conversationOf)
  const opts = { tail }
  const turns = opts.tail != null && opts.tail > 0 ? all.slice(-opts.tail) : all
  const models = new Map<string, number>()
  for (const t of traces) for (const m of t.models) models.set(m.model, (models.get(m.model) ?? 0) + m.requests)
  const beats = { work: 0, said: 0, you: 0, peer: 0, sent: 0 }
  for (const t of all) for (const b of t.beats) beats[b.kind]++
  const sum = (f: (t: Trace) => number | null) => traces.reduce<number | null>((s, t) => (s == null || f(t) == null ? null : s + (f(t) ?? 0)), 0)
  return {
    sessions: traces.map((t) => t.session),
    job,
    models: [...models].map(([model, requests]) => ({ model, requests })).sort((a, b) => b.requests - a.requests),
    totals: {
      sessions: traces.length,
      turns: traces.reduce(
        (a, t) => ({ prompt: a.prompt + t.totals.turns.prompt, command: a.command + t.totals.turns.command, relay: a.relay + t.totals.turns.relay, meta: a.meta + t.totals.turns.meta }),
        { prompt: 0, command: 0, relay: 0, meta: 0 },
      ),
      beats,
      steps: traces.reduce((s, t) => s + t.totals.steps, 0),
      instructions: traces.reduce((s, t) => s + t.totals.instructions, 0),
      listUsd: sum((t) => t.totals.listUsd),
      ms: sum((t) => t.totals.ms),
    },
    turns,
  }
}
