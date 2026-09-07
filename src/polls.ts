import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { type PollShape, classify, pollShape, taskRef } from './classes'
import { priceOf, rateFor } from './usage'

// The polling lint over many sessions: `lore trace`'s `polls` for every
// session in the window that read a background task's output file at all,
// worst first. The post-hoc half of the guard attrition booked as item
// 251(b) (log 09-07): the live hook refuses the third consecutive read;
// this makes the guard's ABSENCE visible in the ledger, not only in the
// bill — it needs nobody's permission and cannot refuse a legitimate call.
// A session that never touched a task file is not a row: zero is a
// measurement only for a session that could have polled.

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

export type PollRow = PollShape & {
  well: string
  sessionId: string
  first: string | null
  last: string | null
  // Requests that made a poll-class call, and their list price — what the
  // polling cost, since every one was a full-context request.
  pollRequests: number
  pollUsd: number | null
}

export function listPolls(
  db: Database,
  opts: { well?: string; exact?: boolean; since?: string; limit: number },
): { count: number; sessions: PollRow[]; totals: { reads: number; inRuns: number; rereads: number; pollRequests: number; pollUsd: number | null } } {
  const where = [
    "m.type = 'assistant'",
    "m.lane = 'tool'",
    // Only sessions that read a task file at all — the LIKE is the cheap
    // pre-filter, classify() is the judge.
    `m.session_id IN (SELECT m2.session_id FROM messages m2 JOIN messages_fts f2 ON f2.rowid = m2.id
                      WHERE m2.lane = 'tool' AND m2.type = 'assistant' AND m2.tool_name IN ('Bash', 'TaskOutput') AND f2.text LIKE '%tasks/%')`,
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
    const seq: { ref: string | null; ts: string | null }[] = []
    const pollReqs = new Set<string>()
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
      seq.push({ ref, ts: r.ts })
      if (ref != null && r.requestId) pollReqs.add(r.requestId)
      first ??= r.ts
      last = r.ts ?? last
    }
    const shape = pollShape(seq)
    if (shape.reads === 0) continue
    let pollUsd: number | null = 0
    for (const q of z.array(Req).parse(reqStmt.all(sid))) {
      if (!pollReqs.has(q.messageId)) continue
      const rate = rateFor(q.model, q.ts?.slice(0, 10) ?? null)
      if (!rate) {
        pollUsd = null
        continue
      }
      if (pollUsd != null) pollUsd += Object.values(priceOf(q, rate)).reduce((a, v) => a + v, 0)
    }
    out.push({ well, sessionId: sid, first, last, ...shape, pollRequests: pollReqs.size, pollUsd: pollUsd == null ? null : Math.round(pollUsd * 100) / 100 })
  }
  out.sort((a, b) => b.inRuns - a.inRuns || b.rereads - a.rereads || b.reads - a.reads)
  const totals = out.reduce(
    (t, r) => ({
      reads: t.reads + r.reads,
      inRuns: t.inRuns + r.inRuns,
      rereads: t.rereads + r.rereads,
      pollRequests: t.pollRequests + r.pollRequests,
      pollUsd: t.pollUsd == null || r.pollUsd == null ? null : Math.round((t.pollUsd + r.pollUsd) * 100) / 100,
    }),
    { reads: 0, inRuns: 0, rereads: 0, pollRequests: 0, pollUsd: 0 as number | null },
  )
  return { count: out.length, sessions: out.slice(0, opts.limit), totals }
}
