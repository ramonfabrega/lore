import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { getThread, listThreads, resolveSide } from '../src/thread'
import { threadBody } from '../src/threadview'

// The lore↔ccc thread of 2026-09-02 in miniature, in the real record shapes.
// Two jobs, each with two sessions (a /clear between), and one respawn on
// lore's side so the root id changes while the bridge id does not. The join
// key is the harness's own: the sender's ack `msg_id` is the receiver's
// `origin.msg_id`.

type Rec = Record<string, unknown>
const line = (r: Rec) => JSON.stringify(r)
const bridge = (sessionId: string, cse: string, ts = '2026-09-02T06:00:00Z') => line({ type: 'bridge-session', timestamp: ts, sessionId, bridgeSessionId: cse })
const prompt = (s: string, ts: string, promptId: string, text: string) =>
  line({ type: 'user', timestamp: ts, promptId, sessionId: s, message: { role: 'user', content: text } })
const send = (s: string, ts: string, id: string, to: string, summary: string, message: string) =>
  line({
    type: 'assistant', timestamp: ts, sessionId: s,
    message: { id: `m_${id}`, model: 'claude-opus-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, summary, message } }], usage: { input_tokens: 1, output_tokens: 1 } },
  })
const ack = (s: string, ts: string, promptId: string, id: string, msgId: string | null, fail?: string) =>
  line({
    type: 'user', timestamp: ts, promptId, sessionId: s,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: fail ? `{"success":false,"message":"${fail}"}` : `{"success":true,"message":"→ peer","msg_id":"${msgId}"}` }],
    },
  })
// The receiver's copy, as a turn (user record)…
const relayTurn = (s: string, ts: string, promptId: string, from: string, msgId: string, body: string) =>
  line({
    type: 'user', timestamp: ts, promptId, sessionId: s, isMeta: true,
    origin: { kind: 'peer', name: from, from: 'uds:/tmp/cc-socks/1.sock', msg_id: msgId, body },
    message: { role: 'user', content: `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="${from}">\n${body}\n</cross-session-message>` },
  })
// …or read mid-turn (attachment).
const relayMid = (s: string, ts: string, from: string, msgId: string, body: string) =>
  line({
    type: 'attachment', timestamp: ts, sessionId: s, parentUuid: 'x',
    attachment: {
      type: 'queued_command', commandMode: 'prompt', isMeta: true,
      origin: { kind: 'peer', name: from, from: 'uds:/tmp/cc-socks/1.sock', msg_id: msgId, body },
      prompt: `<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="${from}">\n${body}\n</cross-session-message>`,
    },
  })

function seed(files: Record<string, Record<string, string[]>>) {
  const dir = mkdtempSync(join(tmpdir(), 'lore-thread-'))
  for (const [well, sessions] of Object.entries(files)) {
    mkdirSync(join(dir, well), { recursive: true })
    for (const [sid, lines] of Object.entries(sessions)) writeFileSync(join(dir, well, `${sid}.jsonl`), `${lines.join('\n')}\n`)
  }
  return dir
}

