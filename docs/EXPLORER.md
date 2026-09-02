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

The claude.ai session id the commit trailer carries (`Claude-Session:
…/session_X`) is in `~/.claude/jobs/<id>/state.json` as `bridgeSessionId:
cse_X` — same suffix — for **background jobs** (13 of 16 on 2026-09-01).
v14 indexes those files (`jobs`), so `/s/session_X` redirects to the
transcript and `lore trace session_X` works. Interactive sessions write no
such file; their trailers stay unresolved and the page says so.

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
tailnet reaches it as `<host>:<port>/…` (incur mounts the handler; listening
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
10s, logs under `~/.lore/`), the author's precedent for long-lived local
services. Bind address resolved once at `up`: the Tailscale IP, so
`http://<host>:4949/` works over the tailnet without binding the LAN.
`status` compares the running build (`/_lore`) with the installed bin —
the prod bin is a frozen bundle, so after `scripts/install.ts` the server
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

Each row names its **model** — see below; neither of the harness's two
files carries one, so a live agent's is read from its own transcript.

## Job (landed)

`/job/<job_session_id>`: every transcript one background job produced
across its `/clear`s, with fees — the conversation as the user lived it,
which is never one transcript.

## Freshness (landed)

The server refreshes the index itself (`serve --refresh <min>`, default 5;
0 = never): incremental, in-process, sub-second when nothing changed. The
nav says `indexed N min ago`; `/_lore` carries the timestamp and the last
error. Never `full` from the timer — a schema bump is a reinstall and a
restart. Ran alongside a CLI `lore index`, the shared db's busy_timeout
covers the overlap.

## Which model ran this (landed 2026-09-02)

The complaint that opened it: *"if I'm in a specific session, I wanna know
what model it ran … part of the reason I don't like agent view is that I
can't tell which model is what conv without opening"*. Model attribution
was in the index from v12 and on exactly one surface — the session
header. Every listing that names a conversation now names what ran it.

**The chip** (`src/model.ts`, rendered by `viz.ts`): family hue, short
label, full id in the `title`. `claude-opus-4-8` → `opus-4.8`,
`claude-haiku-4-5-20251001` → `haiku-4.5`; a `[1m]` tag stays, and an id
that is not a family-version pair passes through untouched rather than
being guessed at.

**Colour is the family, and only the family.** Four families fit the
categorical palette exactly (opus → series-1, fable → 2, sonnet → 3,
haiku → 4, anything else neutral), so a hue means the same model wherever
it appears, and the generation rides in the text where a fifth and sixth
hue would have failed anyway. This replaced rank-assigned slots in the day
chart, where the same blue was opus in one window and fable in another and
agreed with no chip on the page. The stacked charts now stack by family
and their legend is stable; the exact ids ride in the column tooltip and
in the `by model` table, which is the ledger.

Where it lands:

- `/` — a model column in **recent** (identity, so it sits left of the
  prompt with the well, never among the numbers) and a chip in the
  **agents** panel.
