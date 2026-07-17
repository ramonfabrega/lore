# lore — design narrative & decision log

Seeded 2026-07-17 from the founding design conversation (session booted at `~/code`;
its transcripts and memories live in the `~/code` well — unreachable from sessions
booted here, which is the problem lore exists to solve). This document records what
was *landed* and, just as deliberately, what was *left open*. Treat the open items as
first-principles territory: re-derive them against real data, don't inherit guesses.

## Problem

The user runs many long-lived Claude Code sessions across ~40 project wells
(`~/.claude/projects`, ~1.6GB of transcript JSONL as of July 2026, plus per-project
memory dirs). Three failure modes:

1. **Evaporation.** Default retention deleted transcripts after ~30 days (fixed
   2026-07-17: `cleanupPeriodDays: 3650`; everything before ~2026-06-12 is gone).
2. **Path-sharding.** Memory wells are keyed by directory. `~/code`, each repo, and
   each worktree have separate, mutually blind wells. Knowledge learned in one place
   is invisible everywhere else — the user rations memory in worktrees as a workaround.
3. **No compounding.** Insights, corrections, incantations, and decisions sit inert in
   transcripts. Nothing accumulates; every session re-learns.

## Shape

Three tiers (per Karpathy's LLM-wiki pattern — `references/llm-wiki.md`):

- **Raw sources**: transcripts + memory files. Immutable. Archived (job zero).
- **Wiki**: markdown maintained by Claude via lore. The compounding middle layer.
  Page species: project pages, pattern pages, the map (`index.md`), `log.md`.
- **Canon**: git-committed docs — per-repo CLAUDE.mds, `~/code/personal/site`,
  future project templates. lore never owns canon; it *notices* (lint).

Three operations:

- **ingest** — mine raw sources into wiki updates. Batch = subagent fan-out inside an
  interactive session (sub-billed). Requires a run ledger from day one.
- **graduate** — promote a matured wiki claim into canon. Human-approved always.
  Leaves a tombstone/backlink in the wiki so the fact isn't re-learned and re-saved.
- **lint** — health-check: canon claims contradicted by recent sessions, stale site
  listings, cross-app pattern drift, orphan wiki pages, missing links.

Two layers:

- **Layer 1 (CLI, model-free)**: scan wells → parse JSONL → archive → SQLite FTS5
  index → search/stats/digest commands. Agent-first output design (incur conventions).
  Fully testable without any model. Includes the run ledger.
- **Layer 2 (skill)**: `/lore` drives the CLI from any interactive session. The
  inverted relationship — session is the brain, CLI is the eyes — makes the
  subscription-only constraint structural rather than enforced.

## Decision log

| Date | Decision | Rationale / rejected alternatives |
|------|----------|-----------------------------------|
| 2026-07-16 | Name: **lore** | Fits `~/code/fun` naming (disk, deck, album, mux). Captures both halves: conversations are raw lore; graduation turns lore into canon. Rejected: memory/mem (generic, collides), recall (crowded), distill (crowded verb), dissolve (wrong direction). |
| 2026-07-16 | Two layers; layer 1 model-free | Scanning/indexing is not an AI problem; testable alone; the model should query a digested index, never raw JSONL. |
| 2026-07-16 | Inverted relationship: Claude Code drives the CLI | Sub-billing by construction; zero auth plumbing; human-in-loop for free. `claude -p` works on subscription OAuth today but `--bare` (API-key-only) may become its default — escape hatch, not foundation. |
| 2026-07-17 | Wiki as compounding middle tier | One-off extraction produces reports that vanish; wiki updates accumulate. Answers filed back into the wiki compound too. |
| 2026-07-17 | No Swift app in v1; no UI | The wiki is browsable in any editor/Obsidian; an explorer app comes later from usage, if ever. disk is style/technique reference only (no FTS; tree-specialized engine). |
| 2026-07-17 | No Apple Intelligence | Dead once Swift is out; judgment work needs Claude anyway. Revisit only under real token pressure. |
| 2026-07-17 | No root `~/code/CLAUDE.md` map | User rejected ambient cross-project context in every session. Map is pull-based via the wiki; the `/lore` skill's listing line is the free ambient pointer. |
| 2026-07-17 | Pattern pages instead of shared packages (for now) | Wiki carries provenance + quality verdicts ("copy this" vs "style reference only" vs "don't inherit"); upstreaming = lint noticing drift. Real package extraction is earned when a pattern page shows several stable consumers — lore surfaces the *when*, user keeps the *whether*. Shared Sparkle release infra (mux ↔ disk) already works as convention. |
| 2026-07-17 | Infer arcs, don't impose clear semantics | User's `/clear` has two species (arc-spanning with transient plan.md; task-boundary). Plan-file lifecycles are fully recoverable from transcript Writes, so arcs reconstruct for free. Propose conventions only with evidence ("arcs are 3× easier to reconstruct when X"). |
| 2026-07-17 | Worktree wells = durable satellites | User runs perma-worktrees per bg agent (main worktree reserved for the human). Well sync to parent repo is an ongoing op, not a rescue. |
| 2026-07-17 | Run ledger is layer-1 plumbing | Fan-out mining will be tuned live; per-agent well/tokens/duration/pages/outcome in structured form (JSONL) + readable summary. lore can later mine its own ledgers. |
| 2026-07-17 | Wiki home: separate local git repo | Private, git-based (the passage model: git as durability/diff engine, remote optional). Not inside the lore repo; not necessarily on GitHub. |
| 2026-07-17 | One wiki, work + personal together | Max cross-pollination; graduation stays loud about destination repo (the privacy redline moves to the graduation gate, not the wiki wall). |
| 2026-07-17 | Thinking blocks: indexed, own lane, excluded from default search | ~13% of records, reasoning gold + chaff; opt-in flag for rationale archaeology. |
| 2026-07-17 | Stack: Bun + TypeScript; **incur as core CLI infra** (user call) | bun:sqlite (FTS5), native test runner, streaming JSONL, user fluency, `bun build --compile` later. incur (wevm) is the CLI framework from day one — agent-first surface (schema'd I/O, token-aware output, discovery) is lore's primary interface, and wevm engineering is trusted. Karpathy's llm-wiki is the guidance counterpart (docs/references/llm-wiki.md). Rust port noted only as a someday-if-daily-driver idea. |
| 2026-07-17 | Graduation UX: OPEN | User: writing to a target repo's master is wrong; landing on a non-master branch they merge via normal flow is the leading shape. Needs more thinking — revisit with a working prototype. |
| 2026-07-17 | Third corpus: canon docs (.md files) | Raw sources aren't just transcripts + memories — the git-committed markdown across repos (CLAUDE.mds, docs/) is the "already internalized doctrine" and a first-class corpus. Indexing canon is what makes lint real (compare wiki against canon), deduplicates graduation ("does canon already say this?"), and feeds the map. Already parse-friendly. |
| 2026-07-17 | Thinking lane: structurally empty (corpus fact) | Thinking blocks persist as empty strings + signature only (0 non-empty / 6,335 sampled). Lane plumbing kept as future-proofing; rationale mining must use assistant text. |
| 2026-07-17 | Wiki durability is CLI-owned: `lore wiki commit` | The passage model — the mutation tool commits, not the harness. Harness auto-commit hooks (PostToolUse/Stop → autocommit.sh) were built, tested, and rejected same day: hooks are session-config-scoped and don't travel to `claude -p`, subagents in other cwds, or other drivers. Convention lives in the wiki's CLAUDE.md: every wiki op ends with `lore wiki commit`. |
| 2026-07-17 | No ORM over lore.db (revisit trigger named) | The queries that matter are FTS5 (`MATCH`/`snippet()`/`rank`) and analytical aggregates — exactly what ORMs handle worst (Drizzle has no first-class FTS5; you end up in `sql.raw`). lore.db is a **derived artifact** (rebuilds from archive in ~200ms), so migrations — the main ORM payoff — don't apply: version-bump + rebuild, the disk lesson. Coherence comes from zod-parsing rows at the boundary instead (schemas colocated with queries; no `as X` casts). Revisit when the run-ledger/lineage/docs-corpus era brings ~10 tables with relational writes, or the first join bug types would have caught. |
| 2026-07-17 | Code conventions: Bun-first + boundary parsing | Bun API when one exists (`Bun.file`, `Bun.write`, `Bun.$`, `bun:sqlite`, `bun:test`); `node:fs`/`node:path`/`node:os` for the gaps (sync dir ops, `join`, `homedir`) — that's idiomatic Bun, not a compromise. All I/O boundaries (DB rows, env, JSONL) are zod-parsed, never `as`-cast; env is one validated object in config.ts (incur's per-command `env:` is for command-specific vars; ours are cross-cutting path roots). |

## Privacy redline

Transcripts span work (cuanto, acarreo) and personal projects. Graduation must be
loud about the destination repo; a work detail must never land in a public/personal
canon file. Consider per-well sensitivity tags in the index from the start.

## Open questions (first-principles territory)

- Stack for the CLI. Deliberately undecided.
- What the JSONL actually contains edge-to-edge: sidechains, compaction summaries,
  `subagents/workflows/` transcript dirs, tool-result noise ratios. **Spelunk several
  real wells before designing the parser.** Compaction summaries may be pre-digested
  gold for ingest.
- One pipeline or two for memories vs transcripts (memories are already structured
  with frontmatter; transcripts are raw).
- Dedup/grouping across a repo's main well + its worktree wells.
- Graduation UX: what reviewing a wiki→canon diff should feel like.
- Whether/when the explorer UI materializes, and in what shape.

## First working session

1. JSONL spelunk: read 2–3 wells edge-to-edge (a busy repo well, a worktree well, the
   `~/code` well), catalog every record type and structure encountered.
2. Interview/blindspot pass with the user (suggest-first: challenge premises), armed
   with real examples from the spelunk.
3. Then, and only then, stack + parser design.
