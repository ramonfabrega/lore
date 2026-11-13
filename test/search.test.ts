import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { dayStart } from '../src/fmt'
import { buildIndex } from '../src/indexer'
import { searchHistory, searchMessages } from '../src/search'

// A mining bucket is "these sessions, these days". `lore search` had a well
// filter and nothing else, so a miner asking what a session said about X
// searched the whole index: nine of them across ingests #32 and #33 typed
// `--since` and got "Unknown flag".
function promptLine(ts: string, text: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
}

async function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'lore-search-'))
  const well = join(dir, 'projects', '-u-code-fun-app')
  mkdirSync(well, { recursive: true })
  writeFileSync(
    join(well, 'aaaa1111-0000-4000-8000-000000000001.jsonl'),
    [promptLine('2026-11-04T15:00:00.000Z', 'the notarization step failed'), promptLine('2026-11-06T15:00:00.000Z', 'notarization passes now')].join('\n'),
  )
  writeFileSync(join(well, 'bbbb2222-0000-4000-8000-000000000002.jsonl'), [promptLine('2026-11-08T15:00:00.000Z', 'ship the notarization fix')].join('\n'))
  const historyPath = join(dir, 'history.jsonl')
  writeFileSync(
    historyPath,
    [
      JSON.stringify({ display: 'the notarization step failed', timestamp: Date.parse('2026-11-04T15:00:00.000Z'), project: '/u/code/fun/app', sessionId: 'aaaa1111-0000-4000-8000-000000000001' }),
      JSON.stringify({ display: 'ship the notarization fix', timestamp: Date.parse('2026-11-08T15:00:00.000Z'), project: '/u/code/fun/app', sessionId: 'bbbb2222-0000-4000-8000-000000000002' }),
    ].join('\n'),
  )
  const db = openDb(':memory:')
  await buildIndex(db, { projectsDir: join(dir, 'projects'), historyPath })
  return db
}

const when = (hits: { ts: string | null }[]) => hits.map((h) => h.ts?.slice(0, 10)).sort()

describe('search: a window and a session', () => {
  test('unscoped, every hit; --since and --until cut by instant', async () => {
    const db = await seed()
    const base = { lanes: ['prompt' as const], limit: 20 }
    expect(when(searchMessages(db, 'notarization', base))).toEqual(['2026-11-04', '2026-11-06', '2026-11-08'])
    expect(when(searchMessages(db, 'notarization', { ...base, since: '2026-11-05T00:00:00.000Z' }))).toEqual(['2026-11-06', '2026-11-08'])
    expect(when(searchMessages(db, 'notarization', { ...base, until: '2026-11-08T00:00:00.000Z' }))).toEqual(['2026-11-04', '2026-11-06'])
    expect(when(searchMessages(db, 'notarization', { ...base, since: '2026-11-05T00:00:00.000Z', until: '2026-11-08T00:00:00.000Z' }))).toEqual(['2026-11-06'])
  })

  // A day a person writes is LOCAL (CLAUDE.md): it becomes the instant of
  // local midnight, in whatever zone the suite is pinned to. The boundary is
  // derived, never hardcoded — a UTC day string passes in UTC and nowhere else.
  test('a bare date is the local day: it cuts at local midnight, on both ends', async () => {
    const db = await seed()
    const base = { lanes: ['prompt' as const], limit: 20 }
    const expected = (since: string | null, until: string | null) =>
      ['2026-11-04T15:00:00.000Z', '2026-11-06T15:00:00.000Z', '2026-11-08T15:00:00.000Z']
        .filter((ts) => (since == null || ts >= dayStart(since)) && (until == null || ts < dayStart(until)))
        .map((ts) => ts.slice(0, 10))
    expect(when(searchMessages(db, 'notarization', { ...base, since: '2026-11-06' }))).toEqual(expected('2026-11-06', null))
    expect(when(searchMessages(db, 'notarization', { ...base, until: '2026-11-06' }))).toEqual(expected(null, '2026-11-06'))
    // Whatever the zone, a window of days on either side of the three keeps all of them.
    expect(when(searchMessages(db, 'notarization', { ...base, since: '2026-11-03', until: '2026-11-10' }))).toHaveLength(3)
  })

  test('--session is an id prefix, and composes with the window', async () => {
    const db = await seed()
    const base = { lanes: ['prompt' as const], limit: 20 }
    expect(when(searchMessages(db, 'notarization', { ...base, session: 'aaaa1111' }))).toEqual(['2026-11-04', '2026-11-06'])
    expect(when(searchMessages(db, 'notarization', { ...base, session: 'bbbb' }))).toEqual(['2026-11-08'])
    expect(when(searchMessages(db, 'notarization', { ...base, session: 'aaaa1111', since: '2026-11-05T00:00:00.000Z' }))).toEqual(['2026-11-06'])
    expect(searchMessages(db, 'notarization', { ...base, session: 'cccc' })).toEqual([])
  })

  test('--history takes the same scope', async () => {
    const db = await seed()
    // history.jsonl stamps in epoch milliseconds; the row goes out as an instant.
    expect(
      searchHistory(db, 'notarization', { limit: 20 })
        .map((h) => h.ts)
        .sort(),
    ).toEqual(['2026-11-04T15:00:00.000Z', '2026-11-08T15:00:00.000Z'])
    expect(searchHistory(db, 'notarization', { limit: 20, until: '2026-11-05T00:00:00.000Z' }).map((h) => h.sessionId)).toEqual(['aaaa1111-0000-4000-8000-000000000001'])
    expect(searchHistory(db, 'notarization', { limit: 20, since: '2026-11-05T00:00:00.000Z' }).map((h) => h.sessionId)).toEqual(['bbbb2222-0000-4000-8000-000000000002'])
    expect(searchHistory(db, 'notarization', { limit: 20, session: 'aaaa' }).map((h) => h.sessionId)).toEqual(['aaaa1111-0000-4000-8000-000000000001'])
  })
})
