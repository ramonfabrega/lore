import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { ackHead, relayHead, sentHead, sentMessage } from './envelope'
import { cutProse } from './fmt'
import { JOB_KEY_SQL } from './job'
import { resolveSessionId } from './session'

// The thread between two agents: every message either sent the other, in
// order, with both halves — the sender's SendMessage and the receiver's copy
// — and where it landed. This is the conversation view's data, and it is a
// JOIN, not a reading: the harness stamps one `msg_id` on the sender's ack
// and on the receiver's `origin`, so the two halves pair exactly (19 of 19
// on the ccc→lore leg of 2026-09-02). Two sends carried no id — one the
// socket refused, one to a subagent — and those are the two the thread
// must not pretend arrived.
//
// A side is a JOB, never one session: the conversation as the user lived it
// spans /clears and respawns (docs/EXPLORER.md, Job). A side is named by its
// agent name (`jobs.name`, the string `lore agents` prints — and what the
// harness writes as `peer` on the other side's rows) or by any session id
// of the job, which expands to the job through the bridge id.

const SessionIds = z.array(z.object({ sessionId: z.string() }))
const NAME_JOIN = `LEFT JOIN jobs j ON (s.bridge_key IS NOT NULL AND j.bridge_key = s.bridge_key)
                          OR j.session_id = s.job_session_id OR j.job_id = substr(s.job_session_id, 1, 8)`

export type Side = {
  // What was asked for.
  query: string
  // The agent's name, as the other side's rows spell it in `peer`. Null when
  // the sessions were never a named job — then only msg_id pairs them.
  name: string | null
  // The job's key (job.ts): its bridge id, else its root, else the session.
  // Null for a peer name with no indexed session at all.
  key: string | null
  sessions: string[]
}

export type Landed = 'turn' | 'mid-turn' | 'lost' | 'unseen'
export type ThreadRow = {
  ts: string
  // `message`: one agent to the other. `you`: the user, typed into one
  // side's session while the thread ran — what that agent was answering
  // when it said what it said next. `from` is then `you`, `to` the side,
  // `received` the session and turn it landed in (opened, or read mid-turn).
  kind: 'message' | 'you'
  from: string
  to: string
  msgId: string | null
  summary: string | null
  // The message: the receiver's copy when the halves paired (stored whole),
  // else the sender's (cut at index time). Cut to `head` here.
  message: string
  // The sender's half: session and the turn it was sent from. Null when only
  // the receiver's copy is indexed (the sender's session is not in the index).
  sent: { session: string; promptId: string | null; ts: string } | null
  // The receiver's half: session and the turn it landed in — the one it
  // OPENED (`turn`) or the one that read it (`mid-turn`).
  received: { session: string; promptId: string | null; ts: string } | null
  // `lost`: the ack refused it (a stale socket). `unseen`: acked, but no
  // receiver copy is indexed — the receiving session is not in the index, or
  // was not the side asked for.
  landed: Landed
  error: string | null
}
export type Thread = {
  a: Side
  b: Side
  totals: Record<string, { sent: number; turn: number; midTurn: number; lost: number; unseen: number }>
  rows: ThreadRow[]
}

const HEAD = 400