const LORE = 'cse_LORE'
const CCC = 'cse_CCC'
async function corpus() {
  const db = openDb(':memory:')
  const projectsDir = seed({
    '-u-code-fun-lore': {
      // Incarnation 1: sends the kickoff; the ack names the message.
      'lore-1': [
        bridge('lore-1', LORE),
        prompt('lore-1', '2026-09-02T06:54:36Z', 'L1', '@ccc is booted, brief it'),
        send('lore-1', '2026-09-02T06:55:01Z', 'tu_k', 'ccc [65f02e]', 'Kickoff brief for ccc v0', 'Kickoff brief from lore for ccc v0 — canon at 90eb9a7.'),
        ack('lore-1', '2026-09-02T06:55:03Z', 'L1', 'tu_k', 'msg-kick'),
        // ccc's confirmation lands as a turn here.
        relayTurn('lore-1', '2026-09-02T06:57:40Z', 'L2', 'ccc', 'msg-conf', 'ccc confirms canon read at 90eb9a7.'),
      ],
      // Incarnation 2 (a respawn: new root, same bridge): the thread proper.
      'lore-2': [
        bridge('lore-2', LORE, '2026-09-02T07:19:50Z'),
        line({ type: 'user', timestamp: '2026-09-02T07:20:00Z', promptId: 'L3', sessionId: 'lore-2', session_id: 'lore-2-root', message: { role: 'user', content: 'sync' } }),
        relayTurn('lore-2', '2026-09-02T07:28:08Z', 'L4', 'ccc', 'msg-m1b', 'ccc ledger: milestone 1 (resend).'),
        send('lore-2', '2026-09-02T07:32:13Z', 'tu_r', 'ccc', 'Reply to ccc: not a bug', 'Ledger banked. Three corrections back.'),
        ack('lore-2', '2026-09-02T07:32:15Z', 'L4', 'tu_r', 'msg-reply'),
      ],
    },
    '-u-code-fun-ccc': {
      'ccc-1': [
        bridge('ccc-1', CCC),
        prompt('ccc-1', '2026-09-02T06:54:19Z', 'C1', 'standby for a brief from @lore'),
        relayTurn('ccc-1', '2026-09-02T06:55:03Z', 'C2', 'lore', 'msg-kick', 'Kickoff brief from lore for ccc v0 — canon at 90eb9a7.\n\nREAD FIRST.'),
        send('ccc-1', '2026-09-02T06:57:38Z', 'tu_c', 'uds:/tmp/cc-socks/1.sock', 'Confirm canon read at 90eb9a7', 'ccc confirms canon read.'),
        ack('ccc-1', '2026-09-02T06:57:40Z', 'C2', 'tu_c', 'msg-conf'),
        prompt('ccc-1', '2026-09-02T07:02:24Z', 'C3', '1. forkpty now imo.'),
        // The socket died with lore's respawn: refused, then re-sent by name.
        send('ccc-1', '2026-09-02T07:27:37Z', 'tu_m1a', 'uds:/tmp/cc-socks/1.sock', 'ccc m1 ledger', 'ccc ledger: milestone 1.'),
        ack('ccc-1', '2026-09-02T07:27:38Z', 'C3', 'tu_m1a', null, 'Failed to send to uds:/tmp/cc-socks/1.sock: ENOENT: no such file or directory'),
        send('ccc-1', '2026-09-02T07:28:06Z', 'tu_m1b', 'lore', 'ccc m1 ledger', 'ccc ledger: milestone 1 (resend).'),
        ack('ccc-1', '2026-09-02T07:28:08Z', 'C3', 'tu_m1b', 'msg-m1b'),
        // lore's reply arrives while this 55-minute turn is still running.
        relayMid('ccc-1', '2026-09-02T07:32:15Z', 'lore', 'msg-reply', 'Ledger banked. Three corrections back.'),
        // A follow-up to ccc's own subagent: not part of the thread.
        send('ccc-1', '2026-09-02T07:40:00Z', 'tu_ag', 'af80d234d489e766f', 'Fix bold glyph drop', 'Follow-up on your renderer.'),
        ack('ccc-1', '2026-09-02T07:40:01Z', 'C3', 'tu_ag', null),
      ],
    },
  })
  await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })
  // state.json's sessionId is the FIRST root; lore's has respawned since.
  db.prepare("INSERT INTO jobs(job_id, session_id, bridge_key, name) VALUES('a18a763f', 'lore-root-of-july', 'LORE', 'lore')").run()
  db.prepare("INSERT INTO jobs(job_id, session_id, bridge_key, name) VALUES('b3919c35', 'ccc-1', 'CCC', 'ccc')").run()
  return db
}

describe('resolveSide', () => {
  test('a name is the job: every session sharing its bridge id, across the respawn', async () => {
    const db = await corpus()
    expect(resolveSide(db, 'lore')).toEqual({ query: 'lore', name: 'lore', sessions: ['lore-1', 'lore-2'] })
  })
  test('a session id expands to its job and carries the name', async () => {
    const db = await corpus()
    expect(resolveSide(db, 'lore-2')).toEqual({ query: 'lore-2', name: 'lore', sessions: ['lore-1', 'lore-2'] })
  })
})

