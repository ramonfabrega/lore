import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

// messages carries metadata only; the text lives once, in the FTS table, with
// a shared rowid (plain FTS5 — deletable, no external-content bookkeeping).
//
// Schema changes bump SCHEMA_VERSION; openDb drops and recreates when the db
// is OLDER, and refuses when the db is NEWER than the build (stale-build guard)
// (rebuild beats migrate — the db is a derived artifact). v2: messages.cwd,
// the ground truth for where work happened (well membership only records the
// session's creation-time cwd). v3: the canon corpus (repos/docs/docs_fts) —
// git-committed .md across repos, read from git objects. v4: repos.is_foreign.
// v5: is_foreign generalizes to ownership (mine/assisted/foreign) — assisted
// repos (helped someone else; zero commits under the user's identity) index
// but are flagged so their canon never reads as the user's doctrine.
// v6: spawns — the subagent observatory. One row per spawn transcript under
// <session>/subagents/; `model` is VERIFIED from the first request (the spawn
// parameter and completion notification are never trusted), `requested_model`
// is the parameter from meta.json when one was passed.
// v7: spawns.boot_cached — the cache_read share of the boot envelope (half of
// all runs historically booted full-freight; the reuse rate is a lore#6 ask).
// v8: messages.tool_name — structured invocation names (tools, `Skill:<name>`,
// `command:<name>`) feeding the ambient ROI ledger (lore#7): every roster
// line's ambient cost scored against its actual usage.
// v9: workflow_runs + spawns.workflow_run_id — Workflow orchestration runs as
// first-class rows. A run persists its full script (meta: name/description/
// phases) at <session>/workflows/wf_*.json and its agents under
// <session>/subagents/workflows/wf_*/ — previously invisible to the spawn
// observatory, which is exactly where the token-heavy fan-outs live.
// v10: spawns.last_stop_reason — telemetry honesty; a spawn that never reached
// a terminal stop_reason has token totals that are a FLOOR, not a measurement.
// v11: sessions.last_activity_ts — last_ts is the last line of ANY kind, and
// harness heartbeats (bridge_status and other entry-less records) carry
// timestamps, so a dormant session keeps ticking. Two ingest-#13 miners
// independently misdated their buckets from it: fantasy's 3493ca55 reports
// last_ts 08-17 for work that ended 07-25, and rafffle's aa620a02 reports a
// last_ts matching no message in any lane. last_activity_ts is the last line
// that produced an entry in a WORK lane (prompt/text/thinking/tool) — note
// that `system`/bridge_status records DO index, into the event lane, so
// "produced any entry" is not a strong enough test.
// Known limit: a real-but-trivial exchange still counts as activity (a bare
// "Continue from where you left off." + "No response requested." keeps the
// clock running). Distinguishing that from real work needs content judgment,
// not a timestamp rule, so it is deliberately out of scope.
// v12: requests — the token profile (lore#8). One row per API request of the
// MAIN thread (assistant records deduped by message.id — streaming snapshots
// repeat), carrying the four billed token classes plus thinking, the served
// model, and the effort. `lore usage` aggregates it by well/session/model/
// day/week/month with a list-price cost-equivalent. Until v12 the only usage
// figures in the index were the spawn rollups; the 2026-09-01 loop telemetry
// (13.1M out / 4.05B cache-read over four days) was hand-computed from raw
// JSONL, and Fable 5.1's 75% cache-read cut the same day made "what does the
// loop cost, in which token class" a question worth answering mechanically.
// v13: the explorer's joins (docs/EXPLORER.md). messages.prompt_id — the
// transaction key (every user record carries promptId; assistant records
// inherit the last seen in file order); messages.tool_use_id + is_error —
// instruction ↔ log pairing (latency is the timestamp pair); messages.
// request_id — assistant rows' message.id, the join to `requests`;
// sessions.job_session_id — the background job's id across its /clears.
const SCHEMA_VERSION = 13
const TABLES = ['wells', 'sessions', 'messages', 'messages_fts', 'history', 'history_fts', 'repos', 'docs', 'docs_fts', 'spawns', 'workflow_runs', 'requests']
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
  last_ts TEXT,
  last_activity_ts TEXT,
  job_session_id TEXT
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  uuid TEXT,
  ts TEXT,
  lane TEXT NOT NULL,
  type TEXT NOT NULL,
  git_branch TEXT,
  cwd TEXT,
  tool_name TEXT,
  prompt_id TEXT,
  tool_use_id TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_lane ON messages(lane);
CREATE INDEX IF NOT EXISTS idx_messages_tool ON messages(tool_name) WHERE tool_name IS NOT NULL;
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
  ownership TEXT NOT NULL DEFAULT 'mine' CHECK(ownership IN ('mine', 'assisted', 'foreign'))
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
CREATE TABLE IF NOT EXISTS spawns(
  id INTEGER PRIMARY KEY,
  well_dir TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT UNIQUE NOT NULL,
  agent_type TEXT,
  description TEXT,
  spawn_depth INTEGER,
  requested_model TEXT,
  model TEXT,
  boot_tokens INTEGER,
  boot_cached INTEGER,
  requests INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  tool_uses INTEGER NOT NULL DEFAULT 0,
  first_ts TEXT,
  last_ts TEXT,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  workflow_run_id TEXT,
  -- stop_reason of the transcript's LAST assistant record (schema v10). A
  -- healthy finished spawn ends 'end_turn'. Anything else means the totals are
  -- a FLOOR, not a measurement: 'tool_use' = ended mid-tool with no final
  -- answer (interrupted/killed), NULL = the terminal usage row never landed
  -- (seen 2026-07-24: a final record held 22k chars but output_tokens 6).
  last_stop_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_spawns_session ON spawns(session_id);
CREATE INDEX IF NOT EXISTS idx_spawns_workflow ON spawns(workflow_run_id) WHERE workflow_run_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS workflow_runs(
  id INTEGER PRIMARY KEY,
  run_id TEXT UNIQUE NOT NULL,
  well_dir TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT,
  description TEXT,
  phases TEXT,
  task_id TEXT,
  script TEXT NOT NULL,
  recorded_ts TEXT,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_session ON workflow_runs(session_id);
CREATE TABLE IF NOT EXISTS requests(
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  ts TEXT,
  model TEXT,
  effort TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  UNIQUE(session_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
`

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  // Parallel sessions (bg jobs, subagent fan-outs) share this db — wait out
  // writer contention instead of throwing SQLITE_BUSY at the first overlap.
  db.exec('PRAGMA busy_timeout = 5000')
  const { user_version: version } = z
    .object({ user_version: z.number() })
    .parse(db.prepare('PRAGMA user_version').get())
  // Older db: rebuild (derived artifact). Newer db: REFUSE — a stale build
  // must never drop a current index (the v5/v8 checkout ping-pong incident).
  if (version > SCHEMA_VERSION) {
    db.close()
    throw new Error(
      `lore.db is schema v${version} but this build only knows v${SCHEMA_VERSION} — ` +
        `you are running a stale lore (old checkout or outdated installed bin). ` +
        `Use the current build, or reinstall it via scripts/install.`,
    )
  }
  if (version !== SCHEMA_VERSION) {
    for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
  db.exec(SCHEMA)
  return db
}
