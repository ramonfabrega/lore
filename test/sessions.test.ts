import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { listSessions } from '../src/sessions'
import { day } from '../src/fmt'

function seedDb(): Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE wells(id INTEGER PRIMARY KEY, dir TEXT UNIQUE NOT NULL, real_path TEXT,
      is_worktree INTEGER NOT NULL DEFAULT 0, has_memory INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions(id INTEGER PRIMARY KEY, well_id INTEGER NOT NULL, session_id TEXT UNIQUE NOT NULL,
      size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, lines INTEGER NOT NULL DEFAULT 0, first_ts TEXT, last_ts TEXT,
      last_activity_ts TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, uuid TEXT, ts TEXT,
      lane TEXT NOT NULL, type TEXT NOT NULL, git_branch TEXT, cwd TEXT, peer TEXT);
    CREATE VIRTUAL TABLE messages_fts USING fts5(text);
    CREATE TABLE requests(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL, ts TEXT, model TEXT,
      effort TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0, cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      thinking_tokens INTEGER NOT NULL DEFAULT 0, stop_reason TEXT, UNIQUE(session_id, message_id));
  `)
  db.exec(`
    INSERT INTO requests(session_id, message_id, ts, model) VALUES
      ('s-old', 'r1', '2026-07-09T10:01:00Z', 'claude-opus-5'),
      ('s-old', 'r2', '2026-07-09T10:02:00Z', 'claude-opus-5'),
      ('s-old', 'r3', '2026-07-09T11:02:00Z', 'claude-fable-5-1'),
      ('s-new', 'r4', '2026-07-12T10:01:00Z', 'claude-sonnet-5');
  `)
  db.exec(`
    INSERT INTO wells(id, dir, real_path) VALUES
      (1, '-u-code-fun-scan--claude-worktrees-scanner-spike', '/u/code/fun/scan/.claude/worktrees/scanner-spike'),
      (2, '-u-code-fun-demo', '/u/code/fun/demo');
    INSERT INTO sessions(well_id, session_id, size, mtime_ms, lines, first_ts, last_ts, last_activity_ts) VALUES
      (1, 's-old', 10, 0, 100, '2026-07-09T10:00:00Z', '2026-08-01T10:00:00Z', '2026-07-10T10:00:00Z'),
      (1, 's-new', 10, 0, 50, '2026-07-12T10:00:00Z', '2026-07-12T11:00:00Z', '2026-07-12T11:00:00Z'),
      (2, 's-demo', 10, 0, 5, '2026-07-11T10:00:00Z', '2026-07-11T10:30:00Z', NULL);
  `)
  const insertMsg = db.prepare('INSERT INTO messages(id, session_id, ts, lane, type, cwd, peer) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const insertText = db.prepare('INSERT INTO messages_fts(rowid, text) VALUES (?, ?)')
  const rows: [number, string, string, string, string, string | null, string | null][] = [
    [1, 's-old', '2026-07-09T10:00:00Z', 'prompt', 'user', '/u/code/fun/scan', null],
    [2, 's-old', '2026-07-09T10:05:00Z', 'text', 'assistant', '/u/code/fun/scan/.claude/worktrees/scanner-spike', null],
    [3, 's-old', '2026-07-09T11:00:00Z', 'prompt', 'user', '/u/code/fun/scan/.claude/worktrees/scanner-spike', null],
    [4, 's-new', '2026-07-12T10:00:00Z', 'prompt', 'user', null, null],
    // s-demo was opened by a PEER, not by the user: no prompt-lane row at all.
    [5, 's-demo', '2026-07-11T10:00:00Z', 'relay', 'user', null, 'lore'],
  ]
  const texts: Record<number, string> = {
    1: 'i want to make a  scan\nutil tool',
    2: 'sure, here is a plan',
    3: 'now add dupes',
    4: `${'x'.repeat(200)} tail`,
    5: 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/9.sock" from-name="lore" from-mode="prompting">\nKickoff brief for ccc v0.\n</cross-session-message>\n\nThis came from another Claude session.',
  }
  for (const r of rows) {
    insertMsg.run(...r)
    insertText.run(r[0], texts[r[0]]!)
  }
  return db
}

test('workDir is the modal cwd across all lanes; workDirs counts distinct; no cwd → null/0', () => {
  const rows = listSessions(seedDb(), { limit: 100 })
  const old = rows.find((r) => r.sessionId === 's-old')!
  expect(old.workDir).toBe('/u/code/fun/scan/.claude/worktrees/scanner-spike')
  expect(old.workDirs).toBe(2)
  const noCwd = rows.find((r) => r.sessionId === 's-new')!
  expect(noCwd.workDir).toBeNull()
  expect(noCwd.workDirs).toBe(0)
})

describe('listSessions', () => {
  test('chronological order, date-trimmed, prompt counts, flattened first prompt', () => {
    const rows = listSessions(seedDb(), { limit: 100 })
    expect(rows.map((r) => r.sessionId)).toEqual(['s-old', 's-demo', 's-new'])
    const old = rows[0]!
    expect(old.first).toBe(day('2026-07-09T10:00:00Z'))
    expect(old.last).toBe(day('2026-07-10T10:00:00Z'))
    expect(old.idleUntil).toBe(day('2026-08-01T10:00:00Z'))
    expect(old.prompts).toBe(2)
    expect(old.firstPrompt).toBe('i want to make a scan util tool')
    // what SERVED the session, heaviest first — a listing names what ran it
    expect(old.models).toEqual([
      { model: 'claude-opus-5', requests: 2 },
      { model: 'claude-fable-5-1', requests: 1 },
    ])
    expect(rows.find((r) => r.sessionId === 's-new')!.models).toEqual([{ model: 'claude-sonnet-5', requests: 1 }])
    // a session with no requests answers an empty mix, never a guess
    expect(rows.find((r) => r.sessionId === 's-demo')!.models).toEqual([])
  })

  test('well substring filter matches dir or real path', () => {
    const byDir = listSessions(seedDb(), { well: 'scanner-spike', limit: 100 })
    expect(byDir.map((r) => r.sessionId)).toEqual(['s-old', 's-new'])
    const byPath = listSessions(seedDb(), { well: '/u/code/fun/demo', limit: 100 })
    expect(byPath.map((r) => r.sessionId)).toEqual(['s-demo'])
  })

  test('exact well filter isolates a prefix well that substring cannot', () => {
    const db = seedDb()
    db.exec(`
      INSERT INTO wells(id, dir, real_path) VALUES (3, '-u-code', '/u/code');
      INSERT INTO sessions(well_id, session_id, size, mtime_ms, lines, first_ts, last_ts, last_activity_ts)
        VALUES (3, 's-root', 10, 0, 1, '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z');
    `)
    // '-u-code' is a prefix of every well dir — substring matches all four
    expect(listSessions(db, { well: '-u-code', limit: 100 })).toHaveLength(4)
    const exact = listSessions(db, { well: '-u-code', exact: true, limit: 100 })
    expect(exact.map((r) => r.sessionId)).toEqual(['s-root'])
  })

  test('long first prompt is truncated with ellipsis; no prompts → null', () => {
    const rows = listSessions(seedDb(), { limit: 100 })
    const long = rows.find((r) => r.sessionId === 's-new')!
    expect(long.firstPrompt!.length).toBe(141)
    expect(long.firstPrompt!.endsWith('…')).toBe(true)
  })

  // An agent standing by that a peer sets to work has no prompt-lane row, and
  // headed the arc with a dash until the relay lane got a head of its own.
  test('a session opened by a peer heads its arc with the relayed message, named', () => {
    const demo = listSessions(seedDb(), { limit: 100 }).find((r) => r.sessionId === 's-demo')!
    expect(demo.prompts).toBe(0)
    expect(demo.openedBy).toBe('lore')
    expect(demo.firstPrompt).toBe('Kickoff brief for ccc v0.')
  })

  test('limit takes the NEWEST n, then renders oldest-first', () => {
    // The pre-v11 bug: LIMIT over an ascending sort returned the OLDEST n, so
    // `-n 1` on a live well answered with last month. Ingest #13 measured a
    // 66-session backlog as ~8 this way.
    expect(listSessions(seedDb(), { limit: 1 }).map((r) => r.sessionId)).toEqual(['s-new'])
    expect(listSessions(seedDb(), { limit: 2 }).map((r) => r.sessionId)).toEqual(['s-demo', 's-new'])
  })

  test('last reports activity, not heartbeats; idleUntil exposes the dormant tail', () => {
    const rows = listSessions(seedDb(), { limit: 100 })
    const old = rows.find((r) => r.sessionId === 's-old')!
    // last_ts is 08-01 (a heartbeat); the work ended 07-10.
    expect(old.last).toBe(day('2026-07-10T10:00:00Z'))
    expect(old.idleUntil).toBe(day('2026-08-01T10:00:00Z'))
    // A session with no heartbeat tail reports null rather than echoing last.
    expect(rows.find((r) => r.sessionId === 's-new')!.idleUntil).toBeNull()
    // No last_activity_ts at all → fall back to last_ts, and claim no tail.
    const demo = rows.find((r) => r.sessionId === 's-demo')!
    expect(demo.last).toBe(day('2026-07-11T10:30:00Z'))
    expect(demo.idleUntil).toBeNull()
  })

  test('since filters on activity, so a heartbeat-only tail does not qualify', () => {
    // s-old pings until 08-01 but stopped working 07-10 — a delta window
    // opening 07-11 must not pick it up.
    expect(listSessions(seedDb(), { since: '2026-07-11', limit: 100 }).map((r) => r.sessionId)).toEqual([
      's-demo',
      's-new',
    ])
    expect(listSessions(seedDb(), { since: '2026-07-12', limit: 100 }).map((r) => r.sessionId)).toEqual(['s-new'])
    expect(listSessions(seedDb(), { since: '2027-01-01', limit: 100 })).toEqual([])
  })

  test('since composes with the well filter', () => {
    const rows = listSessions(seedDb(), { well: 'scanner-spike', since: '2026-07-11', limit: 100 })
    expect(rows.map((r) => r.sessionId)).toEqual(['s-new'])
  })
})
