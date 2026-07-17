# lore

Claude Code memory/conversation explorer and knowledge compounder. Scans the wells in
`~/.claude/projects` (transcript JSONL + per-project memory dirs), archives and indexes
them, maintains an LLM-written wiki, and promotes matured knowledge into canon
(git-committed CLAUDE.mds and docs).

## Thesis

Claude Code memory is **path-sharded** — one well per directory (`~/code`, each repo,
each worktree), all mutually blind — while knowledge is repo- or workspace-scoped.
Conversations and memories never compound. lore bridges wells (sync), accumulates
knowledge (wiki), and graduates it (canon).

## Architecture — three tiers, three ops

Tiers: **raw sources** (immutable transcripts + memories) → **wiki** (lore-maintained
markdown; the compounding middle layer) → **canon** (git-committed docs).

Three corpora feed layer 1: **transcripts** (JSONL wells), **memories** (per-well
memory dirs), and **canon docs** (the .md files already committed across repos —
the internalized doctrine; indexing it powers lint, the map, and graduation dedup).

Ops: **ingest** (raw → wiki), **graduate** (wiki → canon; human-approved; leaves a
tombstone/backlink in the wiki so facts aren't re-learned), **lint** (flag stale canon
and cross-app pattern drift against the wiki).

## Two layers

1. **Deterministic CLI** — scan, parse, archive, index (SQLite FTS5), search, stats,
   run ledger. Zero model dependency; independently testable. Agent-first CLI design
   (see wevm/incur for the conventions: schema'd output, token-aware pagination,
   discovery, next-step hints).
2. **Judgment** — a `/lore` skill; interactive Claude Code sessions drive the CLI
   (the session is the brain, the CLI is the eyes). The skill's one-line listing is
   the only ambient context footprint — no root `~/code/CLAUDE.md` map (rejected:
   ambient context must earn its per-session cost; the map is pull-based).

## Code conventions (decided 2026-07-17, rationale in DESIGN.md)

- **Bun-first**: Bun API when one exists (`Bun.file`, `Bun.write`, `Bun.$`,
  `bun:sqlite`, `bun:test`); `node:fs`/`node:path`/`node:os` for the gaps
  (sync dir ops, `join`, `homedir`) — that's idiomatic Bun, not a compromise.
- **Boundary parsing, no casts**: DB rows, env, and JSONL get zod-parsed at the
  edge; schemas colocated with the queries that produce them. Never `as X` on I/O.
  Env is one validated object in `config.ts`.
- **No ORM** over lore.db — it's a derived artifact (rebuild beats migrate) and
  the load-bearing queries are FTS5. Revisit at run-ledger-era schema complexity.

## Hard constraints

- **Subscription OAuth only.** Never an API key; never design around API billing.
  In-session subagent fan-out is the sanctioned parallel lane; `claude -p` is an
  escape hatch only (`--bare` skips OAuth and may become the `-p` default — another
  reason the inverted architecture is primary).
- Layer 1 stays model-free.
- Graduation writes git-committed files → always human-approved, and loud about
  *which repo* a fact lands in (work vs personal must never cross).

## Wiki page species

Project pages; **pattern pages** (cross-app registry with provenance + quality
verdicts — "canonical impl lives in X; Y's copy is stale; style-reference-only");
the map (`index.md`); `log.md`. Pattern pages are how apps piggyback/upstream code
without premature shared packages — extraction is earned when a page shows several
stable consumers.

## Data-model notes (landed July 2026 — see docs/DESIGN.md for rationale)

- Wells are continuous work streams: the user `/clear`s long-lived sessions (two
  species: arc-spanning with a transient plan.md deleted on land; task-boundary).
  Group by well + time, **infer arcs from artifacts** — plan-file lifecycles are fully
  recoverable from transcript Writes. Learn the user's clear semantics; never impose
  conventions without evidence from the data.
- Worktree wells are durable perma-worktree agent homes, not spikes; syncing their
  knowledge to the parent repo well is an ongoing op.
