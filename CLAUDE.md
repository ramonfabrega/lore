# lore

Claude Code memory/conversation explorer and knowledge compounder. Scans the
wells in `~/.claude/projects` (transcript JSONL + per-project memory dirs),
archives and indexes them, maintains an LLM-written wiki, and promotes matured
knowledge into canon (git-committed CLAUDE.mds and docs).

**Status, ingest history, and open threads live in the wiki** (a separate
private git repo at `LORE_WIKI_DIR`; `lore wiki init` lays one down from
`docs/wiki-template/`): `projects/lore.md` is this project's state page,
`log.md` the chronology, `index.md` the map. This file carries only what every
session needs: thesis, architecture, constraints, conventions. Decision
narrative: `docs/DESIGN.md`.

## Thesis

Claude Code memory is **path-sharded** — one well per directory you work in,
all mutually blind — while knowledge is repo- or workspace-scoped.
Conversations and memories never compound. lore bridges wells (sync),
accumulates knowledge (wiki), and graduates it (canon).

## Architecture

Tiers: **raw sources** (immutable transcripts + memories) → **wiki**
(lore-maintained markdown; the compounding middle layer) → **canon**
(git-committed docs). Three corpora feed layer 1: transcripts, memories, and
canon docs (indexed via git objects; powers lint, the map, graduation dedup).

Ops: **ingest** (raw → wiki), **graduate** (wiki → canon; human-approved;
protocol v1.2 in DESIGN.md — facts as PRs, work as issues, repo-lens review
gate, tombstones), **lint** (flag stale canon and cross-app drift). These are
protocols interactive sessions perform by driving the CLI — not CLI verbs.

Layers: (1) **deterministic CLI** — scan, parse, archive, index (SQLite FTS5),
search, ledger; zero model dependency; agent-first design (wevm/incur
conventions). (2) **judgment** — interactive sessions drive the CLI via the
`lore-*` skills (the session is the brain, the CLI is the eyes). No root
`~/code/CLAUDE.md` map — ambient context must earn its per-session cost.

Deployment assumption (not a hardened property, and not to be defended with
guards): lore is a **localhost/tailnet explorer where the user is both server
and client** — one person, one machine, one timezone, never internet-facing.
So server-side and client-side are a free choice made on convenience, not a
trust boundary: the server rendering in its own zone IS rendering in the
reader's zone. Someone reading `web.ts` cold would assume multi-viewer and
build a per-viewer negotiation that buys nothing here. If this stops being
true, it is a design change, not a bug fix.

## Hard constraints

- **Subscription OAuth only.** Never an API key; never design around API
  billing. In-session subagent fan-out is the sanctioned parallel lane;
  `claude -p` is an escape hatch only.
- Layer 1 stays model-free.
- Graduation writes git-committed files → always human-approved, and loud
  about *which repo* a fact lands in (work vs personal must never cross;
  assisted repos never receive graduations and their canon is context only —
  never the user's prior art or provenance).

## Fan-out rules (violations are findings, not workarounds)

- Defined agents (`.claude/agents/`: lore-miner, lore-canon-auditor) pin
  `model: sonnet` in frontmatter — spawn by agentType with NO per-call model
  override. Ad-hoc spawns of generic types MUST pass an explicit model;
  omission inherits the main loop's Fable.
- VERIFY the model from the spawn's task-output JSONL (`"model":"..."` on the
  first request, ~15s in) — never trust the spawn parameter or completion
  notification alone. Post-hoc this is mechanized: `lore spawns` reports the
  verified model per spawn and flags requested-vs-served `drift`.
- Bg-job sessions skip project-agent discovery at start (upstream bug);
  `/reload-plugins` fixes it; ad-hoc explicit-sonnet is the proven fallback.
