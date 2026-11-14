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
// independently misdated their buckets from it: one session (3493ca55) reports
// last_ts 08-17 for work that ended 07-25, another (aa620a02) reports a
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
// v14: jobs — `~/.claude/jobs/<id>/state.json`, the one file tying a
// transcript uuid to the claude.ai session id in commit trailers
// (`Claude-Session: …/session_X` ↔ `bridgeSessionId: cse_X`). Resolves a
// commit to its transcript (`/s/<id>`, `lore trace session_X`).
// v15: the relay lane + messages.peer. Authorship comes off the record's own
// fields (parse.ts `Authorship`) instead of a regex over the prose, which had
// been filing injected skill bodies and other sessions' cross-session messages
// in the `prompt` lane — 54% of that lane's volume was not the user. Peer
// traffic now indexes as `relay`, attributed by `peer`, so the fleet's
// routing is a corpus you can query rather than noise in the user's voice.
// v16: the turn is not the only way a message arrives. A message that lands
// while the session is mid-turn is written as an `attachment` of type
// `queued_command` (parse.ts), never as a user record; lore read only user +
// assistant records and so had no row for 14 of the 22 messages lore sent
// ccc on 2026-09-02, nor for 10 of the 17 things the user typed into that
// session. They now index into their lanes (prompt / relay / meta) with
// `type = 'attachment'` — the row itself says it was read INSIDE a turn, so
// `trace` places it at its position among the instructions instead of
// opening a turn with it. Also sessions.bridge_key: the claude.ai session
// id from the transcript's own `bridge-session` records. `job_session_id`
// (the root) changes on a daemon respawn, and the jobs join on it lost the
// agent's name for every lore session since this morning's respawn; the
// bridge id survives /clear and respawn alike, and jobs.bridge_key already
// held the other half.
// v17: messages.msg_id — the harness's own key for a cross-session message.
// The sender's SendMessage ack carries `msg_id`, and the receiver's record
// carries the same id as `origin.msg_id` (19 of 19 on the ccc→lore leg of
// 2026-09-02; the two sends without one were a failed socket send and a
// subagent follow-up). Indexed on relay rows and on SendMessage result rows,
// it pairs both halves of every message across sessions with zero
// inference — `lore thread` is that join.
// v18: jobs.source — where a job's name came from. `state` is the daemon's
// own `state.json`; `peer` is a name recovered from the other side of a
// thread: the daemon forgets a job when the user deletes it (17 state files
// against 67 bridge ids in the transcripts, 2026-09-02), but every message
// it ever sent carries its name in the receiver's `peer`, and the msg_id
// pairs the two halves. A job is keyed on its bridge id (jobs.ts): the root
// changes on a respawn, the daemon id dies with the job, the bridge id is in
// every transcript and every commit trailer.
// v19: requests.cache_write_1h_tokens — the TTL split of a cache write (see
// the column).
// v20: spawns.open_requests — the per-request half of telemetry honesty. v10
// read the LAST record's stop_reason; harness 2.1.285 drops the completion
// record of every tool_use-ended request in a subagent file, so a spawn can
// end cleanly and still carry no output for most of its requests (10 of 10
// on a Sonnet sweep, 2026-10-07: 379 output tokens indexed against a
// 2,600-char handback alone). The count of requests whose last record has
// no stop_reason is the floor's size, and keeps the row partial.
// v21: limits — the subscription's rate-limit windows as the account enforces
// them, the one budget the token ledger could never read (see the table).
// v22: no column — spawns.last_stop_reason is DERIVED, and the derivation
// moved: `handback` is a delivered SubagentHandback whatever stop_reason its
// record carries (harness 2.1.307 started writing `tool_use` there, and every
// finished spawn since 2.1.321 read in flight). A spawn row is skipped while
// its file's size and mtime hold, so without the bump every finished file
// keeps the old reading forever.
// (no version) spawn_ledger — ccc's spawn ledger (ledger.ts). A NEW TABLE
// takes no bump: the schema below is `IF NOT EXISTS` and runs at every open,
// so the table appears on the next one, and an older build that meets it
// reads past it. The version is for a change to what an EXISTING table
// holds, where the stored rows are wrong until re-derived. That distinction
// is worth keeping because a bump is not free: it rebuilds a 3 GB index, and
// it drops the one table that has no source to rebuild from — `jobs` rows
// for jobs the daemon has deleted (371 on 2026-11-13: 25 names, 7 parent
// edges and every gone job's daemon id, carried by hand at v22).
// (no version) codex_* — the second SOURCE (codex.ts, codexindex.ts): OpenAI
// Codex rollouts, in tables of their own. The first sketch was a `source`
// column on sessions and requests, and that is a bump: it changes what two
// existing tables hold, and every query that reads them would have to say
// which vendor it meant or silently start blending two. As new tables it is
// neither — nothing that exists reads them, so a Claude page cannot change
// by accident, and the source dimension is which tables a verb was asked to
// read (`--source`). A Codex thread has no well (it keys to a repo), no
// bridge id and no /clear, so half of `sessions`' columns would have been
// null for it anyway.
const SCHEMA_VERSION = 22
// What a rebuild DROPS. `spawn_ledger` is deliberately absent: its rows are
// ccc's own lines verbatim, nothing in them is derived, and ledger.ts keeps
// them past a rotation of ccc's file — a bump that dropped the table would
// take every edge whose line ccc no longer holds.
const TABLES = ['wells', 'sessions', 'messages', 'messages_fts', 'history', 'history_fts', 'repos', 'docs', 'docs_fts', 'spawns', 'workflow_runs', 'requests', 'jobs', 'limits', 'codex_threads', 'codex_turns', 'codex_requests', 'codex_messages', 'codex_messages_fts', 'codex_questions']
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
  job_session_id TEXT,
  bridge_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_bridge ON sessions(bridge_key) WHERE bridge_key IS NOT NULL;
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
  request_id TEXT,
  -- relay lane only: the session that SENT this message (origin.name).
  peer TEXT,
  -- the harness's id for a cross-session message: origin.msg_id on a relay
  -- row, the ack's msg_id on a SendMessage result row. The pairing key.
  msg_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_msg ON messages(msg_id) WHERE msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
