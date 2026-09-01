import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { resolveSessionId } from './session'
import { rateFor } from './usage'

// The explorer's block view (docs/EXPLORER.md): one session decomposed into
// transactions (one user prompt and everything until the next), each with
// its steps (API requests, the fee), its instructions (tool calls, with the
// paired result's latency and error flag), and the assistant's closing
// text. Zero inference — every field is a transcript field or a join.

const Row = z.object({
  id: z.number(),
  ts: z.string().nullable(),
  lane: z.string(),
  type: z.string(),
  promptId: z.string().nullable(),
  toolName: z.string().nullable(),
  toolUseId: z.string().nullable(),
  isError: z.number(),
  requestId: z.string().nullable(),
  text: z.string(),
})
const Req = z.object({
  messageId: z.string(),
  ts: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  input: z.number(),
  cacheWrite: z.number(),
  cacheRead: z.number(),
  output: z.number(),
  thinking: z.number(),
  stopReason: z.string().nullable(),
})
const Meta = z.object({
  well: z.string(),
  sessionId: z.string(),
  jobSessionId: z.string().nullable(),
  first: z.string().nullable(),
  last: z.string().nullable(),
  lines: z.number(),
})
const SpawnRow = z.object({ n: z.number(), output: z.number() })

export type Instruction = {
  tool: string
  input: string
  ts: string | null
  ms: number | null
  error: boolean
  result: string
}
export type Step = {
  requestId: string
  ts: string | null
  model: string | null
  stopReason: string | null
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  thinking: number
  listUsd: number | null
}
export type Transaction = {
  promptId: string | null
  kind: 'prompt' | 'command' | 'meta'
  ts: string | null
  prompt: string
  steps: number
  instructions: Instruction[]
  errors: number
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  thinking: number
  listUsd: number | null
  reply: string
  ms: number | null
  requests?: Step[]
}
export type Trace = {
  session: z.infer<typeof Meta>
  totals: {
    transactions: number
    steps: number
    instructions: number
    errors: number
    input: number
    cacheWrite: number
    cacheRead: number
    output: number
    thinking: number
    listUsd: number | null
    spawns: number
    spawnOutput: number
    ms: number | null
  }
  transactions: Transaction[]
}

const HEAD = 160

