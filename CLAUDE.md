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
- Fan-out mining requires a structured run ledger (per agent: well, tokens, duration,
  pages touched, outcome) — it will be tuned live.

## Status (2026-07-17) & open unknowns

Done: JSONL spelunk (docs/notes/), interview pass, v0 CLI (archive/index/search/
stats/wells — all working, tests green, `lore-*` skills synced), first archive
(1.6GB → ~/.lore/archive), wiki bootstrapped at `~/code/personal/lore-wiki`
(its CLAUDE.md is the maintainer schema).

**Next: first ingest.** Small and by hand — one well → one project page in the
wiki (mux or disk are the richest), to calibrate conventions before any subagent
fan-out. Drive it with the lore CLI, log it in the wiki's log.md.

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
