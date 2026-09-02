import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { metaHead, relayHead, type Sent, sentHead } from './envelope'
import { cut } from './fmt'
import { dominantModel, tallyModels } from './model'
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
  peer: z.string().nullable(),
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
// The fan-out ledger for one session, by agent type × VERIFIED model — the
// standing fleet question (CLAUDE.md's fan-out rules) answered on the page
// that shows the session, not only by `lore spawns`.
const SpawnGroup = z.object({
  agentType: z.string().nullable(),
  model: z.string().nullable(),
  requestedModel: z.string().nullable(),
  n: z.number(),
  output: z.number(),
})
export type SpawnGroup = z.infer<typeof SpawnGroup>

export type Instruction = {
  tool: string
  input: string
  ts: string | null
  ms: number | null
  error: boolean
  result: string
  // The step that issued it — instructions of one step ran in parallel.
  requestId: string | null
}
// A note is assistant text emitted BETWEEN instructions ("Now the tests…"):
// the model's own heading for what follows. `at` is the index of the first
// instruction after it, so notes segment a transaction into phases with
// zero inference — the grind's single 298-step prompt reads as 14 phases
// this way. The text after the LAST instruction is `reply`, not a note.
export type Note = { at: number; ts: string | null; text: string }
// A thought is a thinking block, same cursor.
export type Thought = { at: number; ts: string | null; text: string }
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
// Deterministic annotations per transaction (docs/EXPLORER.md): read off the
// instructions and their logs, never inferred. files = paths touched by
// Edit/Write/Read/MultiEdit/NotebookEdit; commands = Bash calls; tests = test
// runs recognised by their command, with the verdict read from the result's
// tail (results index head+tail for exactly this); commits = shas from git's
// own "[branch sha]" line; retries = a Bash command repeated verbatim.
export type Annotations = {
  files: string[]
  commands: number
  tests: { ran: number; passed: number; failed: number }
  commits: string[]
  retries: number
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit'])
const TEST_CMD = /\b(bun test|cargo test|cargo nextest|pytest|npm test|pnpm test|yarn test|go test|vitest|jest|swift test|mix test)\b/
const TEST_FAIL = /\b(\d+) fail(?:ed|ures?)?\b|\bFAILED\b|\bfailures:|\btest result: FAILED|\bError: Exit code/i
const TEST_PASS = /\b(\d+) pass(?:ed)?\b|\btest result: ok\b|\bok\s+\d+ passed|\ball tests passed/i
const COMMIT_LINE = /\[[\w./-]+ (?:\(root-commit\) )?([0-9a-f]{7,40})\]/g

export function annotate(instructions: { tool: string; inputFull: string; resultFull: string; error: boolean }[]): Annotations {
  const files = new Set<string>()
  const commits = new Set<string>()
  const seen = new Map<string, number>()
  let commands = 0
  let ran = 0
  let passed = 0
  let failed = 0
  for (const ix of instructions) {
    if (FILE_TOOLS.has(ix.tool)) {
      const m = /"(?:file_path|notebook_path)":"((?:[^"\\]|\\.)*)"/.exec(ix.inputFull)
      if (m?.[1]) files.add(m[1])
    }
    if (ix.tool === 'Bash') {
      commands++
      const cmd = /"command":"((?:[^"\\]|\\.)*)"/.exec(ix.inputFull)?.[1] ?? ix.inputFull
      seen.set(cmd, (seen.get(cmd) ?? 0) + 1)
      if (TEST_CMD.test(cmd)) {
        ran++
        const failHit = TEST_FAIL.exec(ix.resultFull)
        const passHit = TEST_PASS.exec(ix.resultFull)
        const failN = failHit?.[1] != null ? Number(failHit[1]) : failHit ? 1 : 0
        if (failN > 0 || ix.error) failed++
        else if (passHit) passed++
      }
      for (const m of ix.resultFull.matchAll(COMMIT_LINE)) commits.add(m[1]!.slice(0, 7))
    }
  }
  let retries = 0
  for (const n of seen.values()) if (n > 1) retries += n - 1
  return { files: [...files], commands, tests: { ran, passed, failed }, commits: [...commits], retries }
}

