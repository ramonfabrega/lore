# lore

Search, index, and compound everything Claude Code has ever written on your
machine.

```
$ lore search "sparkle notarization" --history
lore v0.1.0 b55 @ 31f477b
hits[3]{well,sessionId,lane,ts,snippet}:
  "-Users-you-code-fun-my-app",8f0c21d4,text,"2026-07-02","…hardened runtime blocks »sparkle notarization« unless the XPC services are…"
  ...

$ lore stats
totals:
  sessions: 608
  messages: 290487
  historyRows: 15846
lanes[6]{lane,n}:
  tool,201153
  event,48483
  text,31672
  prompt,5487
  ...
```

## Why

Claude Code records everything — and lets it rot. Three failure modes drove this
tool:

1. **Evaporation.** Default retention deletes transcripts after ~30 days. (Check
   `cleanupPeriodDays` in your settings; this repo's author lost everything older
   than a month before noticing.)
2. **Path-sharding.** Memory and transcripts are keyed by directory: `~/code`,
   each repo, and each git worktree get separate, mutually blind stores. What a
   session learns in one place is invisible everywhere else.
3. **No compounding.** Insights, corrections, and decisions sit inert in JSONL.
   Nothing accumulates; every session re-learns.

lore archives the raw data (additive mirror — deletions upstream never propagate),
indexes it (SQLite FTS5), and gives sessions a query surface over their own
history. Above the CLI sits an optional judgment layer: interactive Claude
sessions maintaining a private wiki from the mined material and promoting matured
knowledge into git-committed docs. The CLI is deterministic and model-free; the
judgment layer is protocols, not code (see Architecture).

## What Claude Code leaves on your disk

A **well** is one directory's store under `~/.claude/projects/` — the dir name is
your absolute path with every non-alphanumeric character flattened to `-`
(`-Users-you-code-my-app`; lossy, and it bites). Inside: one `<uuid>.jsonl` per
session — an **event log, not a chat log**. In a measured busy session, ~3–4% of
lines are conversational signal; the rest is tool traffic, thinking envelopes
(persisted *empty* — signature only), and harness events. Sibling dirs carry
per-spawn subagent transcripts (`<session>/subagents/`, with per-request model and
usage) and full Workflow scripts (`<session>/workflows/wf_*.json`). Separately,
`~/.claude/history.jsonl` holds every prompt you ever typed — it survives the
retention purge that eats transcripts.

The full census, with numbers: [`docs/notes/2026-07-17-jsonl-spelunk.md`](docs/notes/2026-07-17-jsonl-spelunk.md).

## Install