- Miner/auditor bucket prompts pin the CLI explicitly ("invoke as `lore`,
  never `bun src/main.ts`") — def-only guidance proven insufficient
  (ingest #8: 3/3 drifted via cwd affordance; #9 with pins: 0/6).
- Ledger every fan-out in the wiki log: per agent — scope, tokens, tools,
  duration, verified model.

## Code conventions (rationale in DESIGN.md)

- **Bun-first**: Bun API when one exists (`Bun.file`, `Bun.write`, `Bun.$`,
  `bun:sqlite`, `bun:test`); `node:fs`/`node:path`/`node:os` for the gaps —
  idiomatic Bun, not a compromise.
- **Boundary parsing, no casts**: DB rows, env, and JSONL are zod-parsed at
  the edge; schemas colocated with the queries that produce them. Never
  `as X` on I/O. Env is one validated object in `config.ts`.
- **No ORM** over lore.db — it's a derived artifact (rebuild beats migrate;
  openDb rebuilds over OLDER schemas and refuses NEWER ones) and the
  load-bearing queries are FTS5.
- `lore docs` reads git objects only (`ls-tree`/`cat-file`), never working
  trees — canon can exist only at origin (husk repos).
- **Prod bin vs dev lane**: the installed `lore` (frozen artifact, built by
  `scripts/install.ts` from a clean landed tree; gates on tests) is the default
  everywhere including spawns. `bun src/main.ts` is the dev lane, invoked by
  explicit absolute path only — never "from the current directory". openDb
  refuses DBs newer than the build (stale checkouts fail loudly, never
  drop-rebuild). Every invocation self-identifies on stderr.
- **An instant is UTC, a day is local.** Storage, ordering, `--since`
  cursors, index deltas and rate dates (a vendor fact: when a price changed)
  are UTC and stay UTC. A DAY is a human unit — `usage --by day` answers
  "what did I do Tuesday" — so it is LOCAL, at the display edge only
  (`fmt.ts`: `day`/`hms`/`hm`/`zone`/`todayLocal`/`dayStart`, and
  `date(ts,'localtime')` in the SQL buckets). At UTC-5 a UTC day boundary
  falls at 7pm and cuts the most active hours in half. The failure mode is
  the HALF migration — localize the buckets, leave a sliced ISO string
  somewhere, and the page contradicts itself — so a window a person writes
  goes through `dayStart` to become the UTC instant of local midnight, and
  nothing compares `ts.slice(0, 10)` against a local day. The zone is the
  PROCESS zone (standard `TZ`, set before launch): there is deliberately no
  `LORE_TZ`, because assigning `process.env.TZ` at runtime moves Intl and
  leaves SQLite's `localtime` behind (measured 2026-09-02). Tests pin their
  zone or derive expectations from `day()`; a hardcoded day string passes in
  Panama and fails in CI. The suite needs a PINNED zone (`TZ=UTC bun test`):
  `bun test` forces the JS half to UTC and cannot move SQLite's, so an
  unpinned run has the two disagreeing. CI runs UTC on all three platforms
  and a second POSIX-only pass at UTC+14, because UTC hides every day-bucket
  regression — there a local day and a UTC day are the same day.

## Data-model invariants

- Wells are continuous work streams; the user `/clear`s long-lived sessions.
  Group by well + time, infer arcs from artifacts; never impose conventions
  without evidence from the data.
- Recording channels shard by dir: the transcript shards by cwd (`/clear`
  re-shards to a NEW session id); memory shards to the launch dir. Well
  membership ≠ work location — ground truth is per-message `cwd`/`gitBranch`.
  **Mid-session worktree entry MOVES the transcript file, retroactively, on
  EVERY entry** (2026-09-02, confirmed; the earlier "cwd at session creation"
  rule and its DISPUTED note are both superseded). The whole file relocates to
  the well of the worktree the session is in NOW — pre-entry records included,
  leaving NOTHING in the one it left — and the session's directory
  (`<id>/subagents/`) travels with it, so a well that had sessions can be
  emptied to zero entries while the dir itself remains. It is not a one-shot
  at first entry: session 57084123 moved parent → v0 → v1 and ended up one
  file in the v1 well carrying all four cwds (89 records at `~/code/fun/ccc`,
  1298 at v0, 163 in a v0 subdir, 266 at v1), with the v0 well left completely
  empty. Re-derived across independent sessions, projects and drivers:
  5a57a968 (an hour of pre-entry work moved) and 57084123 (twice). Do not read
  stubs left in a parent well as residue of a move — sibling stubs there are
  separate sessions minted by `/model` or `/clear`, which is the re-shard
  rule, not a counter-example. Code that resolves a session to a file must
  still try BOTH wells (`verifyModels` in `agents.ts` does), but the CURRENT
  worktree well is the likely branch and the parent the fallback; the index
  keys on session id, so a re-index after a move updates the row's well rather
  than duplicating it (checked, not assumed).
- A well dir is its cwd with **every non-alphanumeric replaced by `-`, one
  per NFC character** — ASCII letters and digits alone survive (`slugWellDir`).
  Measured 2026-09-02 against three wells minted for the question: `_`, space,
  `~`, `+`, `@` collapse exactly like `/` and `.`; non-ASCII collapses at one
  dash per character (`日本語` → `---`, not per UTF-8 byte). The map is
  many-to-one, so a slug must be VERIFIED against disk, never trusted. The
  **NFC** clause is the one with teeth: the harness mangles the cwd it
  recorded, and that arrives NFC, but names read back off a filesystem carry
  whatever was written and macOS writes NFD freely — mangle a `readdir` entry
  without normalizing and a live well reads as a deleted source. Corpus of 90
  real wells at `~/.lore/wells-corpus.jsonl`, a curated subset committed at
  `test/fixtures/wells-corpus.jsonl`; two independent implementations pass it
  (lore's, and ccc's `WellPath`).
- Wells outlive their dirs (worktree deletion loses no transcripts), and
  "gone by id ≠ gone by content" (respawns/resume-forks re-id sessions;
  measure loss by content lineage). Per-spawn subagent transcripts persist
  under `<session>/subagents/` — agentType, per-request model and usage.
  Workflow runs persist their full script (meta: name/phases) at
  `<session>/workflows/wf_*.json`, agents under `subagents/workflows/wf_*/`;
  `lore workflows` is the per-run observatory, `spawns --workflow` the
  drill-down.
- **Authorship of a user record is a FIELD, never the shape of its prose**:
  `origin.kind` is `human` (a person typing), `peer` (another session's
  cross-session message) or `task-notification`; `isMeta` marks what the
  harness injected into the turn (skill bodies, with `sourceToolUseID` naming
  the Skill call that pulled them in; image placeholders; context reports).
  lore sniffed prefixes until v15 and so filed both in `prompt` — **54% of
  that lane's volume was not the user** (measured 09-02: 3.60M → 1.69M chars,
  872 rows, reconciled exactly). Lanes now: `prompt` is what the user typed
  and only that, `meta` what the harness injected, **`relay` what another
  session sent** (attributed by `peer`; `lore stats` rolls up the routing
  ledger). Sizing a mining bucket off the old `prompt` lane over-counted, and
  a miner reading it attributed a peer's words to the user — a provenance
  bug, not just a sizing one.