export function resolveSide(db: Database, q: string): Side {
  const byName = SessionIds.parse(
    db.prepare(`SELECT s.session_id AS sessionId FROM sessions s ${NAME_JOIN} WHERE j.name = ? ORDER BY s.first_ts, s.session_id`).all(q),
  )
  if (byName.length) return { query: q, name: q, key: keyOf(db, byName[0]!.sessionId), sessions: byName.map((r) => r.sessionId) }
  // Not a job name: a session id (or prefix), expanded to its job — or, when
  // it matches no session either, a PEER name the other side's rows carry
  // (`ssh-noti`, `site`: sessions that were never indexed jobs). Such a side
  // has no sessions of its own; the thread is then the other side's copies
  // of what it said, and the other side's sends to it, landed `unseen`.
  let sid: string
  try {
    sid = resolveSessionId(db, q, {})
  } catch (e) {
    const known = z.object({ n: z.number() }).parse(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE lane = 'relay' AND peer = ?").get(q))
    if (known.n > 0) return { query: q, name: q, key: null, sessions: [] }
    throw e
  }
  const me = z
    .object({ bridgeKey: z.string().nullable(), root: z.string().nullable(), name: z.string().nullable() })
    .parse(
      db
        .prepare(`SELECT s.bridge_key AS bridgeKey, s.job_session_id AS root, j.name AS name FROM sessions s ${NAME_JOIN} WHERE s.session_id = ?`)
        .get(sid),
    )
  const sessions = SessionIds.parse(
    db
      .prepare(
        `SELECT session_id AS sessionId FROM sessions
         WHERE session_id = ? OR (? IS NOT NULL AND bridge_key = ?) OR (? IS NOT NULL AND job_session_id = ?)
         ORDER BY first_ts, session_id`,
      )
      .all(sid, me.bridgeKey, me.bridgeKey, me.root, me.root),
  )
  return { query: q, name: me.name, key: keyOf(db, sid), sessions: sessions.map((r) => r.sessionId) }
}

function keyOf(db: Database, sessionId: string): string {
  return z.object({ key: z.string() }).parse(db.prepare(`SELECT ${JOB_KEY_SQL} AS key FROM sessions s WHERE s.session_id = ?`).get(sessionId)).key
}

const SendRow = z.object({ session: z.string(), ts: z.string().nullable(), promptId: z.string().nullable(), toolUseId: z.string().nullable(), text: z.string() })
const AckRow = z.object({ toolUseId: z.string().nullable(), msgId: z.string().nullable(), text: z.string() })
const RelayRow = z.object({ session: z.string(), ts: z.string().nullable(), type: z.string(), promptId: z.string().nullable(), peer: z.string().nullable(), msgId: z.string().nullable(), text: z.string() })

type Send = { session: string; ts: string; promptId: string | null; to: string | null; summary: string | null; message: string | null; msgId: string | null; delivered: boolean | null; error: string | null }
type Recv = z.infer<typeof RelayRow> & { ts: string }

function placeholders(n: number) {
  return Array.from({ length: n }, () => '?').join(',')
}

function sendsOf(db: Database, side: Side): Send[] {
  if (side.sessions.length === 0) return []
  const ph = placeholders(side.sessions.length)
  const sends = z.array(SendRow).parse(
    db
      .prepare(
        `SELECT m.session_id AS session, m.ts, m.prompt_id AS promptId, m.tool_use_id AS toolUseId, f.text
         FROM messages m JOIN messages_fts f ON f.rowid = m.id
         WHERE m.session_id IN (${ph}) AND m.tool_name = 'SendMessage' AND m.type = 'assistant' ORDER BY m.ts`,
      )
      .all(...side.sessions),
  )
  const acks = new Map(
    z
      .array(AckRow)
      .parse(
        db
          .prepare(
            `SELECT m.tool_use_id AS toolUseId, m.msg_id AS msgId, f.text
             FROM messages m JOIN messages_fts f ON f.rowid = m.id
             WHERE m.session_id IN (${ph}) AND m.lane = 'tool' AND m.type = 'user' AND m.tool_use_id IN (
               SELECT tool_use_id FROM messages WHERE session_id IN (${ph}) AND tool_name = 'SendMessage' AND tool_use_id IS NOT NULL)`,
          )
          .all(...side.sessions, ...side.sessions),
      )
      .map((a) => [a.toolUseId, a] as const),
  )
  return sends.flatMap((s) => {
    if (!s.ts) return []
    const input = s.text.startsWith('SendMessage') ? s.text.slice('SendMessage'.length).trim() : s.text
    const head = sentHead(input)
    const ack = s.toolUseId ? acks.get(s.toolUseId) : undefined
    const a = ack ? ackHead(ack.text) : { delivered: null, error: null }
    return [{ session: s.session, ts: s.ts, promptId: s.promptId, to: head.to, summary: head.summary, message: sentMessage(input), msgId: ack?.msgId ?? null, delivered: a.delivered, error: a.error }]
  })
}

function relaysOf(db: Database, side: Side): Recv[] {
  if (side.sessions.length === 0) return []
  return z
    .array(RelayRow)
    .parse(
      db
        .prepare(
          `SELECT m.session_id AS session, m.ts, m.type, m.prompt_id AS promptId, m.peer, m.msg_id AS msgId, f.text
           FROM messages m JOIN messages_fts f ON f.rowid = m.id
           WHERE m.session_id IN (${placeholders(side.sessions.length)}) AND m.lane = 'relay' ORDER BY m.ts`,
        )
        .all(...side.sessions),
    )
    .filter((r): r is Recv => r.ts != null)
}

// Is this send addressed to `to`? By name (`ccc`, `ccc [65f02e]`), or by a
// socket the sender's own inbound envelopes attribute to that name. A task
// id is a subagent, never a peer.
const TASK_ID = /^[0-9a-f]{17}$/
function addressed(to: string | null, side: Side, book: Map<string, string>): boolean {
  if (!to || TASK_ID.test(to) || !side.name) return false
  if (to.startsWith('uds:')) return book.get(to) === side.name
  return to.replace(/\s*\[[^\]]*\]\s*$/, '') === side.name
}

// The pairing window when no msg_id is on either half (records older than
// the field): the receiver's copy lands within seconds of the send.
const WINDOW_MS = 120_000

