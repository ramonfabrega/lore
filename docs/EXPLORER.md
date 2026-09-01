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

## Annotation: deterministic first

Per transaction, computed from the instructions: the tool sequence as one
trace line; files touched (Edit/Write/Read inputs); commands run; tests run
with pass/fail parsed from output; commits (SHAs in Bash output); error and
interrupt counts; retries of the same command. These are the "went well /
went badly" proxies. Judgment summaries come from the wiki when an ingest
exists — link them, never recompute.

## Sequence

1. v13 + `lore trace` (this branch).
2. `lore serve` skeleton: the five pages over existing verbs.
3. Annotations, then the agents page.
4. Native only if the web surface fails to earn itself.
