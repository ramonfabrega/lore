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
the template for fleet-wide canon. Fan-out rule learned the hard way: subagents
MUST get an explicit model (sonnet); omission inherits the main loop's Fable.

Pattern pages 2+3 done (oklch-token-ssot, expo-swiftui-sheet-kit — species
conventions stabilized: elements/sub-shapes/provenance-lineage/gotcha-ledger/
split-verdicts). Miner subagents defined in `.claude/agents/` (lore-miner,
lore-canon-auditor — model: sonnet pinned; the 821k-Fable golf-sim run is the
quality baseline to judge them against).

**Next: `lore docs`** — canon corpus scan/index, with the gym requirement:
canon can live only in git objects (husk checkouts), so the scanner must read
via git, not walk working trees. Then: sonnet-miner calibration ingest (any
mid-size well) scored against the Fable baseline.

Still open (arrive from data, not guesses):
- Graduation UX (landing on a non-master branch in the target repo is the leading
  shape; prototype it).
- `lore docs` — canon corpus scan/index (third corpus, decided but unbuilt).
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
