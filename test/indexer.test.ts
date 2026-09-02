import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'

function promptLine(ts: string, text: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
}

// The real shape, taken verbatim from a dormant session's transcript tail: a
// `system` record with subtype bridge_status. This DOES produce an indexed
// entry (the event lane), which is why "produced an entry" was too weak a test
// for activity — the first cut of v11 shipped that rule and did not move the
// misdated session at all.
function heartbeatLine(ts: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'bridge_status',
    timestamp: ts,
    content: '/remote-control is active · Continue here, on your phone',
  })
}

// A cross-session message as the harness records it: a user record whose
// `origin` names the sending session. Verbatim shape from the lore↔site route
// of 2026-09-02.
function relayLine(ts: string, peer: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    isMeta: true,
    promptSource: 'system',
    origin: { kind: 'peer', name: peer, from: `uds:/tmp/cc-socks/40460.sock`, fromMode: 'prompting' },
    message: { role: 'user', content: `Another Claude session sent a message: <cross-session-message from-name="${peer}">${text}` },
  })
}

// An entry-less record (parse.ts `default: break`) — timestamped, indexes
// nothing at all. Must also not count as activity.
function structureOnlyLine(ts: string): string {
  return JSON.stringify({ type: 'last-prompt', timestamp: ts })
}

function seedWell(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-indexer-'))
  const well = join(dir, '-u-code-fun-app')
  mkdirSync(well, { recursive: true })
  writeFileSync(join(well, 'sess-1.jsonl'), `${lines.join('\n')}\n`)
  return dir
}

const TsRow = z.object({ last_ts: z.string().nullable(), last_activity_ts: z.string().nullable() })

async function indexAnd(lines: string[]) {
  const db = openDb(':memory:')
  const projectsDir = seedWell(lines)
  await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })
  return TsRow.parse(db.prepare('SELECT last_ts, last_activity_ts FROM sessions WHERE session_id = ?').get('sess-1'))
}

describe('buildIndex: last_ts vs last_activity_ts', () => {
  test('heartbeats advance last_ts but never last_activity_ts', async () => {
    // The dormant-session shape: real work, then weeks of entry-less pings.
    const row = await indexAnd([
      promptLine('2026-07-23T02:39:00Z', 'gm gm, another day another project'),
      promptLine('2026-07-25T00:20:00Z', 'i think we are settled for now'),
      heartbeatLine('2026-08-17T16:04:00Z'),
      structureOnlyLine('2026-08-17T20:37:10Z'),
      heartbeatLine('2026-08-17T20:37:48Z'),
    ])
    expect(row.last_ts).toBe('2026-08-17T20:37:48Z')
    expect(row.last_activity_ts).toBe('2026-07-25T00:20:00Z')
  })

  test('a session with no heartbeat tail reports the two identically', async () => {
    const row = await indexAnd([
      promptLine('2026-07-23T02:39:00Z', 'start'),
      promptLine('2026-07-23T04:00:00Z', 'done'),
    ])
    expect(row.last_ts).toBe('2026-07-23T04:00:00Z')
    expect(row.last_activity_ts).toBe('2026-07-23T04:00:00Z')
  })

  test('a heartbeat-only transcript has no activity timestamp at all', async () => {
    const row = await indexAnd([heartbeatLine('2026-08-17T16:04:00Z')])
    expect(row.last_ts).toBe('2026-08-17T16:04:00Z')
    expect(row.last_activity_ts).toBeNull()
  })

  test('a peer relay is activity — answering another session is work', async () => {
    const row = await indexAnd([
      promptLine('2026-09-02T04:00:00Z', 'kick it off'),
      relayLine('2026-09-02T06:30:00Z', 'site', 'Site read: one flat project row, ~30-word blurb.'),
    ])
    expect(row.last_activity_ts).toBe('2026-09-02T06:30:00Z')
  })
})

describe('buildIndex: the relay lane', () => {
  test('a peer message lands in relay with its sender, out of the prompt lane', async () => {
    const db = openDb(':memory:')
    const projectsDir = seedWell([
      promptLine('2026-09-02T04:00:00Z', 'what should the blurb say?'),
      relayLine('2026-09-02T04:03:51Z', 'site', 'Copy spec: one paragraph, 25-35 words, flat declarative.'),
      relayLine('2026-09-02T04:19:32Z', 'site', 'All four user calls are in, and phase 2 is built.'),
      // Injected by the harness in the same session — meta, not the user.
      JSON.stringify({
        type: 'user',
        timestamp: '2026-09-02T04:25:00Z',
        isMeta: true,
        turnCompanion: true,
        message: { role: 'user', content: 'Approach this as the design lead at a small studio…' },
      }),
    ])
    await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })

    const lanes = z
      .array(z.object({ lane: z.string(), n: z.number() }))
      .parse(db.prepare('SELECT lane, COUNT(*) AS n FROM messages GROUP BY lane ORDER BY lane').all())
    // One typed prompt — not three, and not four.
    expect(lanes).toEqual([
      { lane: 'meta', n: 1 },
      { lane: 'prompt', n: 1 },
      { lane: 'relay', n: 2 },
    ])
    const peers = z
      .array(z.object({ peer: z.string().nullable(), n: z.number() }))
      .parse(db.prepare("SELECT peer, COUNT(*) AS n FROM messages WHERE lane = 'relay' GROUP BY peer").all())
    expect(peers).toEqual([{ peer: 'site', n: 2 }])
    // The rows a non-relay lane holds carry no sender.
    const stray = z
      .object({ n: z.number() })
      .parse(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE lane != 'relay' AND peer IS NOT NULL").get())
    expect(stray.n).toBe(0)
  })
})