// The user's words in a side's sessions, inside a window: the prompt lane
// (turns) and its mid-turn rows (`type = 'attachment'`), never the harness's.
const PromptRow = z.object({ session: z.string(), ts: z.string(), type: z.string(), promptId: z.string().nullable(), text: z.string() })
function promptsOf(db: Database, sessions: string[], from: string, to: string): z.infer<typeof PromptRow>[] {
  if (sessions.length === 0) return []
  return z.array(PromptRow).parse(
    db
      .prepare(
        `SELECT m.session_id AS session, m.ts, m.type, m.prompt_id AS promptId, f.text
         FROM messages m JOIN messages_fts f ON f.rowid = m.id
         WHERE m.session_id IN (${placeholders(sessions.length)}) AND m.lane = 'prompt' AND m.ts IS NOT NULL AND m.ts >= ? AND m.ts <= ?
         ORDER BY m.ts`,
      )
      .all(...sessions, from, to),
  )
}

export function getThread(db: Database, aq: string, bq: string, opts: { head?: number; limit?: number; you?: boolean } = {}): Thread {
  const head = opts.head ?? HEAD
  const a = resolveSide(db, aq)
  const b = resolveSide(db, bq)
  const sides = { a, b }
  const sends = { a: sendsOf(db, a), b: sendsOf(db, b) }
  const relays = { a: relaysOf(db, a), b: relaysOf(db, b) }
  const book = {
    a: addressBook(relays.a),
    b: addressBook(relays.b),
  }

  const rows: ThreadRow[] = []
  const totals: Thread['totals'] = {}
  for (const [fromKey, toKey] of [
    ['a', 'b'],
    ['b', 'a'],
  ] as const) {
    const from = sides[fromKey]
    const to = sides[toKey]
    const dir = `${from.name ?? from.query} → ${to.name ?? to.query}`
    const t = { sent: 0, turn: 0, midTurn: 0, lost: 0, unseen: 0 }
    totals[dir] = t
    // The receiver's copies of what `from` sent: attributed by peer name, or
    // by the msg_id of one of `from`'s sends.
    const sentIds = new Set(sends[fromKey].map((s) => s.msgId).filter((x): x is string => x != null))
    const inbound = relays[toKey].filter((r) => (from.name != null && r.peer === from.name) || (r.msgId != null && sentIds.has(r.msgId)))
    const byMsg = new Map(inbound.filter((r) => r.msgId).map((r) => [r.msgId as string, r]))
    const used = new Set<Recv>()
    const inboundIds = new Set(inbound.map((r) => r.msgId).filter((x): x is string => x != null))
    for (const s of sends[fromKey]) {
      if (!(addressed(s.to, to, book[fromKey]) || (s.msgId != null && inboundIds.has(s.msgId)))) continue
      t.sent++
      let r = s.msgId ? byMsg.get(s.msgId) : undefined
      if (!r && !s.msgId && s.delivered !== false) {
        // No id on this half: the first unused copy from this peer inside the window.
        const t0 = Date.parse(s.ts)
        r = inbound.find((x) => !used.has(x) && x.msgId == null && Date.parse(x.ts) >= t0 && Date.parse(x.ts) - t0 <= WINDOW_MS)
      }
      if (r) used.add(r)
      const landed: Landed = r ? (r.type === 'attachment' ? 'mid-turn' : 'turn') : s.delivered === false ? 'lost' : 'unseen'
      t[landed === 'mid-turn' ? 'midTurn' : landed]++
      rows.push({
        ts: s.ts,
        kind: 'message',
        from: from.name ?? from.query,
        to: to.name ?? to.query,
        msgId: s.msgId ?? r?.msgId ?? null,
        summary: s.summary,
        message: cutProse(r ? relayHead(r.text).text : (s.message ?? ''), head),
        sent: { session: s.session, promptId: s.promptId, ts: s.ts },
        received: r ? { session: r.session, promptId: r.promptId, ts: r.ts } : null,
        landed,
        error: s.error,
      })
    }
    // Copies with no sender half in the index: the message still happened.
    for (const r of inbound) {
      if (used.has(r) || (r.msgId && sentIds.has(r.msgId))) continue
      const landed: Landed = r.type === 'attachment' ? 'mid-turn' : 'turn'
      t[landed === 'mid-turn' ? 'midTurn' : landed]++
      const h = relayHead(r.text)
      rows.push({
        ts: r.ts,
        kind: 'message',
        from: r.peer ?? h.from ?? from.name ?? from.query,
        to: to.name ?? to.query,
        msgId: r.msgId,
        summary: null,
        message: cutProse(h.text, head),
        sent: null,
        received: { session: r.session, promptId: r.promptId, ts: r.ts },
        landed,
        error: null,
      })
    }
  }
  // The user's words, between the agents': what each side was answering.
  // Scoped to the thread — only the sessions that took part, only inside
  // its window — because a side is a job and lore's job alone is sixty
  // sessions back to July.
  if (opts.you !== false && rows.length) {
    const last = rows.reduce((m, r) => (r.ts > m ? r.ts : m), rows[0]!.ts)
    const took = new Set(rows.flatMap((r) => [r.sent?.session, r.received?.session]).filter((x): x is string => x != null))
    for (const side of [a, b]) {
      const t = { sent: 0, turn: 0, midTurn: 0, lost: 0, unseen: 0 }
      const name = side.name ?? side.query
      const mine = side.sessions.filter((s) => took.has(s))
      // The window opens, per side, at the prompt the agent was ON when its
      // first message came or went — "standby for a brief from @lore" is the
      // turn ccc stood in when the kickoff landed, and the thread is not
      // legible without it. That is the last turn-opening prompt before the
      // side's first message; anything earlier is another conversation.
      const firstMine = rows
        .filter((r) => (r.sent && mine.includes(r.sent.session)) || (r.received && mine.includes(r.received.session)))
        .reduce((m, r) => (r.ts < m ? r.ts : m), last)
      const opener = mine.length
        ? z
            .object({ ts: z.string() })
            .nullish()
            .parse(
              db
                .prepare(
                  `SELECT ts FROM messages WHERE session_id IN (${placeholders(mine.length)}) AND lane = 'prompt' AND type = 'user' AND ts < ?
                   ORDER BY ts DESC LIMIT 1`,
                )
                .get(...mine, firstMine),
            )
        : null
      for (const p of promptsOf(db, mine, opener?.ts ?? firstMine, last)) {
        const landed: Landed = p.type === 'attachment' ? 'mid-turn' : 'turn'
        t.sent++
        t[landed === 'mid-turn' ? 'midTurn' : 'turn']++
        rows.push({
          ts: p.ts,
          kind: 'you',
          from: 'you',
          to: name,
          msgId: null,
          summary: null,
          message: cutProse(p.text, head),
          sent: null,
          received: { session: p.session, promptId: p.promptId, ts: p.ts },
          landed,
          error: null,
        })
      }
      if (t.sent) totals[`you → ${name}`] = t
    }
  }
  rows.sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0))
  return { a, b, totals, rows: opts.limit ? rows.slice(0, opts.limit) : rows }
}

