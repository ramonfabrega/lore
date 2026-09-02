import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { getSession } from '../src/session'

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
  `)
  db.exec(`
    INSERT INTO wells(id, dir, real_path) VALUES (1, '-u-code-fun-myapp', '/u/code/fun/myapp');
    INSERT INTO sessions(well_id, session_id, size, mtime_ms, lines, first_ts, last_ts) VALUES
      (1, 'abc-111', 10, 0, 4, '2026-07-01T19:00:00Z', '2026-07-02T03:00:00Z'),
      (1, 'abd-222', 10, 0, 1, '2026-07-02T03:11:00Z', '2026-07-02T03:38:00Z');
  `)
  const insertMsg = db.prepare(
    'INSERT INTO messages(id, session_id, ts, lane, type, git_branch, cwd) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const insertText = db.prepare('INSERT INTO messages_fts(rowid, text) VALUES (?, ?)')
  const rows: [number, string, string, string, string, string | null, string | null, string][] = [
    [1, 'abc-111', '2026-07-01T19:13:00Z', 'prompt', 'user', 'master', '/u/code/fun/myapp', 'i just init a new repo'],
    [2, 'abc-111', '2026-07-01T19:14:00Z', 'text', 'assistant', 'master', '/u/code/fun/myapp', 'here is a plan'],
    [3, 'abc-111', '2026-07-01T21:00:00Z', 'prompt', 'user', 'worktree-myapp-scaffold', '/u/code/fun/myapp/.claude/worktrees/myapp-scaffold', 'push and keep going'],
    [4, 'abc-111', '2026-07-01T21:01:00Z', 'thinking', 'assistant', 'worktree-myapp-scaffold', '/u/code/fun/myapp/.claude/worktrees/myapp-scaffold', 'hmm'],
    [5, 'abd-222', '2026-07-02T03:11:00Z', 'prompt', 'user', null, null, 'lets explore that idea'],
  ]
  for (const [id, sid, ts, lane, type, branch, cwd, text] of rows) {
    insertMsg.run(id, sid, ts, lane, type, branch, cwd)
    insertText.run(id, text)
  }
  return db
}

describe('getSession', () => {
  test('dumps prompt lane in order with meta and gitBranch', () => {
    const dump = getSession(seedDb(), 'abc-111', { lanes: ['prompt'], limit: 500 })
    expect(dump.session.well).toBe('-u-code-fun-myapp')
    expect(dump.session.first).toBe('2026-07-01T19:00:00Z')
    expect(dump.messages.map((m) => m.text)).toEqual(['i just init a new repo', 'push and keep going'])
    expect(dump.messages[1]!.gitBranch).toBe('worktree-myapp-scaffold')
  })

  test('workDirs histogram spans all lanes, ordered by count', () => {
    const dump = getSession(seedDb(), 'abc-111', { lanes: ['prompt'], limit: 500 })
    expect(dump.workDirs).toEqual([
      { cwd: '/u/code/fun/myapp', n: 2 },
      { cwd: '/u/code/fun/myapp/.claude/worktrees/myapp-scaffold', n: 2 },
    ])
  })

  test('lane filter widens to requested lanes only', () => {
    const dump = getSession(seedDb(), 'abc-111', { lanes: ['prompt', 'text'], limit: 500 })
    expect(dump.messages.map((m) => m.lane)).toEqual(['prompt', 'text', 'prompt'])
  })

  test('unique prefix resolves; ambiguous or unknown prefixes throw', () => {
    expect(getSession(seedDb(), 'abd', { lanes: ['prompt'], limit: 500 }).session.sessionId).toBe('abd-222')
    expect(() => getSession(seedDb(), 'ab', { lanes: ['prompt'], limit: 500 })).toThrow(/ambiguous/)
    expect(() => getSession(seedDb(), 'zzz', { lanes: ['prompt'], limit: 500 })).toThrow(/no indexed session/)
  })

  test('limit caps messages', () => {
    const dump = getSession(seedDb(), 'abc-111', { lanes: ['prompt'], limit: 1 })
    expect(dump.messages.map((m) => m.text)).toEqual(['i just init a new repo'])
  })

  test('--well narrows an ambiguous prefix instead of erroring', () => {
    const db = seedDb()
    db.exec(`
      INSERT INTO wells(id, dir, real_path) VALUES (2, '-u-code-fun-demo', '/u/code/fun/demo');
      INSERT INTO sessions(well_id, session_id, size, mtime_ms, lines, first_ts, last_ts, last_activity_ts)
        VALUES (2, 'abe-333', 10, 0, 1, '2026-07-03T10:00:00Z', '2026-07-03T10:00:00Z', '2026-07-03T10:00:00Z');
    `)
    // 'ab' now matches three sessions across two wells.
    expect(() => getSession(db, 'ab', { lanes: ['prompt'], limit: 500 })).toThrow(/ambiguous/)
    // The well disambiguates it. Before v11 this flag errored `Unknown flag`
    // even though the lore-miner agent def documented it (ingest #12 finding).
    expect(getSession(db, 'ab', { lanes: ['prompt'], limit: 500, well: 'fun-demo' }).session.sessionId).toBe('abe-333')
    expect(getSession(db, 'ab', { lanes: ['prompt'], limit: 500, well: '/u/code/fun/demo' }).session.sessionId).toBe(
      'abe-333',
    )
    // A prefix that exists but not in the named well is a miss, not a wrong hit.
    expect(() => getSession(db, 'abc', { lanes: ['prompt'], limit: 500, well: 'fun-demo' })).toThrow(
      /no indexed session matches "abc" in a well matching "fun-demo"/,
    )
  })

  test('last reports activity; idleUntil exposes a heartbeat tail', () => {
    const db = seedDb()
    // abc-111 stops working 07-02T03:00 but keeps getting pinged for a month.
    db.exec("UPDATE sessions SET last_ts = '2026-08-02T03:00:00Z', last_activity_ts = '2026-07-02T03:00:00Z' WHERE session_id = 'abc-111'")
    const dump = getSession(db, 'abc-111', { lanes: ['prompt'], limit: 500 })
    expect(dump.session.last).toBe('2026-07-02T03:00:00Z')
    expect(dump.session.idleUntil).toBe('2026-08-02T03:00:00Z')
  })
})