- `/agents` — a model column. For a **live** agent (working/blocked) the
  model is read from the last assistant record of its own transcript
  (`modelSource: transcript`); otherwise it is the session's dominant
  model as of the last index (`modelSource: index`, rendered dimmed). The
  fleet rule is that a model is verified from the JSONL and never from a
  parameter or a notification (CLAUDE.md's fan-out rules) — the roster
  holds itself to it. Two candidate wells are tried, cwd-slug and indexed,
  because a session that enters a worktree has been observed under both.
- `/well/<dir>` — a model column per session and the well's own mix as a
  tile; `/job/<id>` — which `/clear` ran on what.
- `/search` — a chip on each hit's meta line.
- `/session/<id>` — the mix in the header, and, **only when the session
  switched**, a model column in the spine: which prompt ran on what. Each
  step's fee cell names its model too.
- the **fan-out ledger** under the fee bar: agent type × verified model ×
  output tokens for the session's spawns, with the requested alias shown
  when the served model does not contain it (the drift rule `lore spawns`
  uses, now one definition in `model.ts`). "Which tokens came from which
  agent" is answered on the page where the fan-out happened.

Layer 1 carries it too, so miners and agents get it without the page:
`lore sessions` rows gain `models` (one grouped query over the picked
ids — never a correlated subquery per row), `lore agents` gains `model` +
`modelSource`, `lore trace` gains top-level `models` and `spawns` and a
per-transaction `model`. No schema change: `requests.model` (v12) and
`spawns.model` (v6) already held everything.

## The block view (design pass, landed 2026-09-01)

Designed against two sessions that could not be more different and had to
read on one page: a grind (one `continue`, 298 steps, 54 min, $42 list)
and a lore conversation (16 prompts, 209 steps, 2.4 h, $48). The
transaction table alone was the whole design before; on the grind it was
one row. Three reads, top to bottom, all from `getTrace` — no client code,
`<details>` is the only interaction (`?open=all` unfolds everything for
⌘F or print).

1. **Header.** Identity, model mix (`claude-opus-5 ×298`), and the **fee
   bar**: list $ split by token class. Dollars, not tokens — cache reads
   are 100× the tokens and a tenth of the money, so a token bar says
   nothing and a dollar bar says everything: the opus grind is 86% cache
   read, the Fable conversation is 32% output / 39% cache read / 29%
   cache write. The exchange rate made visible per session.
2. **The map.** A swimlane timeline of every instruction at its wall-clock
   x — one lane per tool family (`say`, `read`, `write`, `run`, `agent`,
   `other`; only lanes present are drawn), width = latency (1.5‰ floor),
   errors in the status color, the assistant's notes and closing text as
   ticks in `say`. Transactions are numbered bands behind, linked to their
   rows. Lane position carries identity; the three hues (blue / orange /
   aqua, the palette's all-pairs-safe first three) are redundant. The lane
   label is the legend.
3. **The spine.** Transactions as grid rows: number (harness preamble is
   unnumbered — #1 is the first *turn* on every surface, and the header
   tile counts the same set), time, the message (two-line clamp when
   folded), steps / instructions / errors / output, and list $ and wall
   with **inline bars** against the session's max so the heavy transaction
   reads before its digits do. A one- or two-turn session opens by default
   (the block *is* the transaction); a conversation stays folded.

   A **turn** is a transaction somebody opened: the user typing, the
   user's slash command, or a **peer session relaying in**. The envelope
   the harness wrapped it in never reaches the row — it becomes the chip
   and the message stays the text (`envelope.ts`). A relay wears its
   sender, `@lore`, a hued chip and a left rule, and reads in full ink:
   another agent's turn is work, not preamble. Harness injections wear
   what they are — `task`, `stdout`, `image`, `skill`, `reminder`,
   `context`, `caveat` — stay muted, and are neither numbered nor counted.

   This is not cosmetic. A relay spends ~96 characters naming a unix
   socket (`Another Claude session sent a message:
   <cross-session-message from="uds:/tmp/cc-socks/85001.sock"
   from-name="ccc" from-mode="prompting">`) before its first word, so a
   two-line clamp showed the envelope and none of the message; a task
   notification spent three lines on ids before naming the agent that
   finished. The raw record is untouched in the index — the text is
   evidence, and FTS still searches the envelope with it; the unwrapping
   is a display edge, driven off the harness's own structural tags and
   the `peer` column, never off prose shape.

   The reply is IN the turn, not after it. A peer's message opens a
   transaction, the session works — 38 instructions in the golden record —
   and the last instruction is the `SendMessage` back. That genuinely is one
   turn, so it is not hoisted out; what was wrong is that the single thing
   worth reading sat at the bottom of a fold as raw JSON. The outbound half
   now rides on the transaction (`sent[]`, read off the SendMessage calls):
   an outlined `→ @ccc` chip on the row, so an answered relay says so without
   being opened, and the sender's own one-line `summary` closing the body
   beside the assistant's reply. Filled chip in, outlined chip out, one hue —
   the conversation reads across the page.

   The same head runs through every listing that names a session —
   recent on `/`, a well's arc, a search hit. A session an agent stood
   by for has no prompt-lane row at all, and headed its arc with a dash
   until the relay lane got a head of its own: the opener is now the
   first `prompt` **or** `relay` row, whichever came first, and
   `openedBy` names the peer when a relay won. The column is `opening`,
   not `opening prompt`, because it is no longer always one.

Time, everywhere: **an instant is UTC, a day is local.** The pages used to
print `… → 10:26:00 UTC` and bucket `--by day` on `substr(ts, 1, 10)`, which
is internally consistent and wrong for a reader: at UTC-5 the UTC day
boundary falls at 7pm local, so an evening's work splits across two buckets
and the front page's "today" tile answers for a window that ended at 7pm
yesterday. Days, clocks and windows are now local (`fmt.ts` at the display
edge, `date(ts, 'localtime')` in the SQL buckets, `dayStart` turning a window
a person writes into the UTC instant of local midnight); storage, ordering,
`--since` cursors and rate dates stay UTC. The header prints the real zone
(`EST`) instead of a hardcoded `UTC`.

Re-bucketing conserves: across the whole corpus both versions report 106,196
requests and $25,094.04 — 71 UTC buckets became 70 local ones, and 2026-09-01
went from $1,070.64 to $1,364.67 as the evening hours came home.

Inside a transaction: **phases**. The assistant's text emitted *between*
instructions ("Now the tests: one for the coin's two arms…") is its own
heading for the run of steps that follows — zero inference, and it
decomposes the grind's single prompt into 14 phases with counts, span,
and errors each; the closing text (after the last instruction) is the
reply, never a note. `getTrace` carries them as `notes[]` (`at` = the
index of the next instruction) and `thoughts[]` (thinking blocks, same
cursor; collapsed inline), and each instruction knows its `requestId`, so
instruction rows group by step with the step's fee (out tokens, thinking,
$) in the margin. Inputs render as the argument that names the call
(Bash's command and description, a file tool's path, Grep's pattern in
its path) rather than the JSON head.

Rejected: a client-side tree viewer (Langfuse-style span tree + detail
pane) — earns nothing over `<details>` at this size and costs a build
step; a token-stacked fee bar (see 1); per-instruction color in the
timeline without lanes (2px marks cannot carry hue). Deferred: a
transaction page with the full instruction logs (`/session/:id/tx/:n`),
and a "diff view" of files touched — both wait for a session that needs
them.

## The console (layout pass, landed 2026-09-01)

The pages were documents — a title, then tables, four pagefuls of
scrolling, the only actionable thing above the fold. The user's read: "not
dense enough, not an ops/control dashboard". The pass makes the viewport
the frame: `body` never scrolls, `main` is a CSS grid of **panels**
(`style.ts`; header + an internally scrolling body), and every list is a
grid row — one line, ellipsis, tooltip on hover, inline bar beside the
number that matters. 13px type, 3px row padding. Under 900px the grid
falls back to a stack and the page scrolls.

- **`/` — the control room.** KPI tiles (today $, this week $, requests,
  sessions, working, blocked), the **45-day chart** (list $ per day,
  stacked by the top three models in series order + other), **recent**
  (60 sessions by last activity, hour for today, harness-only sessions
  filtered), **agents** (state dot, name, doing, live tokens, $ —
  the roster's top 14), **active this week** (wells by $ with bars).
  Windowed queries only; the roster is memoized 10 s.
- **`/usage`.** The token profile over **one window**. A toolbar carries
  the page's whole state — window (`7d` / `30d` / `90d` / `all`, or absolute
  `since` → `until` dates via a GET form) × granularity (`day` / `week` /
  `month`) — as plain links, so the switch rides the view transition and
  needs no client code. The URL is the state, under `lore usage`'s flag
  names (`/usage?since=2026-08-01&until=2026-08-31&by=week`; defaults are
  omitted, so `/usage` stays clean), and the JSON echoes `window`. Every
  panel follows it: the stacked chart at the granularity; **by model** with
  the **fee split by class** per row (the bar from the block view — Fable 5
  is output-heavy, opus is cache-read-heavy, visible in one glance); by well
  (top 60); the buckets newest-first in the right column. Default: last 90
  days by day. Why one control and not one period per panel (2026-09-01):
  the window is a property of the question, not of the panel, and
  "by model since forever" mixes pricing epochs and dead models — the
  window view is what says whether Fable's share is growing. Aggregates
  are memoized five minutes, keyed on index timestamp + window. `until`
  in the URL is the inclusive day a person writes; the query's exclusive
  bound is the day after. Unparseable params fall back to the default
  rather than 400ing. Known: buckets with no requests are absent, not
  zero-width — a quiet week leaves a gap in the chart rather than a
  flat bar.
- **`/agents`.** One row per agent: state, name, where, doing, live
  tokens with bars, requests, $, indexed (ago), links (a pile of 100 PRs
  folds into "100 links"), attach command.
- **`/well/:dir`, `/job/:id`, `/session/:id`** — a fixed head (title,
  tiles, and for the session the fee bar and timeline) over one scrolling
  panel, so the block's map stays put while its spine scrolls.

`listUsage` gains `split`: per row, the list $ by token class (`usd`) and
by model (`models`), from the same (key, model, day) cells — that is
what the stacked chart and the per-model fee bars read.

Deferred: a TUI. The web console at this density *is* the terminal-shaped
explorer; a curses surface would re-implement it for one screen.

### Theme (2026-09-01)

Tokens are OKLCH with `light-dark()` pairs — one cool-tinted neutral scale
(hue 265, shared with the author's other pages) at symmetric lightness steps, so
lore reads as a sibling of them. The page is the darker ground;
panels sit one step up, tiles one more. Series hues stay the dataviz
reference palette, re-validated against the new surfaces (dark: all pass;
light: the known sub-3:1 warning on orange/aqua/yellow, relieved by the
labels and tables beside every mark). Type is mono-first — numbers,
headers, nav, labels in `ui-monospace` (SF Mono here), sans only for prose
(prompts, replies, notes) — which is where the terminal feel comes from,
not from a downloaded font; no web font is loaded on purpose. KPI tiles
carry a 14-day sparkline and stretch to the chart's height. A working
agent's dot pulses (CSS only, off under reduced motion). `?theme=light|dark`
pins the scheme — also how the light layout gets screenshot-checked.

### Oomph (2026-09-01, branch `oomph`)

Craft-level motion and scale, judged live in the browser with the user
steering; every rule in `style.ts`, no client code.

- **Fold.** `<details>` bodies ease open/closed over 220ms via
  `::details-content` + `interpolate-size: allow-keywords` (Chrome 133+;
  elsewhere they snap as before); the marker rotates instead of swapping
  glyphs; row hover eases at 120ms. Off under reduced motion.
- **View transitions.** `@view-transition { navigation: auto }` — same-origin
  MPA, so every link and back/forward cross-fades at 180ms. The nav is
  pinned (`view-transition-name: nav`), the active underline morphs to its
  new place, the page head (well/job/session) rises in.
- **Pulse.** The working dot beats at 1.8s: ring out in the first 55%, rest
  for the remainder — a heartbeat, not a ripple.
- **Scrollbars.** 6px on the panel edge, transparent track, thumb shown only
  while the pointer is over its panel (webkit pseudos; Firefox gets the
  standard thin themed bar). Cost: a 6px gutter per panel.
- **Metered cells.** A cell with an inline bar is a flex row — bar pinned
  left, number right — so bars line up down a column whatever the number's
  width (they used to ride the right-aligned number, jittering 1ch).
- **Timeline type is HTML.** The SVG holds geometry only, `preserveAspectRatio:
  none`, x in permille and y in CSS px — widths are time spans, so the
  horizontal stretch is exact. Lane labels, band numbers, and the axis are
  HTML at 9px positioned by percentage, so they stay 9px whether the panel
  is 700px or 2000px wide (they were SVG text: 8.4px at a third of the
  3440px ultrawide, 14.6px at two thirds).
- **Fluid type scale.** One multiplier `--z` from the viewport — 1 up to
  ~1170px (a third of a 3440px ultrawide), 1.18 from ~1640px (two thirds),
  a 13" laptop between — via `tan(atan2(100vw, 2600px))` for a unitless ratio;
  every font size is an `--fs-*` token on it. Spacing stays in px, so a wide
  window reads denser, not airier; the grid columns that hold type scale
  with it. Rejected: a modular ratio per level (jh3y/Utopia) — a console
  wants its hierarchy compressed; hierarchy here is weight and ink.
- **Container queries where they earn it.** KPI tile values are sized from
  the tile's content box (`100cqi / 4.75` fits eight SF Mono characters; the
  labels `100cqi / 8`), so they never overflow the padding. Panel headers
  are one line: legend truncates, and below 520px the subtitle steps aside.
- The agents tile matches its row (count over `agents`, one dotted line per
  state where the sparkline sits); the usage page says `since <first indexed
  day>`, not "all time" (a lie: it is since the logs begin).

The four viewports this was checked against: a third of the ultrawide
(~1146px, the daily driver), two thirds (~2000px), the 13" Air (1470px),
and the phone (<900px, the stacked layout). Headless Chrome for the widths
the live window is not at (memory `headless-chrome-layout-check`).

## Sequence

1. v13 + `lore trace` — landed.
2. `lore serve` skeleton — landed; `/cli/` + `lore server` — landed.
3. Recent, search, annotations, agents, job — landed.
4. Jobs (trailer → transcript) + self-refresh — landed. Core complete.
5. Design pass — the block view, then the console layout: landed (above);
   model attribution across every listing: landed (above).
   Open: a search palette (search-as-you-type over titles) if the nav
   search proves too slow to reach for; light-mode screenshots (the
   headless checks ran dark).
6. Native only if the web surface fails to earn itself.

## Not built, on purpose (candidates for later)

- Root-page aggregates (~120 ms each ×3): a 60 s in-process cache if the
  root ever needs to be instant.
- A fuzzy/frecency session palette (fff-style) over titles — the design
  pass decides whether search-as-you-type earns client code.
- Interactive-session trailer resolution — no local file carries the
  bridge id for them; would need the harness to write one.
- MCP: `lore --mcp` already serves every verb (incur); the explorer's
  routes are the same verbs, so nothing new is owed there.