describe('getThread', () => {
  test('both halves of every message, paired on msg_id, in order, with where each landed', async () => {
    const db = await corpus()
    const t = getThread(db, 'lore', 'ccc', { you: false })
    expect(t.rows.map((r) => [r.ts, r.from, r.to, r.landed, r.msgId])).toEqual([
      ['2026-09-02T06:55:01Z', 'lore', 'ccc', 'turn', 'msg-kick'],
      ['2026-09-02T06:57:38Z', 'ccc', 'lore', 'turn', 'msg-conf'],
      ['2026-09-02T07:27:37Z', 'ccc', 'lore', 'lost', null],
      ['2026-09-02T07:28:06Z', 'ccc', 'lore', 'turn', 'msg-m1b'],
      ['2026-09-02T07:32:13Z', 'lore', 'ccc', 'mid-turn', 'msg-reply'],
    ])
    const kick = t.rows[0]!
    // The receiver's copy is the message: whole, paragraphs kept.
    expect(kick.message).toBe('Kickoff brief from lore for ccc v0 — canon at 90eb9a7.\n\nREAD FIRST.')
    expect(kick.summary).toBe('Kickoff brief for ccc v0')
    expect(kick.sent).toEqual({ session: 'lore-1', promptId: 'L1', ts: '2026-09-02T06:55:01Z' })
    expect(kick.received).toEqual({ session: 'ccc-1', promptId: 'C2', ts: '2026-09-02T06:55:03Z' })
    // A socket send is addressed through the sender's own address book.
    expect(t.rows[1]!.received?.session).toBe('lore-1')
    // The refused send: no receiver, the ack's reason carried.
    const lost = t.rows[2]!
    expect(lost.received).toBeNull()
    expect(lost.error).toContain('ENOENT')
    expect(lost.message).toBe('ccc ledger: milestone 1.')
    // The resend crossed the respawn: it landed in the second incarnation.
    expect(t.rows[3]!.received?.session).toBe('lore-2')
    // Read inside ccc's running turn — the turn it was read in, not one it opened.
    expect(t.rows[4]!.received).toEqual({ session: 'ccc-1', promptId: 'C3', ts: '2026-09-02T07:32:15Z' })
    // The subagent follow-up is not in the thread.
    expect(t.rows.some((r) => r.summary === 'Fix bold glyph drop')).toBe(false)
    expect(t.totals).toEqual({
      'lore → ccc': { sent: 2, turn: 1, midTurn: 1, lost: 0, unseen: 0 },
      'ccc → lore': { sent: 3, turn: 2, midTurn: 0, lost: 1, unseen: 0 },
    })
  })

  test('the same thread from a session id, and from either side', async () => {
    const db = await corpus()
    const byId = getThread(db, 'ccc-1', 'lore-1', { you: false })
    expect(byId.a.name).toBe('ccc')
    expect(byId.rows.map((r) => r.msgId)).toEqual(['msg-kick', 'msg-conf', null, 'msg-m1b', 'msg-reply'])
  })

  // The user's words are in the thread by default: what each agent was
  // answering. Scoped to the sessions that took part and the thread's
  // window — "standby for a brief" at 06:54:19 precedes the first message
  // and stays out; "sync" was typed into lore-2, which took part.
  test('the user\'s words ride in their side\'s column, inside the window, turn and mid-turn alike', async () => {
    const db = await corpus()
    const t = getThread(db, 'lore', 'ccc')
    const you = t.rows.filter((r) => r.kind === 'you')
    expect(you.map((r) => [r.ts, r.to, r.landed, r.message])).toEqual([
      ['2026-09-02T07:02:24Z', 'ccc', 'turn', '1. forkpty now imo.'],
      ['2026-09-02T07:20:00Z', 'lore', 'turn', 'sync'],
    ])
    expect(you[0]!.received).toEqual({ session: 'ccc-1', promptId: 'C3', ts: '2026-09-02T07:02:24Z' })
    expect(t.totals['you → ccc']).toEqual({ sent: 1, turn: 1, midTurn: 0, lost: 0, unseen: 0 })
    // In order with the agents' messages, not appended.
    expect(t.rows.map((r) => r.kind)).toEqual(['message', 'message', 'you', 'you', 'message', 'message', 'message'])
    const page = String(await threadBody(t))
    expect(page).toContain('1. forkpty now imo.')
    expect(page).toContain('/session/ccc-1#tx-C3')
  })

  test('the index lists every pair that has talked, both directions merged', async () => {
    const db = await corpus()
    expect(listThreads(db)).toEqual([{ a: 'ccc', b: 'lore', messages: 4, first: '2026-09-02T06:55:03Z', last: '2026-09-02T07:32:15Z' }])
  })

  test('the page: a message is a row, the sender\'s column says it, the receiver\'s says where it landed', async () => {
    const db = await corpus()
    const page = String(await threadBody(getThread(db, 'lore', 'ccc', { head: 20_000 })))
    expect(page).toContain('@lore')
    expect(page).toContain('Kickoff brief for ccc v0')
    // The receiver's copy, whole, under the fold; each half links to its turn.
    expect(page).toContain('READ FIRST.')
    expect(page).toContain('/session/ccc-1#tx-C2')
    expect(page).toContain('/session/lore-1#tx-L1')
    // The refused send says so, with the ack's reason.
    expect(page).toContain('lost')
    expect(page).toContain('ENOENT')
    // The mid-turn landing links the turn that READ it.
    expect(page).toContain('/session/ccc-1#tx-C3')
  })

  test('a copy whose sender is not indexed is still a row, with sent: null', async () => {
    const db = openDb(':memory:')
    const projectsDir = seed({
      '-u-code-fun-lore': {
        'lore-x': [bridge('lore-x', LORE), relayTurn('lore-x', '2026-09-02T05:25:37Z', 'P1', 'ssh-noti', 'msg-1', 'Dotfiles session here: get your read on lore as the receiver.')],
      },
    })
    await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })
    db.prepare("INSERT INTO jobs(job_id, session_id, bridge_key, name) VALUES('a18a763f', 'lore-x', 'LORE', 'lore')").run()
    // `ssh-noti` is a name with no indexed job or session: a peer-only side.
    // The thread is lore's copies of what it said; the sender half is absent.
    const t = getThread(db, 'lore', 'ssh-noti')
    expect(t.b).toEqual({ query: 'ssh-noti', name: 'ssh-noti', sessions: [] })
    expect(t.rows).toHaveLength(1)
    expect(t.rows[0]).toMatchObject({ from: 'ssh-noti', to: 'lore', landed: 'turn', sent: null, msgId: 'msg-1' })
    expect(t.rows[0]!.received).toEqual({ session: 'lore-x', promptId: 'P1', ts: '2026-09-02T05:25:37Z' })
    expect(t.totals['ssh-noti → lore']).toEqual({ sent: 0, turn: 1, midTurn: 0, lost: 0, unseen: 0 })
    // A name nothing in the index has heard of is still an error.
    expect(() => getThread(db, 'lore', 'nobody')).toThrow(/no indexed session/)
  })
})