- A background job has THREE ids, and only one of them is the job. The
  **daemon job id** (`~/.claude/jobs/<id>`, what `claude agents` prints) and
  the **bridge id** (`bridgeSessionId: cse_X` in state.json, `bridge-session`
  records in every transcript, `Claude-Session: …/session_X` in commit
  trailers) survive everything. The **root session id** (record-level
  `session_id`, `sessions.job_session_id`) is the session the CURRENT PROCESS
  started with: every `/clear` mints a new session id pointing back at it, but
  a daemon **respawn mints a new root** — lore's own job had 76ca2416 until
  06:57 and 78c6d5cc from 07:20 on 2026-09-02, with the unix socket changing
  underneath (32093 → 61989; a peer's send to the old socket failed ENOENT
  and was re-sent by name). So a job is a chain of incarnations, each a chain
  of sessions; the root keys an incarnation, the bridge id keys the job, and
  state.json's `sessionId` is the FIRST root ever, which after a respawn
  matches nothing (the session page lost `@lore` for every lore session that
  day until the join moved to `bridge_key`, v16). The fan-out lives under
  whichever session was current when it ran. `lore agents` prints the job as
  `id` and the live session as `sessionId` — **only the latter resolves
  spawns**, and the former resolves as a real (empty) session, so the wrong
  copy is a plausible `0` rather than an error. Generalized (ccc, 09-02):
  **when a listing exposes two ids, say which one survives the thing you are
  about to do with it** — `spawns --session` does it by naming the job-mate
  that holds the rows.
- **A message that arrives mid-turn is not a user record.** When a session is
  idle, a peer's message or the user's words become a `user` record and open
  a turn. When it is busy, the harness enqueues it (`queue-operation`) and
  delivers it at the next tool result as an `attachment` of type
  `queued_command` (`parentUuid` = that result; the same `origin`/`isMeta`
  authorship fields), and the turn keeps running. A parser that reads only
  `user` and `assistant` records never sees it: on the lore↔ccc thread of
  2026-09-02, **14 of lore's 22 messages reached ccc this way, and 10 of the
  17 things the user typed into ccc's session** — including the decision to
  give libghostty a serious shot. Since v16 they index into their lanes with
  `type = 'attachment'`, and `trace` places them INSIDE the turn (`received[]`,
  at their instruction position) rather than opening one. A user's mid-turn
  message is still the user's voice; count it and read it as such. The
  `queue-operation` records are the queue's bookkeeping (enqueue / dequeue =
  became a turn / remove = pulled into the running turn) and are not indexed.
- Wiki durability is CLI-owned: **every wiki op ends with
  `lore wiki commit`** (hooks don't travel across drivers).

## References

- `docs/DESIGN.md` — design narrative, decision log (graduation protocol,
  ownership model, stack), rejected alternatives.
- Wiki maintainer schema: the wiki repo's own CLAUDE.md (`LORE_WIKI_DIR`).
- Prior art: a sibling macOS disk visualizer (SQLite streaming/FSEvents
  craft — style reference only, not a base); wevm/incur (agent-first CLI
  conventions); Karpathy's llm-wiki (`docs/references/llm-wiki.md`).
- The user operates suggest-first — challenge premises, propose alternatives.