// Every pair of agents that has exchanged messages, from the receiving side
// of the relay lane: who received, from whom, how many, over what span. A
// receiver without a job name is its session id — `getThread` accepts either.
// Both directions merge into one unordered pair.
export type ThreadPair = { a: string; b: string; messages: number; first: string | null; last: string | null }
const PairRow = z.object({ me: z.string(), peer: z.string(), n: z.number(), first: z.string().nullable(), last: z.string().nullable() })
export function listThreads(db: Database): ThreadPair[] {
  const rows = z.array(PairRow).parse(
    db
      .prepare(
        `SELECT COALESCE((SELECT j.name FROM jobs j
                          WHERE (s.bridge_key IS NOT NULL AND j.bridge_key = s.bridge_key)
                             OR j.session_id = s.job_session_id OR j.job_id = substr(s.job_session_id, 1, 8)
                          LIMIT 1), s.session_id) AS me,
                m.peer, COUNT(*) AS n, MIN(m.ts) AS first, MAX(m.ts) AS last
         FROM messages m JOIN sessions s ON s.session_id = m.session_id
         WHERE m.lane = 'relay' AND m.peer IS NOT NULL
         GROUP BY 1, 2`,
      )
      .all(),
  )
  const pairs = new Map<string, ThreadPair>()
  for (const r of rows) {
    const [a, b] = [r.me, r.peer].sort()
    const key = `${a} ${b}`
    const p = pairs.get(key) ?? { a: a!, b: b!, messages: 0, first: null, last: null }
    p.messages += r.n
    if (r.first && (!p.first || r.first < p.first)) p.first = r.first
    if (r.last && (!p.last || r.last > p.last)) p.last = r.last
    pairs.set(key, p)
  }
  return [...pairs.values()].sort((x, y) => ((y.last ?? '') < (x.last ?? '') ? -1 : (y.last ?? '') > (x.last ?? '') ? 1 : 0))
}

function addressBook(relays: Recv[]): Map<string, string> {
  const book = new Map<string, string>()
  for (const r of relays) {
    const h = relayHead(r.text)
    const name = r.peer ?? h.from
    if (h.addr && name) book.set(h.addr, name)
  }
  return book
}
