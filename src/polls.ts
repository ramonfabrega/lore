import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { type IdleShape, type PollShape, classify, idleShape, pollShape, taskRef } from './classes'
import { priceOf, rateFor } from './usage'

// The waiting lint over many sessions: `lore trace`'s `polls` and `idle`
// for every session in the window that waited expensively, worst first.
// The post-hoc half of the guard attrition booked as item 251(b) (log
// 09-07): the live hook refuses the third consecutive read; this makes the
// guard's ABSENCE visible in the ledger, not only in the bill — it needs
// nobody's permission and cannot refuse a legitimate call.
//
// TWO shapes, because waiting has two prices (lane-286, 09-07). `poll` is
// a per-turn read of a task file: stale information at full context price.
// `idle` is a turn that ran nothing at all — no information at the same
// price — and it is the one the first version of this lint could not see.
// lane-286 burned 9.48 USD on 107 `true` calls in four minutes and this
// verb ranked it BEST IN CLASS on the strength of a single 0.10 USD read,
// because reads were all it counted. A lint that scores its worst session
// of the day as its cleanest is worse than no lint, so eligibility and
// order now run on what waiting cost, not on whether a file was read.
//
// A session that neither read a task file nor idled is not a row: zero is
// a measurement only for a session that could have wasted something.

const Row = z.object({
  sessionId: z.string(),
  well: z.string(),
  ts: z.string().nullable(),
  tool: z.string(),
  text: z.string(),
  requestId: z.string().nullable(),
})
const Req = z.object({
  messageId: z.string(),
  ts: z.string().nullable(),
  model: z.string().nullable(),
  input: z.number(),
  cacheWrite: z.number(),
  cacheWrite1h: z.number(),
  cacheRead: z.number(),
  output: z.number(),
})

export type PollRow = PollShape &
  IdleShape & {
    well: string
    sessionId: string
    first: string | null
    last: string | null
    // Requests that made a poll-class call, and their list price — what the
    // polling cost, since every one was a full-context request.
    pollRequests: number
    pollUsd: number | null
    // The same for the idle turns. Kept apart from `pollUsd` rather than
    // folded into it: they are two behaviours with two fixes, and a row
    // that mixed them would hide which one to go and change.
    idleRequests: number
    idleUsd: number | null
    // What the waiting cost in total — the sort key, and the number to
    // quote. Null when any request in either shape was unpriced.
    wastedUsd: number | null
  }

export type PollTotals = {
  reads: number
  inRuns: number
  rereads: number
  pollRequests: number
  pollUsd: number | null
  idles: number
  idleRequests: number
  idleUsd: number | null
  wastedUsd: number | null
}

