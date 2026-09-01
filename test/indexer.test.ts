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
})
