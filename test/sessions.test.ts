import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { listSessions } from '../src/sessions'

function seedDb(): Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE wells(id INTEGER PRIMARY KEY, dir TEXT UNIQUE NOT NULL, real_path TEXT,
      is_worktree INTEGER NOT NULL DEFAULT 0, has_memory INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions(id INTEGER PRIMARY KEY, well_id INTEGER NOT NULL, session_id TEXT UNIQUE NOT NULL,
      size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, lines INTEGER NOT NULL DEFAULT 0, first_ts TEXT, last_ts TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, uuid TEXT, ts TEXT,
      lane TEXT NOT NULL, type TEXT NOT NULL, git_branch TEXT, cwd TEXT);
    CREATE VIRTUAL TABLE messages_fts USING fts5(text);
  `)
  db.exec(`
    INSERT INTO wells(id, dir, real_path) VALUES
      (1, '-u-code-fun-disk--claude-worktrees-scanner-spike', '/u/code/fun/disk/.claude/worktrees/scanner-spike'),
      (2, '-u-code-fun-tv', '/u/code/fun/tv');
    INSERT INTO sessions(well_id, session_id, size, mtime_ms, lines, first_ts, last_ts) VALUES
      (1, 's-old', 10, 0, 100, '2026-07-09T10:00:00Z', '2026-07-10T10:00:00Z'),
      (1, 's-new', 10, 0, 50, '2026-07-12T10:00:00Z', '2026-07-12T11:00:00Z'),
      (2, 's-tv', 10, 0, 5, '2026-07-11T10:00:00Z', '2026-07-11T10:30:00Z');
  `)
  const insertMsg = db.prepare('INSERT INTO messages(id, session_id, ts, lane, type, cwd) VALUES (?, ?, ?, ?, ?, ?)')
  const insertText = db.prepare('INSERT INTO messages_fts(rowid, text) VALUES (?, ?)')
  const rows: [number, string, string, string, string, string | null][] = [
    [1, 's-old', '2026-07-09T10:00:00Z', 'prompt', 'user', '/u/code/fun/disk'],
    [2, 's-old', '2026-07-09T10:05:00Z', 'text', 'assistant', '/u/code/fun/disk/.claude/worktrees/scanner-spike'],
    [3, 's-old', '2026-07-09T11:00:00Z', 'prompt', 'user', '/u/code/fun/disk/.claude/worktrees/scanner-spike'],
    [4, 's-new', '2026-07-12T10:00:00Z', 'prompt', 'user', null],
  ]
  const texts: Record<number, string> = {
    1: 'i want to make a  disk\nutil tool',
    2: 'sure, here is a plan',
    3: 'now add dupes',
    4: `${'x'.repeat(200)} tail`,
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
  expect(old.workDir).toBe('/u/code/fun/disk/.claude/worktrees/scanner-spike')
  expect(old.workDirs).toBe(2)
  const noCwd = rows.find((r) => r.sessionId === 's-new')!
  expect(noCwd.workDir).toBeNull()
  expect(noCwd.workDirs).toBe(0)
})

describe('listSessions', () => {
  test('chronological order, date-trimmed, prompt counts, flattened first prompt', () => {
    const rows = listSessions(seedDb(), { limit: 100 })
    expect(rows.map((r) => r.sessionId)).toEqual(['s-old', 's-tv', 's-new'])
    const old = rows[0]!
    expect(old.first).toBe('2026-07-09')
    expect(old.last).toBe('2026-07-10')
    expect(old.prompts).toBe(2)
    expect(old.firstPrompt).toBe('i want to make a disk util tool')
  })

  test('well substring filter matches dir or real path', () => {
    const byDir = listSessions(seedDb(), { well: 'scanner-spike', limit: 100 })
    expect(byDir.map((r) => r.sessionId)).toEqual(['s-old', 's-new'])
    const byPath = listSessions(seedDb(), { well: '/u/code/fun/tv', limit: 100 })
    expect(byPath.map((r) => r.sessionId)).toEqual(['s-tv'])
  })

  test('long first prompt is truncated with ellipsis; no prompts → null', () => {
    const rows = listSessions(seedDb(), { limit: 100 })
    const long = rows.find((r) => r.sessionId === 's-new')!
    expect(long.firstPrompt!.length).toBe(141)
    expect(long.firstPrompt!.endsWith('…')).toBe(true)
    expect(rows.find((r) => r.sessionId === 's-tv')!.firstPrompt).toBeNull()
    expect(rows.find((r) => r.sessionId === 's-tv')!.prompts).toBe(0)
  })

  test('limit caps results', () => {
    expect(listSessions(seedDb(), { limit: 1 }).map((r) => r.sessionId)).toEqual(['s-old'])
  })
})