- Retention: `cleanupPeriodDays: 3650` set 2026-07-17; transcripts before ~2026-06-12
  were already lost to the old ~30-day default. Archiving is job zero.
- Recording channels split by dir (first ingest 2026-07-17; mechanism pinned in the
  gym cross-check same day): `history.jsonl` records the terminal's launch dir;
  the transcript shards by **cwd at session creation** (a `/clear` re-shards,
  mid-session worktree entry does NOT move the file); memory shards to the launch
  dir — one project, multiple wells. Well membership ≠ work location: the ground
  truth for where work happened is per-message `cwd`/`gitBranch` in the transcript.
  Worktree deletion loses no transcripts (wells outlive their dirs). And "gone by id ≠ gone by content": job respawns and resume-forks
  re-id sessions (`~/.claude/jobs/*/state.json` maps job → transcript via
  `linkScanPath`; forked copies share message uuids), so measure loss by content
  lineage, not missing session ids.
- Fan-out mining requires a structured run ledger (per agent: well, tokens, duration,
  pages touched, outcome) — it will be tuned live.

## Status (2026-07-17) & open unknowns

Done: JSONL spelunk (docs/notes/), interview pass, v0 CLI (archive/index/search/
stats/wells/sessions/session/wiki-commit — all working, tests green, `lore-*` skills
synced), first archive (1.6GB → ~/.lore/archive), wiki bootstrapped at
`~/code/personal/lore-wiki` (its CLAUDE.md is the maintainer schema), **first
ingest** (disk → projects/disk.md, hand-written calibration run; six pattern
candidates flagged, process findings in the wiki's log.md), **first pattern page**
(patterns/sqlite-streaming-scan-index.md — sub-shapes convention born there),
**second ingest** (gym → projects/gym.md, the nascent-well calibration: for young
wells ingest ≈ indexing the memory; husk-checkout + sharding findings above).
`lore session <id>` (transcript slice, prefix-matched) was earned by both ingests
needing raw sqlite3 for it twice. Schema v2 indexes per-message cwd (openDb
drops+rebuilds on version mismatch — rebuild beats migrate, mechanized):
`sessions` lists workDir (modal cwd) + workDirs, `session` returns the full cwd
histogram, and skill expansions / interruption markers route to the meta lane.

Wiki durability is CLI-owned (`lore wiki commit`, the passage model): every wiki
op ends with it. Harness auto-commit hooks were tried and rejected same day —
they don't travel to `claude -p` or other drivers. Note: "mux" = `~/code/fun/tv`
(Mux.xcodeproj); no well carries the name.

**Third ingest done: golf-sim** (35 sessions via 7-agent fan-out; run ledger v0
in the wiki log — Agent-tool completion notifications carry per-agent tokens/
duration for free). Headline: golf-sim's CLAUDE.md contains a hand-built
graduation system (sort-before-you-write + closeout landing flow) — proto-lore,
the template for fleet-wide canon. Fan-out model rule learned the hard way
(accidental Fable swarms are recurring): defined agents (`.claude/agents/*.md`)
carry a `model: sonnet` pin in frontmatter — spawn by agentType with NO
per-call model override (no special-casing; rely on the official feature) and
VERIFY the model from the completion notification; a pin that doesn't hold is
a finding to surface, not to hack around. Ad-hoc spawns of generic agent types
MUST pass an explicit model; omission inherits the main loop's Fable.

Pattern pages 2+3 done (oklch-token-ssot, expo-swiftui-sheet-kit — species
conventions stabilized: elements/sub-shapes/provenance-lineage/gotcha-ledger/
split-verdicts). Miner subagents defined in `.claude/agents/` (lore-miner,
lore-canon-auditor — model: sonnet pinned; the 821k-Fable golf-sim run is the
quality baseline to judge them against).

**`lore docs` done** — canon corpus scan/index (schema v3: repos/docs/docs_fts).
Reads via git objects only (`ls-tree`/`cat-file`), never working trees — the gym
requirement. Ref = newest commit among HEAD and origin's default branch; husk
flag = local HEAD has zero canon while the chosen remote ref has some. Repos
gone from disk are pruned (canon lives in git; no evaporation to guard).
`lore docs index|search|list`; wiki dir excluded (middle tier ≠ canon). First
real run: 30 repos, 490 docs; gym + personal/site + work/acarreo flagged husk.

**Ownership** (auto-detected per repo, rides on every search hit): `foreign` =
has an `upstream` remote (fork-for-upstreaming — sandbox/expo; docs not
indexed); `assisted` = zero commits under the user's repo-local identity
(bodas-app — helped a junior dev on someone else's project); else `mine`.
The zero/nonzero line is the fleet's real boundary — cuanto is 34/5157 under
the personal email yet mine (user commits there); a share threshold would
misclassify it. **Redline (extends the privacy redline): assisted canon is
context only — it must NEVER feed pattern-page provenance, count as the user's
prior art in graduation dedup, or read as authored by the user. The user's
transcripts in an assisted repo's well remain theirs and stay minable.**
Overrides: `LORE_DOCS_EXCLUDE` skips repos entirely, `LORE_DOCS_ASSISTED`
force-flags (both comma-separated `/`-bounded path suffixes).

**Fourth ingest done: tv/multicaster — the sonnet-miner calibration. PASS.**
(projects/mux.md; full ledger + verdict in wiki log.md). 3 sonnet miners,
gate-then-batch per the ratified protocol; ~453k tokens total vs golf-sim's
821k Fable. Rubric 8/8 all miners, 5/5 spot-checks verified verbatim (session
AND branch matches), cross-validation across buckets held. Sonnet miners are
approved for fleet mining. BUT the defined-agent lane failed to resolve:
spawning by agentType `lore-miner` was rejected — the background-job session
never registered `.claude/agents/*.md` (defs present in worktree AND main
checkout). Fallback was the sanctioned ad-hoc lane (general-purpose +
explicit sonnet). Consequences: (1) the frontmatter model-pin remains
UNVERIFIED — retest from an interactive session; (2) completion notifications
carry no model field, so ledger model columns are spawn-parameter assertions,
not verification (golf-sim's "fable (!)" was inference). Also shaken out:
`database is locked` transient under parallel miners (add WAL/busy_timeout
to openDb) and text-lane truncation mid-message (--token-limit should cut at
message boundaries). Headline: 820b6f21 carries the verbatim origin quote of
the subagent policy ("i just dont want fable subagents ever at least in this
flow"). Queued follow-ups: canon-audit of ~/code/fun/tv (deliberately not run
— calibration scoped to miners), sibling-well sync (4 unmined tv wells).

Still open (arrive from data, not guesses):
- Graduation UX (landing on a non-master branch in the target repo is the leading
  shape; prototype it).
- One vs two pipelines for memories vs transcripts; dedup across a repo's
  main + worktree wells; run-ledger implementation for fan-out mining.
- The user operates suggest-first — challenge premises, propose alternatives.

## References

- `docs/DESIGN.md` — design narrative, decision log, rejected alternatives.
- `docs/references/llm-wiki.md` — Karpathy's LLM-wiki pattern, adopted as the middle tier.
- Prior art: `~/code/fun/disk` — SQLite streaming-writer craft (`ScanStore.swift`),
  FSEvents refresh (`Refresh.swift`/`Live.swift`), token query grammar (`Query.swift`),
  and the scanner-spike worktree's `IndexCatalog.swift` + tests. Style/technique
  reference only — disk's engine has no FTS and is tree-specialized; it is not a base.
- wevm/incur — agent-first CLI conventions.

Design origin: conceived conversationally 2026-07-16/17 in a session booted from
`~/code`; those transcripts and memories live in the `~/code` well, which sessions
booted here cannot see — the path-sharding thesis, self-demonstrated.