export function getTrace(
  db: Database,
  idPrefix: string,
  opts: { well?: string; exact?: boolean; limit: number; steps?: boolean; head?: number },
): Trace {
  const head = opts.head ?? HEAD
  const sessionId = resolveSessionId(db, idPrefix, opts)
  const session = Meta.parse(
    db
      .prepare(
        `SELECT w.dir AS well, s.session_id AS sessionId, s.job_session_id AS jobSessionId, s.first_ts AS first,
                COALESCE(s.last_activity_ts, s.last_ts) AS last, s.lines
         FROM sessions s JOIN wells w ON w.id = s.well_id WHERE s.session_id = ?`,
      )
      .get(sessionId),
  )
  const rows = z.array(Row).parse(
    db
      .prepare(
        `SELECT m.id, m.ts, m.lane, m.type, m.prompt_id AS promptId, m.tool_name AS toolName,
                m.tool_use_id AS toolUseId, m.is_error AS isError, m.request_id AS requestId, f.text
         FROM messages m JOIN messages_fts f ON f.rowid = m.id
         WHERE m.session_id = ? AND m.lane IN ('prompt', 'meta', 'text', 'tool')
         ORDER BY m.id`,
      )
      .all(sessionId),
  )
  const reqs = new Map(
    z
      .array(Req)
      .parse(
        db
          .prepare(
            `SELECT message_id AS messageId, ts, model, effort, input_tokens AS input, cache_write_tokens AS cacheWrite,
                    cache_read_tokens AS cacheRead, output_tokens AS output, thinking_tokens AS thinking, stop_reason AS stopReason
             FROM requests WHERE session_id = ?`,
          )
          .all(sessionId),
      )
      .map((r) => [r.messageId, r] as const),
  )
  const spawns = SpawnRow.parse(
    db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(output_tokens), 0) AS output FROM spawns WHERE session_id = ?').get(sessionId),
  )

  // Group by prompt id in order of first appearance. Rows before any prompt
  // id (pre-2026-06 transcripts, or a harness preamble) fall into one
  // leading transaction keyed null.
  type Bucket = { promptId: string | null; rows: z.infer<typeof Row>[] }
  const buckets: Bucket[] = []
  let cur: Bucket | null = null
  for (const r of rows) {
    if (!cur || cur.promptId !== r.promptId) {
      cur = { promptId: r.promptId, rows: [] }
      buckets.push(cur)
    }
    cur.rows.push(r)
  }

  const transactions: Transaction[] = buckets.map((b) => {
    const opener = b.rows.find((r) => r.lane === 'prompt' || r.lane === 'meta')
    const command = opener?.lane === 'meta' ? commandName(opener.text) : null
    // A meta opener with no command wrapper (caveats, context dumps) is
    // harness preamble, not a transaction the user started.
    const kind: Transaction['kind'] = opener?.lane === 'meta' ? (command ? 'command' : 'meta') : 'prompt'
    const promptText = opener ? cut(command ?? opener.text, head) : ''

    // Instructions: tool_use rows (assistant, tool lane) paired to their result
    // row by tool_use_id. Latency is the timestamp pair.
    const results = new Map<string, z.infer<typeof Row>>()
    for (const r of b.rows) if (r.type === 'user' && r.lane === 'tool' && r.toolUseId) results.set(r.toolUseId, r)
    const instructions: Instruction[] = []
    for (const r of b.rows) {
      if (r.type !== 'assistant' || r.lane !== 'tool') continue
      const res = r.toolUseId ? results.get(r.toolUseId) : undefined
      const tool = r.toolName ?? '?'
      instructions.push({
        tool,
        input: cut(r.text.startsWith(tool) ? r.text.slice(tool.length).trim() : r.text, head),
        ts: r.ts,
        ms: res?.ts && r.ts ? Date.parse(res.ts) - Date.parse(r.ts) : null,
        error: res ? res.isError === 1 : false,
        result: res ? cut(res.text, head) : '',
      })
    }

    const stepIds = [...new Set(b.rows.map((r) => r.requestId).filter((x): x is string => x != null))]
    const steps: Step[] = stepIds.map((id) => {
      const q = reqs.get(id)
      const rate = rateFor(q?.model ?? null, q?.ts?.slice(0, 10) ?? null)
      const listUsd =
        q && rate ? (q.input * rate.input + q.cacheWrite * rate.cacheWrite + q.cacheRead * rate.cacheRead + q.output * rate.output) / 1e6 : null
      return {
        requestId: id,
        ts: q?.ts ?? null,
        model: q?.model ?? null,
        stopReason: q?.stopReason ?? null,
        input: q?.input ?? 0,
        cacheWrite: q?.cacheWrite ?? 0,
        cacheRead: q?.cacheRead ?? 0,
        output: q?.output ?? 0,
        thinking: q?.thinking ?? 0,
        listUsd,
      }
    })
    const fee = sumFee(steps)
    const texts = b.rows.filter((r) => r.type === 'assistant' && r.lane === 'text')
    const first = b.rows[0]?.ts ?? null
    const last = b.rows[b.rows.length - 1]?.ts ?? null
    return {
      promptId: b.promptId,
      kind,
      ts: first,
      prompt: promptText,
      steps: steps.length,
      instructions,
      errors: instructions.filter((i) => i.error).length,
      ...fee,
      reply: cut(texts[texts.length - 1]?.text ?? '', head),
      ms: first && last ? Math.max(0, Date.parse(last) - Date.parse(first)) : null,
      ...(opts.steps ? { requests: steps } : {}),
    }
  })

  // Totals sum the unrounded fees; rows round on the way out.
  const totals = transactions.reduce(
    (t, x) => ({
      transactions: t.transactions + 1,
      steps: t.steps + x.steps,
      instructions: t.instructions + x.instructions.length,
      errors: t.errors + x.errors,
      input: t.input + x.input,
      cacheWrite: t.cacheWrite + x.cacheWrite,
      cacheRead: t.cacheRead + x.cacheRead,
      output: t.output + x.output,
      thinking: t.thinking + x.thinking,
      listUsd: t.listUsd == null || x.listUsd == null ? null : t.listUsd + x.listUsd,
      spawns: spawns.n,
      spawnOutput: spawns.output,
      ms: t.ms,
    }),
    {
      transactions: 0,
      steps: 0,
      instructions: 0,
      errors: 0,
      input: 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
      thinking: 0,
      listUsd: 0 as number | null,
      spawns: spawns.n,
      spawnOutput: spawns.output,
      ms: session.first && session.last ? Date.parse(session.last) - Date.parse(session.first) : null,
    },
  )

  return {
    session,
    totals: { ...totals, listUsd: totals.listUsd == null ? null : round2(totals.listUsd) },
    transactions: transactions.slice(0, opts.limit).map((x) => ({ ...x, listUsd: x.listUsd == null ? null : round2(x.listUsd) })),
  }
}

function sumFee(steps: Step[]) {
  let listUsd: number | null = 0
  const t = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 }
  for (const s of steps) {
    t.input += s.input
    t.cacheWrite += s.cacheWrite
    t.cacheRead += s.cacheRead
    t.output += s.output
    t.thinking += s.thinking
    listUsd = listUsd == null || s.listUsd == null ? null : listUsd + s.listUsd
  }
  return { ...t, listUsd }
}

function commandName(text: string): string | null {
  return /<command-name>\/?([\w:-]+)<\/command-name>/.exec(text)?.[1] ?? null
}

function cut(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
