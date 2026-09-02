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
- A background **job id is the id of the session it started with**, and every
  `/clear` after that mints a NEW session id pointing back at that root
  (`sessions.job_session_id`). So a job is a chain of sessions, its root
  usually a stub of a few lines, and the fan-out lives under whichever session
  was current when it ran. `lore agents` prints the job as `id` and the live
  session as `sessionId` — **only the latter resolves spawns**, and the former
  resolves as a real (empty) session, so the wrong copy is a plausible `0`
  rather than an error. Generalized (ccc, 09-02): **when a listing exposes two
  ids, say which one survives the thing you are about to do with it** —
  `spawns --session` does it by naming the job-mate that holds the rows.
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
