# lore

Claude Code memory/conversation explorer and knowledge compounder. Scans the
wells in `~/.claude/projects` (transcript JSONL + per-project memory dirs),
archives and indexes them, maintains an LLM-written wiki, and promotes matured
knowledge into canon (git-committed CLAUDE.mds and docs).

**Status, ingest history, and open threads live in the wiki**
(`~/code/personal/lore-wiki`): `projects/lore.md` is this project's state page,
`log.md` the chronology, `index.md` the map. This file carries only what every
session needs: thesis, architecture, constraints, conventions. Decision
narrative: `docs/DESIGN.md`.

## Thesis

Claude Code memory is **path-sharded** — one well per directory, all mutually
blind — while knowledge is repo- or workspace-scoped. Conversations and
memories never compound. lore bridges wells (sync), accumulates knowledge
(wiki), and graduates it (canon).

## Architecture

Tiers: **raw sources** (immutable transcripts + memories) → **wiki**
(lore-maintained markdown; the compounding middle layer) → **canon**
(git-committed docs). Three corpora feed layer 1: transcripts, memories, and
canon docs (indexed via git objects; powers lint, the map, graduation dedup).

Ops: **ingest** (raw → wiki), **graduate** (wiki → canon; human-approved;
protocol v1.2 in DESIGN.md — facts as PRs, work as issues, repo-lens review
gate, tombstones), **lint** (flag stale canon and cross-app drift).

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
  openDb drops+rebuilds on schema-version mismatch) and the load-bearing
  queries are FTS5.
- `lore docs` reads git objects only (`ls-tree`/`cat-file`), never working
  trees — canon can exist only at origin (husk repos).
- **Prod bin vs dev lane**: the installed `lore` (frozen artifact, built by
  `scripts/install` from a clean landed tree; gates on tests) is the default
  everywhere including spawns. `bun src/main.ts` is the dev lane, invoked by
  explicit absolute path only — never "from the current directory". openDb
  refuses DBs newer than the build (stale checkouts fail loudly, never
  drop-rebuild). Every invocation self-identifies on stderr.

## Data-model invariants

- Wells are continuous work streams; the user `/clear`s long-lived sessions.
  Group by well + time, infer arcs from artifacts; never impose conventions
  without evidence from the data.
- Recording channels shard by dir: the transcript shards by **cwd at session
  creation** (`/clear` re-shards); memory shards to the launch dir. Well
  membership ≠ work location — ground truth is per-message `cwd`/`gitBranch`.
  **DISPUTED (2026-09-02, needs review):** "mid-session worktree entry does
  NOT move the file" is contradicted by one direct observation — session
  5a57a968 entered a worktree and its whole transcript (spanning an hour
  before the entry) moved to the worktree well, leaving nothing behind in
  the parent. One session, one harness version; not yet re-derived. Code
  that resolves a session to a file must try BOTH wells (`verifyModels` in
  `agents.ts` does).
- Wells outlive their dirs (worktree deletion loses no transcripts), and
  "gone by id ≠ gone by content" (respawns/resume-forks re-id sessions;
  measure loss by content lineage). Per-spawn subagent transcripts persist
  under `<session>/subagents/` — agentType, per-request model and usage.
  Workflow runs persist their full script (meta: name/phases) at
  `<session>/workflows/wf_*.json`, agents under `subagents/workflows/wf_*/`;
  `lore workflows` is the per-run observatory, `spawns --workflow` the
  drill-down.
- Wiki durability is CLI-owned: **every wiki op ends with
  `lore wiki commit`** (hooks don't travel across drivers).

## References

- `docs/DESIGN.md` — design narrative, decision log (graduation protocol,
  ownership model, stack), rejected alternatives.
- Wiki maintainer schema: `~/code/personal/lore-wiki/CLAUDE.md`.
- Prior art: `~/code/fun/disk` (SQLite streaming/FSEvents craft — style
  reference only, not a base); wevm/incur (agent-first CLI conventions);
  Karpathy's llm-wiki (`docs/references/llm-wiki.md`).
- The user operates suggest-first — challenge premises, propose alternatives.
