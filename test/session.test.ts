import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { getSession } from '../src/session'

function seedDb(): Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE wells(id INTEGER PRIMARY KEY, dir TEXT UNIQUE NOT NULL, real_path TEXT,
      is_worktree INTEGER NOT NULL DEFAULT 0, has_memory INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions(id INTEGER PRIMARY KEY, well_id INTEGER NOT NULL, session_id TEXT UNIQUE NOT NULL,
      size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, lines INTEGER NOT NULL DEFAULT 0, first_ts TEXT, last_ts TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, uuid TEXT, ts TEXT,
      lane TEXT NOT NULL, type TEXT NOT NULL, git_branch TEXT);
    CREATE VIRTUAL TABLE messages_fts USING fts5(text);
  `)
  db.exec(`
    INSERT INTO wells(id, dir, real_path) VALUES (1, '-u-code-fun-gym', '/u/code/fun/gym');
    INSERT INTO sessions(well_id, session_id, size, mtime_ms, lines, first_ts, last_ts) VALUES
      (1, 'abc-111', 10, 0, 4, '2026-07-01T19:00:00Z', '2026-07-02T03:00:00Z'),
      (1, 'abd-222', 10, 0, 1, '2026-07-02T03:11:00Z', '2026-07-02T03:38:00Z');
  `)
  const insertMsg = db.prepare(
    'INSERT INTO messages(id, session_id, ts, lane, type, git_branch) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const insertText = db.prepare('INSERT INTO messages_fts(rowid, text) VALUES (?, ?)')
  const rows: [number, string, string, string, string, string | null, string][] = [
    [1, 'abc-111', '2026-07-01T19:13:00Z', 'prompt', 'user', 'master', 'i just init a new repo'],
    [2, 'abc-111', '2026-07-01T19:14:00Z', 'text', 'assistant', 'master', 'here is a plan'],
    [3, 'abc-111', '2026-07-01T21:00:00Z', 'prompt', 'user', 'worktree-gym-scaffold', 'push and keep going'],
    [4, 'abc-111', '2026-07-01T21:01:00Z', 'thinking', 'assistant', 'worktree-gym-scaffold', 'hmm'],
    [5, 'abd-222', '2026-07-02T03:11:00Z', 'prompt', 'user', null, 'lets explore llm-coach'],
  ]
  for (const [id, sid, ts, lane, type, branch, text] of rows) {
    insertMsg.run(id, sid, ts, lane, type, branch)
    insertText.run(id, text)
  }
  return db
}

describe('getSession', () => {
  test('dumps prompt lane in order with meta and gitBranch', () => {
    const dump = getSession(seedDb(), 'abc-111', { lanes: ['prompt'], limit: 500 })
    expect(dump.session.well).toBe('-u-code-fun-gym')
    expect(dump.session.first).toBe('2026-07-01T19:00:00Z')
    expect(dump.messages.map((m) => m.text)).toEqual(['i just init a new repo', 'push and keep going'])
    expect(dump.messages[1]!.gitBranch).toBe('worktree-gym-scaffold')
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
})