-- (session_id, lane, ts): the prompt count and the first prompt per session
-- were 4 ms each through the session-only index (scan every row of a busy
-- session, filter lane, sort) — ×143 sessions made a well page take 1.1 s
-- (2026-09-01). Index-only for both. Added without a version bump: the
-- schema runs on every open, so an existing db grows the index in place.
CREATE INDEX IF NOT EXISTS idx_messages_session_lane_ts ON messages(session_id, lane, ts);
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
-- The subscription's rate-limit windows (schema v21). The token ledger prices
-- requests at list rates and the user's week is a PERCENT of an allowance
-- nobody publishes; two recorded 429s and one /usage reading disagreed 2x on
-- what a week is in tokens (2026-10-28). Two sources: 'mod' rows come from
-- ~/.lore/limits.jsonl, which the limits mod appends on every whole-point
-- move of a window (kind five_hour, seven_day, or a week scoped to one model
-- such as seven_day_fable; pct 0-100, resets_at the window's end);
-- 'transcript' rows are the 429s the harness wrote into a
-- session (apiError usage_limit_reached, rate_limit_info.rateLimitType), the
-- moment a window read 100 — under the HARNESS's name for it, which for the
-- Fable week is seven_day_overage_included (limits.ts aliases it on read; the
-- table keeps what each source said). resets_at - 7d is the week's anchor, read off
-- the data, never a hardcoded weekday.
CREATE TABLE IF NOT EXISTS limits(
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  pct REAL NOT NULL,
  resets_at TEXT,
  source TEXT NOT NULL,
  UNIQUE(source, session_id, ts, kind)
);
CREATE INDEX IF NOT EXISTS idx_limits_kind_ts ON limits(kind, ts);
-- ccc's spawn ledger, one row per line (ledger.ts): child is the daemon id
-- of the job a ccc spawn minted, parent_* the caller as its environment
-- said (the daemon job id, which survives /clear; the session live at the
-- spawn; the bridge id in the trailer spelling), all null for a spawn a
-- person typed. model and effort are what was ASKED. Rows are appended and
-- kept: the index outlives ccc's file.
CREATE TABLE IF NOT EXISTS spawn_ledger(
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  child TEXT NOT NULL,
  kind TEXT NOT NULL,
  host TEXT,
  via TEXT,
  name TEXT,
  model TEXT,
  effort TEXT,
  cwd TEXT,
  worktree TEXT,
  branch TEXT,
  replaced TEXT,
  draft INTEGER,
  parent_job TEXT,
  parent_session TEXT,
  parent_bridge TEXT,
  UNIQUE(child, ts)
);
CREATE INDEX IF NOT EXISTS idx_spawn_ledger_parent_session ON spawn_ledger(parent_session);
-- Codex (OpenAI) rollouts — one row per THREAD, which is Codex's session and
-- its job at once (one id, not three). kind is worker / guardian /
-- subagent (codex.ts threadKind); root_thread_id the thread a child
-- descends from. repo is the key a thread has instead of a well: the
-- normalized remote (github.com/owner/name), else the repo path, else the
-- cwd; repo_path is the local checkout the worktree hop found at index
-- time, kept because Codex deletes the worktree. turns counts
-- task_started — a file existing is not a thread having run. The
-- reasoning_* pair says how many reasoning records there were against how
-- many said anything in plaintext (the body is ENCRYPTED on every one), and
-- withheld_* what a guardian's input came to: read, counted, never stored.
CREATE TABLE IF NOT EXISTS codex_threads(
  id INTEGER PRIMARY KEY,
  thread_id TEXT UNIQUE NOT NULL,
  root_thread_id TEXT NOT NULL,
  parent_thread_id TEXT,
  kind TEXT NOT NULL,
  thread_source TEXT,
  originator TEXT,
  cli_version TEXT,
  cwd TEXT,
  repo TEXT,
  repo_path TEXT,
  branch TEXT,
  commit_hash TEXT,
  model TEXT,
  path TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0,
  first_ts TEXT,
  last_ts TEXT,
  last_activity_ts TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  reasoning_records INTEGER NOT NULL DEFAULT 0,
  reasoning_summarized INTEGER NOT NULL DEFAULT 0,
  withheld_records INTEGER NOT NULL DEFAULT 0,
  withheld_chars INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_codex_threads_parent ON codex_threads(parent_thread_id) WHERE parent_thread_id IS NOT NULL;
-- One row per turn (task_started … task_complete). opener is what was
-- submitted to it — null on a guardian, whose input is evidence — and
-- last_agent_message Codex's own closing text, which on a guardian is the
-- verdict JSON the verdict_* columns are parsed from.
CREATE TABLE IF NOT EXISTS codex_turns(
  id INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  started_ts TEXT,
  completed_ts TEXT,
  duration_ms INTEGER,
  ttft_ms INTEGER,
  model TEXT,
  effort TEXT,
  trigger TEXT,
  opener TEXT,
  last_agent_message TEXT,
  aborted TEXT,
  error TEXT,
  verdict_outcome TEXT,
  verdict_risk TEXT,
  verdict_authorization TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  tools INTEGER NOT NULL DEFAULT 0,
  execs INTEGER NOT NULL DEFAULT 0,
  questions INTEGER NOT NULL DEFAULT 0,
  UNIQUE(thread_id, turn_id)
);
-- One row per API request, in lore's token classes: input_tokens here is
-- UNCACHED (Codex's own input_tokens minus its cached_input_tokens — see
-- codex.ts mapUsage). usage_source is 'record' (a token_usage_record, keyed
-- by response id) or 'count' (the older token_count event, on threads that
-- predate the record).
CREATE TABLE IF NOT EXISTS codex_requests(
  id INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  response_id TEXT NOT NULL,
  turn_id TEXT,
  ts TEXT,
  model TEXT,
  effort TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  usage_source TEXT NOT NULL DEFAULT 'record',
  UNIQUE(thread_id, response_id)
);
CREATE INDEX IF NOT EXISTS idx_codex_requests_thread ON codex_requests(thread_id);
CREATE INDEX IF NOT EXISTS idx_codex_requests_ts ON codex_requests(ts);
-- Messages by lane, text in the FTS table under the same rowid — the shape
-- of messages/messages_fts, and a SEPARATE fts on purpose: bm25 ranks
-- against the corpus it is in, so one shared table would re-rank every
-- Claude hit the day Codex rows arrived. Lanes are lore's plus question.
CREATE TABLE IF NOT EXISTS codex_messages(
  id INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  ts TEXT,
  lane TEXT NOT NULL,
  type TEXT NOT NULL,
  turn_id TEXT,
  tool_name TEXT,
  call_id TEXT,
  peer TEXT
);
CREATE INDEX IF NOT EXISTS idx_codex_messages_thread_lane ON codex_messages(thread_id, lane, ordinal);
CREATE INDEX IF NOT EXISTS idx_codex_messages_turn ON codex_messages(thread_id, turn_id);
CREATE VIRTUAL TABLE IF NOT EXISTS codex_messages_fts USING fts5(text);
-- A question the agent asked mid-run and what came back: the pair, joined
-- on (call_id, idx) — questionItemId. free_text: the answer was not one
-- of the options offered.
CREATE TABLE IF NOT EXISTS codex_questions(
  id INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  turn_id TEXT,
  asked_ts TEXT,
  title TEXT,
  options TEXT,
  accepted INTEGER,
  answer TEXT,
  answered_ts TEXT,
  free_text INTEGER,
  UNIQUE(thread_id, call_id, idx)
);
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
  last_stop_reason TEXT,
  -- Requests whose LAST record carries no stop_reason (schema v20): the
  -- completion record — the one that holds the request's real usage — never
  -- landed, so output_tokens is missing that request's output entirely.
  -- Harness 2.1.285 writes it for NO tool_use-ended request in a subagent
  -- file (main transcripts keep theirs), so on that version every spawn
  -- that ran a tool is a floor whatever its last stop_reason says.
  open_requests INTEGER NOT NULL DEFAULT 0
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
  -- The TTL split of cache_write_tokens (v19). A 5-minute write bills at
  -- 1.25× base input, a 1-hour write at 2×. Records older than the
  -- envelope field carry neither, so the two need not sum to the total —
  -- usage.ts prices the unsplit remainder at the 5-minute rate.
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  UNIQUE(session_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY,
  job_id TEXT UNIQUE NOT NULL,
  session_id TEXT,
  bridge_key TEXT,
  name TEXT,
  cwd TEXT,
  state TEXT,
  created_at TEXT,
  updated_at TEXT,
  source TEXT NOT NULL DEFAULT 'state'
);
CREATE INDEX IF NOT EXISTS idx_jobs_bridge ON jobs(bridge_key);
CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id);
`

export function openDb(path: string): Database {
  const dir = dirname(path)
  // ':memory:' has no directory, and a relative path's is already there.
  // recursive:true makes mkdir('.') a silent no-op on POSIX, but Bun on
  // Windows still throws EEXIST for it.
  if (path !== ':memory:' && dir !== '.') mkdirSync(dir, { recursive: true })
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  // Parallel sessions (bg jobs, subagent fan-outs) share this db — wait out
  // writer contention instead of throwing SQLITE_BUSY at the first overlap.
  db.exec('PRAGMA busy_timeout = 5000')
  // 256 MB of page cache (negative = KiB), against SQLite's 2 MB default,
  // for a 1.7 GB db whose load-bearing reads are whole-table aggregates
  // over `requests`. A cap, not an allocation: it fills only as pages are
  // read. Measured 2026-10-14: the usage aggregates 20–35% faster, warm.
  db.exec('PRAGMA cache_size = -262144')
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
        `Use the current build, or reinstall it via scripts/install.ts.`,
    )
  }
  if (version !== SCHEMA_VERSION) {
    for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
  db.exec(SCHEMA)
  return db
}
