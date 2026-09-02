# wiki

The compounding middle tier of lore: a wiki written and maintained by Claude,
compiled from Claude Code transcripts, memories, and canon docs. Humans read it;
Claude writes it. This file is the **schema** (Karpathy's term): the conventions
that make a session a disciplined wiki maintainer. Edit it as your practice
settles — it is yours now, not lore's.

## Position in the pipeline

raw sources (`~/.claude/projects`, `~/.lore/archive`, canon .md files across
your repos) → **this wiki** → canon (git-committed CLAUDE.mds/docs, promoted
via graduation).

The lore CLI is the eyes: `lore search`, `lore sessions`, `lore session`,
`lore trace`, `lore usage`, `lore spawns` (see the `lore-*` skills, installed
by `lore skills add`). Never mine raw JSONL by hand when the index can answer.

## Layout

- `index.md` — the map: every page, one line each, grouped by species. Update
  on every ingest. Read it first when answering questions.
- `log.md` — append-only chronology: `## [YYYY-MM-DD] <op> | <subject>`
  entries for every ingest/query/lint/graduation. Greppable.
- `projects/<name>.md` — one page per project: what it is, current state,
  decisions, gotchas, links to pattern pages.
- `patterns/<name>.md` — cross-project pattern registry: provenance + quality
  verdict. Required header fields: `canonical:` (repo + file of the best
  implementation), `consumers:`, `verdict:` (copy-this | style-reference-only
  | do-not-inherit). Drift between consumers is a lint finding. 3+ stable
  consumers = package-extraction candidate; surface it, the human decides.
- `arcs/<name>.md` — reconstructed work arcs worth remembering (optional,
  earned).

## Page conventions

- Frontmatter: `title`, `updated` (YYYY-MM-DD), `sources` (well/session ids or
  repo paths), `status: growing | mature | graduated`.
- Interlink with `[[page-name]]`. Orphan pages are lint findings.
- On graduation: set `status: graduated`, add `graduated_to: <repo>:<file>`
  and keep a one-line tombstone so the fact isn't re-learned; the full content
  moves to canon.
- Answers to good questions get filed as pages too — explorations compound.

## Durability

The passage model: a wiki mutation is not durable until committed, and the
commit is the **tool's** job, not the harness's (hooks don't travel to
`claude -p` or other drivers). **End every wiki op with
`lore wiki commit -m "<op>: <subject>"`.** It stages and commits everything
pending; a clean tree is a no-op. Milestone ops get a real message; if you
forget, the next commit sweeps stragglers in.

## Operations

- **ingest** — mine sources into page updates. One source may touch many
  pages. Always update `index.md` and append to `log.md`. Batch ingest =
  subagent fan-out with a run ledger (per agent: scope, tokens, tools,
  duration, the model that actually served it — read it from the spawn's
  transcript or `lore spawns`, never from the spawn parameter); never
  silent-cap coverage. Size the bucket from `lore sessions --since <date>`;
  one miner per ~5–7 sessions, one canon auditor per repo.
- **query** — read `index.md` → drill into pages → answer with citations (page
  links + source ids). File durable answers back as pages.
- **lint** — hunt: contradictions between pages, wiki claims contradicted by
  newer sessions, stale canon (README, CLAUDE.md) vs wiki state, pattern drift
  between consumers, orphans, missing pages.
- **graduate** — promote mature claims to canon via a PR on the target repo,
  always human-approved. Two output shapes: **facts graduate as PRs** (the
  session writes the doc change); **work graduates as issues** (when the
  finding means the target repo should *do* something). Be loud about the
  destination repo — knowledge from one client's or employer's repos must
  never land in another's, and never in a public repo. Mechanics: a temp
  worktree of the target repo cut from the ref where the amended canon lives
  (discover the default branch per repo, don't assume); one fact = one commit
  = one PR; before presenting for merge, run a reviewer briefed as the target
  repo's maintainer, given ONLY the target ref's docs — contradicts canon?
  duplicates? right doc? voice match? The repo wins on contradiction; file a
  lint finding instead of forcing. After merge, sync the local checkout of the
  target (fetch, then fast-forward only if it is on the base branch and
  clean; otherwise say so), tombstone the wiki side, and thin any source
  memory file to a pointer — mine first, then dissolve.

## Privacy

If this wiki mixes work and personal knowledge it stays private and local (a
remote is optional, your call). The privacy gate is at graduation, not at the
wiki wall.
