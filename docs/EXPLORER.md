# The explorer

A session opened like a block: the conversation decomposed into
transactions, instructions, and fees, from the transcript alone — zero
inference. The human surface is a self-hosted web page (`lore serve`); the
agent surface is the same routes as CLI commands (incur's `fetch` mount).
One definition, two surfaces. Design note, 2026-09-01; decisions in
DESIGN.md's log.

## The model, and where each field lives in the JSONL

| explorer | transcript | since |
|---|---|---|
| **transaction** — one user prompt and everything until the next | `promptId` on every `user` record (prompts AND tool results); `assistant` records carry none and inherit the last one seen in file order | 2026-06 (all sampled files) |
| **step** — one API request | `assistant` record, `message.id` (streaming snapshots share it; dedupe = max per field), `message.usage`, `message.model`, top-level `effort` | always |
| **fee** — the step's four token classes + thinking, priced by dated list rate | `requests` table (v12) | v12 |
| **instruction** — one tool call | `tool_use` block: `id`, `name`, `input` | always |
| **instruction log** — its result | `user` record with a `tool_result` block: `tool_use_id`, `is_error`, `content`; record-level `sourceToolAssistantUUID` (the issuing assistant record) and `toolUseResult` (structured: Bash → stdout/stderr/interrupted) | 2026-06 |
| **latency** | `timestamp(tool_result) − timestamp(tool_use)` | always |
| **inner program** — a spawn | `spawns` table (v6), keyed by session | v6 |
| **job** — one background job across every `/clear` | record-level `session_id` (≠ `sessionId`, the transcript's own id); the daemon roster's `sessionId` matches it | 2026-08 (bg sessions only) |
| **links** — PRs, artifacts | `pr-link` records; the job's `state.json` children | varies |

Not in the transcript: the claude.ai session id the commit trailer carries
(`Claude-Session: …/session_…`). Nothing local maps it to a transcript UUID
yet; until it does, "open the session from the commit" is a search, not a link.

## Layer 1 (v13)

- `messages` gains `prompt_id`, `tool_use_id`, `is_error`, `request_id`
  (assistant rows: `message.id`, the join to `requests`).
- `sessions` gains `job_session_id`.
- `lore trace <id>`: the transaction list — per prompt: the prompt head,
  steps, fee (tokens + listUsd), instructions with name / input head /
  latency / error, the assistant's text head, wall time. Totals on top.
  Agent-first: TOON/JSON like every other verb; the page renders the same.

## The pages (`lore serve`)

Server-rendered HTML, no build step, no client framework; inline SVG for
sparklines (the dataviz skill's palette). Hono via incur's `fetch` mount, so
`lore api …` and `lore serve` are the same routes. Binds `0.0.0.0` so the
tailnet reaches it as `studio:<port>/…` (incur mounts the handler; listening
is `Bun.serve` — the bind address is ours to get right).

- `/` — wells with usage sparklines (week), spend by model.
- `/well/:dir` — sessions, oldest-first, with fee, requests, tools, duration;
  the `sessions` verb plus `usage --by session`.
- `/session/:id` — the block: header (well, branch, job, first/last, fee,
  spawns, links), then transactions, each expandable to steps and
  instructions; instruction logs collapsed by default; thinking collapsed.
- `/usage` — the profile: by week/day, by model, by well; the same numbers
  `lore usage` prints.
- `/agents` — the live roster from `claude agents --json --all` and each
  job's `state.json` (state, detail, live tokens); attach is a command to
  copy, never an embedded terminal. The agents-view replacement is a page.

### Three surfaces, one definition

- **pages** — `lore serve`, the routes above; `?json=1` for the data.
- **`lore api …`** — the pages as CLI commands via incur's `fetch` mount
  (JSON forced): `lore api session <id>`.
- **`/cli/…`** — the CLI as HTTP, incur's `Bun.serve(cli)` shape, mounted
  under a prefix because the pages own the root and `/usage`, `/session`
  collide with verb names: `GET /cli/usage?by=week`, `GET /cli/trace/<id>`,
  spec at `/cli/openapi.json`. **GET-only, read verbs only** — archive,
  index, docs index, wiki commit, serve, server are never routes. Numeric
  options are `z.coerce.number()` so query strings validate.

### Always on

`lore server up|down|restart|status|logs` — a launchd user agent
(`~/Library/LaunchAgents/com.ramonfabrega.lore.plist`, KeepAlive, throttle
10s, logs under `~/.lore/`), the fleet's precedent for long-lived local
services. Bind address resolved once at `up`: the Tailscale IP, so
`http://studio:4949/` works over the tailnet without binding the LAN.
`status` compares the running build (`/_lore`) with the installed bin —
the prod bin is a frozen bundle, so after `scripts/install` the server
still runs the old one until `restart`. KeepAlive respawns a port race
forever, so `status` and `logs` are the diagnosis, not the pid.

## Annotation: deterministic first (landed)

Per transaction, from the instructions and their logs: files touched
(Edit/Write/Read/MultiEdit/NotebookEdit inputs), commands run, tests run
with the verdict read from the result's TAIL (tool results index head 1200
+ tail 800 for exactly this — the verdict of a run sits at the end),
commits from git's own `[branch sha]` line (a `-q` commit or a commit made
by a script prints none — an empty list is honest, not a miss), retries as
a Bash command repeated verbatim. These are the "went well / went badly"
proxies. Judgment summaries come from the wiki when an ingest exists — the
well page points at `projects/<repo>.md` when it exists, never recomputes.

## Search (landed)

Sessions first: FTS5 hits grouped by session, ranked by best hit (bm25),
then hit count, then recency — deterministic and sayable. The last bare
token becomes a prefix (`notar` → `notar*`) so a half-typed word already
lands; FTS5 syntax passes through. Lanes: conversation (prompt + text) by
default, tools or everything on request. A hit links to its transaction
(`/session/<id>#tx-<promptId>`). Speed is FTS5's (2–12 ms on 300k rows);
no client code, no reimplemented ranking. `lore search` is the CLI twin.

## Agents (landed)

The daemon's listing (`claude agents --json --all`, ~140 ms) + each job's
`state.json` (state, detail, tempo, LIVE tokens, links, worktree branch)
joined to the index (well, requests, list $, last indexed activity — as of
the last `lore index`). Active first. Attach is a command to copy.
`lore agents` is the CLI twin; `/cli/agents` the route.

## Job (landed)

`/job/<job_session_id>`: every transcript one background job produced
across its `/clear`s, with fees — the conversation as the user lived it,
which is never one transcript.

## Sequence

1. v13 + `lore trace` — landed.
2. `lore serve` skeleton — landed; `/cli/` + `lore server` — landed.
3. Recent, search, annotations, agents, job — landed.
4. A design pass, once the pages have earned it (the block view first).
5. Native only if the web surface fails to earn itself.
