import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// messages carries metadata only; the text lives once, in the FTS table, with
// a shared rowid (plain FTS5 — deletable, no external-content bookkeeping).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS wells(
  id INTEGER PRIMARY KEY,
  dir TEXT UNIQUE NOT NULL,
  real_path TEXT,
  is_worktree INTEGER NOT NULL DEFAULT 0,
  has_memory INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY,
  well_id INTEGER NOT NULL REFERENCES wells(id),
  session_id TEXT UNIQUE NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0,
  first_ts TEXT,
  last_ts TEXT
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  uuid TEXT,
  ts TEXT,
  lane TEXT NOT NULL,
  type TEXT NOT NULL,
  git_branch TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_lane ON messages(lane);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text);
CREATE TABLE IF NOT EXISTS history(
  id INTEGER PRIMARY KEY,
  ts TEXT,
  project TEXT,
  session_id TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(display);
`

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)
  return db
}