export function listPolls(
  db: Database,
  opts: { well?: string; exact?: boolean; since?: string; limit: number },
): { count: number; sessions: PollRow[]; totals: PollTotals } {
  const where = [
    "m.type = 'assistant'",
    "m.lane = 'tool'",
    // Only sessions that read a task file or ran a no-op at all — the LIKEs
    // are the cheap pre-filter, classify() is the judge. They are loose on
    // purpose: an `echo` folded into a real command matches here and is
    // thrown out below, which costs a scan; the reverse would cost a row.
    `m.session_id IN (SELECT m2.session_id FROM messages m2 JOIN messages_fts f2 ON f2.rowid = m2.id
                      WHERE m2.lane = 'tool' AND m2.type = 'assistant' AND m2.tool_name IN ('Bash', 'TaskOutput')
                        AND (f2.text LIKE '%tasks/%' OR f2.text LIKE '%"command":"true"%' OR f2.text LIKE '%"command":":"%'
                             OR f2.text LIKE '%"command":""%' OR f2.text LIKE '%"command":"echo %'))`,
  ]
  const params: (string | number)[] = []
  if (opts.well) {
    where.push(opts.exact ? '(w.dir = ? OR w.real_path = ?)' : '(w.dir LIKE ? OR w.real_path LIKE ?)')
    const v = opts.exact ? opts.well : `%${opts.well}%`
    params.push(v, v)
  }
  if (opts.since) {
    where.push('COALESCE(s.last_activity_ts, s.last_ts) >= ?')
    params.push(opts.since)
  }
  const rows = z.array(Row).parse(
    db
      .prepare(
        `SELECT m.session_id AS sessionId, w.dir AS well, m.ts, m.tool_name AS tool, f.text, m.request_id AS requestId
         FROM messages m
         JOIN messages_fts f ON f.rowid = m.id
         JOIN sessions s ON s.session_id = m.session_id
         JOIN wells w ON w.id = s.well_id
         WHERE ${where.join(' AND ')}
         ORDER BY m.session_id, m.ts, m.id`,
      )
      .all(...params),
  )
  const reqStmt = db.prepare(
    `SELECT message_id AS messageId, ts, model, input_tokens AS input, cache_write_tokens AS cacheWrite,
            cache_write_1h_tokens AS cacheWrite1h, cache_read_tokens AS cacheRead, output_tokens AS output
     FROM requests WHERE session_id = ?`,
  )

  const out: PollRow[] = []
  let i = 0
  while (i < rows.length) {
    const sid = rows[i]!.sessionId
    const seq: { ref: string | null; idle: boolean; ts: string | null }[] = []
    const pollReqs = new Set<string>()
    const idleReqs = new Set<string>()
    let first: string | null = null
    let last: string | null = null
    const well = rows[i]!.well
    for (; i < rows.length && rows[i]!.sessionId === sid; i++) {
      const r = rows[i]!
      // The tool row's text is the name then the input (indexer); trace.ts
      // takes it off the same way.
      const inputFull = r.text.startsWith(r.tool) ? r.text.slice(r.tool.length).trim() : r.text
      const cls = classify(r.tool, inputFull)
      const ref = cls === 'poll' ? taskRef(r.tool, inputFull) : null
      seq.push({ ref, idle: cls === 'idle', ts: r.ts })
      if (ref != null && r.requestId) pollReqs.add(r.requestId)
      if (cls === 'idle' && r.requestId) idleReqs.add(r.requestId)
      first ??= r.ts
      last = r.ts ?? last
    }
    const shape = pollShape(seq)
    const idle = idleShape(seq)
    if (shape.reads === 0 && idle.idles === 0) continue
    // A request that did both is charged to neither exclusively — it is
    // counted once in each shape's price, so the two never sum past the
    // session. `wastedUsd` therefore takes the union, not the sum.
    let pollUsd: number | null = 0
    let idleUsd: number | null = 0
    let wastedUsd: number | null = 0
    for (const q of z.array(Req).parse(reqStmt.all(sid))) {
      const isPoll = pollReqs.has(q.messageId)
      const isIdle = idleReqs.has(q.messageId)
      if (!isPoll && !isIdle) continue
      const rate = rateFor(q.model, q.ts?.slice(0, 10) ?? null)
      if (!rate) {
        if (isPoll) pollUsd = null
        if (isIdle) idleUsd = null
        wastedUsd = null
        continue
      }
      const usd = Object.values(priceOf(q, rate)).reduce((a, v) => a + v, 0)
      if (isPoll && pollUsd != null) pollUsd += usd
      if (isIdle && idleUsd != null) idleUsd += usd
      if (wastedUsd != null) wastedUsd += usd
    }
    out.push({
      well,
      sessionId: sid,
      first,
      last,
      ...shape,
      ...idle,
      pollRequests: pollReqs.size,
      pollUsd: round2(pollUsd),
      idleRequests: idleReqs.size,
      idleUsd: round2(idleUsd),
      wastedUsd: round2(wastedUsd),
    })
  }
  // Worst first is worst BY PRICE now. The shape counts were the proxy
  // while reads were the only shape; with two shapes they are no longer
  // comparable to each other — 107 idle turns and 107 polls cost the same
  // and only the dollars say so. An unpriced row sorts on the shapes,
  // below everything priced, rather than silently leading as a zero.
  out.sort(
    (a, b) => (b.wastedUsd ?? -1) - (a.wastedUsd ?? -1) || b.idles - a.idles || b.inRuns - a.inRuns || b.rereads - a.rereads || b.reads - a.reads,
  )
  const totals = out.reduce(
    (t, r) => ({
      reads: t.reads + r.reads,
      inRuns: t.inRuns + r.inRuns,
      rereads: t.rereads + r.rereads,
      pollRequests: t.pollRequests + r.pollRequests,
      pollUsd: t.pollUsd == null || r.pollUsd == null ? null : round2(t.pollUsd + r.pollUsd),
      idles: t.idles + r.idles,
      idleRequests: t.idleRequests + r.idleRequests,
      idleUsd: t.idleUsd == null || r.idleUsd == null ? null : round2(t.idleUsd + r.idleUsd),
      wastedUsd: t.wastedUsd == null || r.wastedUsd == null ? null : round2(t.wastedUsd + r.wastedUsd),
    }),
    {
      reads: 0,
      inRuns: 0,
      rereads: 0,
      pollRequests: 0,
      pollUsd: 0 as number | null,
      idles: 0,
      idleRequests: 0,
      idleUsd: 0 as number | null,
      wastedUsd: 0 as number | null,
    },
  )
  return { count: out.length, sessions: out.slice(0, opts.limit), totals }
}

const round2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100)