Requires [Bun](https://bun.sh) and `rsync` (the archive step shells out to it;
macOS's openrsync and GNU rsync both work).

```sh
git clone https://github.com/ramonfabrega/lore && cd lore
bun install
scripts/install.ts     # builds the frozen `lore` bin -> ~/.bun/bin/lore (gates on tests)
```

`scripts/install.ts` refuses a dirty tree: the installed bin is a reproducible
artifact from a landed commit, and every invocation self-identifies on stderr
(`lore v0.1.0 b55 @ <sha>`) so transcripts record which build did the work.
During development, run `bun src/main.ts` from the checkout instead — deliberately
never linked as `lore` (a live link silently runs stale/uncommitted state).

## Quickstart

Two stops. The first is the dashboard over everything Claude Code has written on
your machine; the second is optional and only matters once you want a session
to *keep* what it learns.

```sh
# 1. the archive, the index, the explorer — five minutes, nothing leaves the machine
lore archive        # job zero: additive mirror of ~/.claude -> ~/.lore/archive
lore index          # build the FTS5 index (~4s full, sub-second incremental)
lore serve          # prints its URL (port 4949; --host 127.0.0.1 to keep it local; `lore server up` = always-on, macOS)
lore search "that thing we fixed in march"
lore usage --by week

# 2. later, when the dashboard has earned it: sessions that compound
lore skills add     # every verb as a skill — your Claude Code sessions discover the CLI
lore wiki init      # once: an empty wiki repo at LORE_WIKI_DIR from the built-in template
claude              # first prompt: "what's in my wells, and which should we ingest first?"
```

Stop 1 needs no wiki and no configuration. Stop 2 is described in
[Using it from a Claude Code session](#using-it-from-a-claude-code-session).

## The explorer

`lore serve` (foreground) or `lore server up` (always-on, launchd) renders the
index as pages — the same joins the CLI answers, no client framework, no build
step:

- `/` — recent sessions and wells, the live agent roster, spend this week,
  14-day sparklines.
- `/usage` — the token profile in the four billed classes (input, cache write,
  cache read, output) plus thinking, by day/week/month over any window, with a
  dated list-price equivalent (`listUsd` — an exchange rate, not a bill: the
  tool assumes a subscription, and Fable 5.1 repriced cache reads mid-corpus,
  so rates are per model *and* date).
- `/well/<dir>` — one directory's arc spine: every session in order, what
  served it (the model chip), fees.
- `/session/<id>` — one session opened like a block: each prompt is a
  transaction, each API request a step with its fee, each tool call an
  instruction with latency and error flag, plus annotations read off the
  record (files touched, tests and their verdicts, commits, retries) and the
  session's own fan-out ledger.
- `/search` — FTS5, sessions-first, hits linking to their transaction.
- `/s/<Claude-Session trailer>` — resolves the trailer Claude Code writes into
  commit messages to the transcript behind it.

Every page answers JSON on `?json=1`, and the read verbs are mounted under
`/cli/` (`GET /cli/usage?by=week`, spec at `/cli/openapi.json`) — writers are
never exposed over HTTP. `lore api <page>` is the same handler as a command, for
agents. `--host auto` binds your Tailscale address when there is one (reachable
from your other devices, never the LAN), `0.0.0.0` otherwise; pass `--host
127.0.0.1` to keep it local.

## Commands

| Command | What it does |
|---|---|
| `lore archive` | Additive mirror of `~/.claude` data → `~/.lore/archive`. Deleted sources stay preserved. |
| `lore index` | Scan wells → parse JSONL → FTS5 index + spawns/workflows lanes. Incremental by mtime/size. |
| `lore wells` | List wells: real path (de-slugged when needed), worktree/memory flags, sizes. |
| `lore sessions` | A well's chronological arc spine; `--since` for delta windows, `--exact` for prefix wells. |
| `lore session <id-prefix>` | Dump one session's messages in order, by lane. |
| `lore search <query>` | FTS5 across lanes; `--history` includes the prompt spine. Hyphenated terms fall back to literal match. |
| `lore spawns` | The subagent observatory: **verified** per-spawn model vs requested (drift flag), boot cost, partial-telemetry honesty. |
| `lore workflows` | One row per Workflow orchestration run: script meta, agents, tokens, model mix. Drill down: `spawns --workflow <id>`. |
| `lore tools` | Invocation counts per tool/skill/command — evidence for what ambient config actually earns its context cost. |
| `lore usage` | The token profile: four billed classes + thinking, by well/session/model/day/week/month, dated list-price equivalent. |
| `lore trace <id-prefix>` | One session as a block: transactions → steps (fee) + instructions (tool, latency, error) + annotations. `--steps` expands requests. |
| `lore agents` | The live roster (`claude agents` + background-job state) joined to the index: live tokens beside indexed requests. |
| `lore serve` / `lore api` | The explorer in the foreground / its pages as JSON commands. |
| `lore server up\|down\|restart\|status\|logs` | The explorer always-on as a launchd user agent (macOS); `status` says "restart owed" after a reinstall. |
| `lore docs index / search / list` | The canon corpus: git-committed .md across your repos, read from **git objects, never working trees**. |
| `lore stats` | Corpus totals, lanes, date range — with `warnings[]` when a corpus reads empty. |
| `lore wiki init [dir]` | Create a wiki from the built-in template (schema, index, log) with its first commit. Once. |
| `lore wiki commit` | Commit pending wiki changes (the judgment layer's durability op). |
| `lore skills add` | Generate + install per-command skills (via incur) so Claude Code sessions discover the CLI. |

Every command supports `--help`.

## Using it from a Claude Code session

The CLI is the eyes; a Claude Code session is the brain. The intended loop:

```sh
lore skills add                 # per-command skills → your session discovers every verb
lore wiki init                  # once: a wiki repo at LORE_WIKI_DIR from the built-in template
claude                          # anywhere — the skills travel with you
```

Then, in the session:

- *"what's in my wells, and which should we ingest first?"* → `lore wells`,
  `lore sessions --well <x>`, a proposal sized by lines and dates; you pick.
- *"what did we decide about X"* → it runs `lore search`, opens the hit with
  `lore session <id>` or `lore trace <id>`, answers with citations.
- *"what did last week cost, and which sessions"* → `lore usage --by session`.
- *"ingest my `~/code/foo` well into the wiki"* → it lists the sessions
  (`lore sessions --well foo --since <date>`), fans out one miner subagent per
  ~5–7 sessions plus a canon auditor over the repo (definitions in
  [`.claude/agents/`](.claude/agents/) — clone this repo or copy the two
  files into your own `.claude/agents/`), writes the project page, updates
  the index and log, and ends with `lore wiki commit`. The wiki's own
  `CLAUDE.md` — the maintainer schema `lore wiki init` lays down — is what
  tells the session how; read it once, edit it as your practice settles.
- *"is our CLAUDE.md stale"* → `lore docs search` against the indexed canon,
  compared with what the wiki says now.

The wiki is a plain git repo of markdown: `index.md` the map, `log.md` the
chronology, `projects/<name>.md` one page per project, `patterns/` for what
recurs across projects. It is meant to be private — it will hold whatever
your transcripts hold.

## Built for agents

The primary consumer is a Claude Code session, so the surface is
[incur](https://github.com/wevm/incur)-shaped: structured TOON/JSON output on
stdout (provenance on stderr keeps it parseable), an `--llms` manifest,
token-aware pagination (`--token-limit`/`--token-offset`), per-command generated
skills for discovery, and an MCP server via `--mcp` when embedding beats
shelling out. Humans get the same output; it reads fine.

Two design consequences worth naming: search queries never require FTS5 grammar
(raw query first, literal-phrase retry on parse error — operators work, hyphens
don't explode), and *nothing* derived from transcripts is ever evaluated as code
(workflow script metadata is extracted with a quote-aware brace matcher; a
transcript's "pure object literal" still never meets `new Function`).

## Architecture

Three tiers: **raw sources** (immutable transcripts + memories, archived) →
**wiki** (a separate private git repo of Claude-maintained markdown — the
compounding middle layer) → **canon** (git-committed docs in your repos). Three
corpora feed the index: transcripts, memories, and canon docs.

**What's code vs what's protocol**: this repo is layer 1 — the deterministic,
model-free CLI. The operations that make knowledge compound (**ingest** raw →
wiki, **graduate** wiki → canon via human-approved PRs, **lint** for stale/
drifted canon) are protocols an interactive Claude session performs *by driving
the CLI* — documented in [`docs/DESIGN.md`](docs/DESIGN.md), not shipped as
commands. The session is the brain; the CLI is the eyes. That inversion is also
the billing model: judgment work runs inside a Claude subscription session, so
the tool itself never needs an API key.

## What it reads and writes

- **Reads**: `~/.claude` (transcripts, memory, history), and — only for
  `lore docs` — the git object stores of repos under your code root.
- **Writes**: `~/.lore` (the archive and the rebuildable `lore.db`), your
  wiki repo if you configure one, and — only for `lore server up` — one plist
  under `~/Library/LaunchAgents/`. Nothing else.
- **Network**: none, except `git fetch` when you explicitly pass `--fetch` to
  `lore docs index`, and the port `lore serve` listens on (default 4949; see
  `--host`). Nothing is uploaded anywhere. No model calls, no API key.
- **Shells out to**: `rsync` (archive), `git` (docs, wiki), `claude` (the
  agents roster — skipped when it's not on `PATH`), `tailscale` (host
  resolution — optional).

The index is a derived artifact: it rebuilds from the archive, version-bumps
instead of migrating, and refuses to touch a database written by a *newer* lore
(stale builds fail loudly rather than destroying a good index).

## Configuration

All env vars, validated in one place (`src/config.ts`):

| Var | Default | Purpose |
|---|---|---|
| `LORE_CLAUDE_DIR` | `~/.claude` | Claude Code's data dir. |
| `LORE_HOME` | `~/.lore` | Archive + `lore.db`. |
| `LORE_CODE_DIR` | `~/code` | Root scanned by `lore docs`. **Set this if your repos live elsewhere.** |
| `LORE_WIKI_DIR` | `~/code/personal/lore-wiki` | The wiki repo for `lore wiki commit`. Optional. |
| `LORE_DOCS_EXCLUDE` | — | Comma-separated `/`-bounded path suffixes to skip in the docs scan. |
| `LORE_DOCS_ASSISTED` | — | Force-flag repos as assisted (someone else's project) when auto-detection misses. |

## Status & non-goals

v0, a personal tool published as-is: local only, no telemetry, no accounts, and
no plan to become a product. The explorer is server-rendered HTML over the same
verbs — there is no client framework to keep alive. Design history — including the decisions that went wrong
first (the schema-guard incident, the 40%-of-telemetry-was-a-floor audit) — is
the readable part: [`docs/DESIGN.md`](docs/DESIGN.md). `CLAUDE.md` is the
in-repo instruction file for the author's own Claude sessions; it documents how
the tool governs the sessions that use it, and reads accordingly.

## License

[MIT](LICENSE)