export type Transaction = {
  promptId: string | null
  kind: 'prompt' | 'command' | 'meta' | 'relay'
  ts: string | null
  // `prompt` is the MESSAGE, with the harness's envelope taken off
  // (envelope.ts): a relay's body without the socket path that framed it, a
  // notification's summary without its ids. `tag` names the envelope that
  // was removed — the peer for a relay (rendered `@name`), the injection's
  // kind for meta (`task`, `stdout`, `image`) — and is null for a prompt the
  // user typed, which wears no envelope. The raw record stays in the index.
  tag: string | null
  prompt: string
  // The outbound half of a relay: what this session sent BACK, read off the
  // SendMessage calls in the turn. A peer's message opens a transaction and
  // the reply is the last thing in it — genuinely one turn, not two — but
  // that buries the single thing worth reading at the bottom of a fold, so
  // the recipient and the sender's own one-line summary ride up here.
  sent: Sent[]
  steps: number
  instructions: Instruction[]
  notes: Note[]
  thoughts: Thought[]
  annotations: Annotations
  errors: number
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  thinking: number
  listUsd: number | null
  // The model that served most of this transaction's steps (model.ts) —
  // present whether or not `steps` was asked for, because "which model ran
  // this prompt" is a question about the transaction, not about its detail.
  model: string | null
  reply: string
  ms: number | null
  requests?: Step[]
}
export type Trace = {
  session: z.infer<typeof Meta>
  totals: {
    // Turns — what somebody opened: a prompt, a slash command, a relay from
    // another session. Harness injections (`kind: meta`) are excluded.
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
  // What served the session, most requests first, and what its fan-out ran on.
  models: { model: string; requests: number }[]
  spawns: SpawnGroup[]
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
                m.tool_use_id AS toolUseId, m.is_error AS isError, m.request_id AS requestId, m.peer, f.text
         FROM messages m JOIN messages_fts f ON f.rowid = m.id
         WHERE m.session_id = ? AND m.lane IN ('prompt', 'meta', 'text', 'thinking', 'tool', 'relay')
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
  const spawnGroups = z.array(SpawnGroup).parse(
    db
      .prepare(
        `SELECT agent_type AS agentType, model, requested_model AS requestedModel,
                COUNT(*) AS n, COALESCE(SUM(output_tokens), 0) AS output
         FROM spawns WHERE session_id = ? GROUP BY 1, 2, 3 ORDER BY 5 DESC, 4 DESC`,
      )
      .all(sessionId),
  )
  const models = tallyModels([...reqs.values()].map((r) => r.model))

  // The address book, from the harness's own words: every inbound relay
  // states `from="uds:…" from-name="lore"`, so a later SendMessage to that
  // socket can be shown as the peer it reaches. Deterministic — a socket is
  // named only because a peer named it, in this same session.
  const peerByAddr = new Map<string, string>()
  for (const r of rows) {
    if (r.lane !== 'relay') continue
    const h = relayHead(r.text)
    const name = r.peer ?? h.from
    if (h.addr && name) peerByAddr.set(h.addr, name)
  }

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
    const opener = b.rows.find((r) => r.lane === 'prompt' || r.lane === 'meta' || r.lane === 'relay')
    // A meta opener with no command wrapper (caveats, context dumps) is
    // harness preamble, not a transaction the user started. A relay opener is
    // a transaction another SESSION started — the same shape, a different
    // author, and worth seeing as such when reading a block.
    //
    // A slash command arrives as TWO meta records — the caveat and the
    // wrapper — and the caveat sorts first, so the label comes from the first
    // meta row in the bucket that yields one, not from whichever row opened
    // it. Reading only the opener filed every `/clear` as anonymous preamble.
    const heads = opener?.lane === 'meta' ? b.rows.filter((r) => r.lane === 'meta').map((r) => metaHead(r.text)) : []
    const meta = heads.find((h) => h.tag === 'command') ?? heads.find((h) => h.tag) ?? heads[0] ?? null
    const relay = opener?.lane === 'relay' ? relayHead(opener.text) : null
    const kind: Transaction['kind'] = relay ? 'relay' : opener?.lane === 'meta' ? (meta?.tag === 'command' ? 'command' : 'meta') : 'prompt'
    // The chip: who sent a relay, what kind of injection a meta row is. A
    // command says `command` already, and a typed prompt wears nothing.
    const tag = relay ? (opener?.peer ?? relay.from) : kind === 'meta' ? (meta?.tag ?? null) : null
    const promptText = cut(relay ? relay.text : meta ? meta.text : opener?.text ?? '', head)

    // Instructions: tool_use rows (assistant, tool lane) paired to their result
    // row by tool_use_id. Latency is the timestamp pair.
    const results = new Map<string, z.infer<typeof Row>>()
    for (const r of b.rows) if (r.type === 'user' && r.lane === 'tool' && r.toolUseId) results.set(r.toolUseId, r)
    const instructions: Instruction[] = []
    const full: { tool: string; inputFull: string; resultFull: string; error: boolean }[] = []
    const texts: Note[] = []
    const thoughts: Thought[] = []
    const sent: Sent[] = []
    for (const r of b.rows) {
      if (r.type !== 'assistant') continue
      if (r.lane === 'text') {
        texts.push({ at: instructions.length, ts: r.ts, text: cut(r.text, head) })
        continue
      }
      if (r.lane === 'thinking') {
        thoughts.push({ at: instructions.length, ts: r.ts, text: cut(r.text, head) })
        continue
      }
      if (r.lane !== 'tool') continue
      const res = r.toolUseId ? results.get(r.toolUseId) : undefined
      const tool = r.toolName ?? '?'
      const inputFull = r.text.startsWith(tool) ? r.text.slice(tool.length).trim() : r.text
      if (tool === 'SendMessage') {
        const head = sentHead(inputFull)
        sent.push({ ...head, name: head.to ? peerByAddr.get(head.to) ?? null : null })
      }
      const error = res ? res.isError === 1 : false
      instructions.push({
        tool,
        input: cut(inputFull, head),
        ts: r.ts,
        ms: res?.ts && r.ts ? Date.parse(res.ts) - Date.parse(r.ts) : null,
        error,
        result: res ? cut(res.text, head) : '',
        requestId: r.requestId,
      })
      full.push({ tool, inputFull, resultFull: res?.text ?? '', error })
    }
    const annotations = annotate(full)
    // The closing text is the last text row when nothing was instructed
    // after it; a transaction cut off mid-flight has none.
    const lastText = texts[texts.length - 1]
    const reply = lastText && lastText.at === instructions.length ? lastText.text : ''
    const notes = texts.filter((n) => n !== lastText || !reply)

    const stepIds = [...new Set(b.rows.map((r) => r.requestId).filter((x): x is string => x != null))]
    const steps: Step[] = stepIds.map((id) => {
      const q = reqs.get(id)
      // Rate dates are vendor facts and stay UTC (block.ts).
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
    const first = b.rows[0]?.ts ?? null
    const last = b.rows[b.rows.length - 1]?.ts ?? null
    return {
      promptId: b.promptId,
      kind,
      ts: first,
      tag,
      prompt: promptText,
      sent,
      steps: steps.length,
      instructions,
      notes,
      thoughts,
      annotations,
      errors: instructions.filter((i) => i.error).length,
      model: dominantModel(tallyModels(steps.map((st) => st.model))),
      ...fee,
      reply,
      ms: first && last ? Math.max(0, Date.parse(last) - Date.parse(first)) : null,
      ...(opts.steps ? { requests: steps } : {}),
    }
  })

  // Totals sum the unrounded fees; rows round on the way out.
  const totals = transactions.reduce(
    (t, x) => ({
      // Turns, not buckets: a harness injection opened nothing, so it is not
      // one — the header tile and the spine's numbers count the same set.
      transactions: t.transactions + (x.kind === 'meta' ? 0 : 1),
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
    models,
    spawns: spawnGroups,
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

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
