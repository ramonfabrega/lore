import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

// messages carries metadata only; the text lives once, in the FTS table, with
// a shared rowid (plain FTS5 — deletable, no external-content bookkeeping).
//
// Schema changes bump SCHEMA_VERSION; openDb drops and recreates on mismatch
// (rebuild beats migrate — the db is a derived artifact). v2: messages.cwd,
// the ground truth for where work happened (well membership only records the
// session's creation-time cwd). v3: the canon corpus (repos/docs/docs_fts) —
// git-committed .md across repos, read from git objects. v4: repos.is_foreign
// (fork-for-upstreaming detection — docs not indexed).
const SCHEMA_VERSION = 4
const TABLES = ['wells', 'sessions', 'messages', 'messages_fts', 'history', 'history_fts', 'repos', 'docs', 'docs_fts']
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
  git_branch TEXT,
  cwd TEXT
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
CREATE TABLE IF NOT EXISTS repos(
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  commit_ts INTEGER NOT NULL,
  is_husk INTEGER NOT NULL DEFAULT 0,
  is_foreign INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS docs(
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  path TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  size INTEGER NOT NULL,
  UNIQUE(repo_id, path)
);
CREATE INDEX IF NOT EXISTS idx_docs_repo ON docs(repo_id);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(text);
`

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  const { user_version: version } = z
    .object({ user_version: z.number() })
    .parse(db.prepare('PRAGMA user_version').get())
  if (version !== SCHEMA_VERSION) {
    for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
  db.exec(SCHEMA)
  return db
}
