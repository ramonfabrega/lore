# Spelunk notes — raw source census (2026-07-17)

First-principles survey of the actual data before designing anything. Sampled wells:
`work-cuanto--*-storefront-shell-refactor` (370M, 47 sessions), `fun-golf-sim--*-scaffold`
(571M), `fun-tv` (37M, main), `~/code` root well. Claude Code ~v2.1.x era transcripts,
2026-06-12 onward (everything older was lost to default retention before we raised it).

## Corpus shape

- ~40 wells, ~1.6GB. **The five largest wells are all perma-worktree wells** (571M,
  370M, 169M, 105M, 90M) — agent homes dominate, matching the user's workflow.
- `memory/` dirs exist only on main (non-worktree) wells.
- Session files are `<uuid>.jsonl` at well root; each session may have a sibling dir
  `<uuid>/` containing `subagents/` (incl. `subagents/workflows/wf_*/agent-*.jsonl`)
  and `tool-results/` (large tool outputs offloaded as files, e.g.
  `mcp-linear-server-list_issues-<ts>.txt`).

### Gotcha #1: leading-dash paths

Well dir names encode absolute paths as `-Users-rf-studio-code-...` — they start with
`-`. Naive `find`/`du`/CLI calls parse them as flags. Always `./`-prefix or use
absolute paths. (Also: the encoding is lossy — `-` could be a path separator or a
literal hyphen in a dir name; e.g. `fun-golf-sim` vs a hypothetical `fun/golf/sim`.
Resolution needs corroboration from record-level `cwd` fields, which carry the truth.)

## Session file anatomy

A transcript is an **event log**, not a chat log. Record `type` census from a busy
session (1,097 lines) plus the ~/code well:

| type | notes |
|------|-------|
| `assistant` | message envelope; `message.content[]` blocks: `tool_use` (225), `thinking` (141), `text` (46) in sample |
| `user` | content is a plain string for real human prompts (38 in sample), else `tool_result` blocks (225) |
| `system` | subtypes seen: `away_summary` (!), `turn_duration`, `local_command` |
| `worktree-state`, `mode`, `permission-mode`, `agent-setting` | session state streams |
| `custom-title`, `ai-title`, `agent-name`, `last-prompt` | naming/labels over time |
| `pr-link` | PR number/repo/url — **landing events, gold for arc detection** |
| `queue-operation` | queued prompts |
| `attachment` | attached content records |
| `file-history-snapshot` / `file-history-delta` | checkpoint/rewind machinery |

Envelope fields on message records: `uuid`, `parentUuid` (thread DAG), `sessionId`,
`timestamp`, `cwd`, `gitBranch` (**per-record branch — arc reconstruction aid**),
`version` (CC version), `userType`, `isSidechain` (absent in sampled files),
`sessionKind` (`"bg"` marks background sessions — sometimes absent within the same
file, likely version drift), `requestId`, `promptId`, `toolUseResult` on tool-result
user records, `attributionMcpServer/Tool` on MCP-attributed assistant records.

### Signal ratio (quantified)

In the 1,097-line sample: **38 human prompt lines, 46 assistant text blocks**.
Everything else is thinking (141), tool traffic (450), and event records (~420).
Roughly **3–4% of lines are conversational signal** — the index must separate
lanes (prompts / assistant text / thinking / tool traffic / events) or FTS will
drown in tool noise.

### Compaction: no persistent trail found

Zero `type:"summary"` records, zero `compact_boundary` subtypes, zero
"continued from a previous conversation" openers across sampled wells. Auto-compact
appears not to persist its summary to the transcript in this era. **Open question**
— but `system/away_summary` records DO persist harness-written summaries, and every
`/clear` starts a new session file, so session-file boundaries within a well+cwd are
the clear signal.

## Sources beyond the wells (all in ~/.claude)

- **`history.jsonl`** — 12,340 rows: every prompt ever typed, with `display`,
  `pastedContents`, `project` (real path, not dash-mangled), `sessionId`, `timestamp`.
  **Survived the 30-day retention that killed old transcripts** — includes 6,060
  cuanto prompts and 844 for `deck`, a project with no surviving well. This is both
  the global spine (prompt → session → well join key) and the only archaeology for
  the pre-2026-06-12 era.
- `sessions/*.json` — live session registry (pid, kind, name, jobId, cwd, status).
- `file-history/` — checkpoint blobs backing rewind.
- `memory-backups/` — prior memory snapshots (e.g. `cuanto-pre-dissolve`).
- `todos/`, `debug/`, `stats-cache.json`, `plugins/`, `shell-snapshots/` — unexamined.

## Addendum (same day, found while building v0)

- **Thinking is not persisted.** Every `thinking` block on disk carries an empty
  `thinking: ""` plus only the cryptographic `signature` — 0 non-empty across 6,335
  sampled blocks in three wells. The "index thinking, off by default" decision is
  moot in practice; the lane plumbing stays (free, future-proof) but the corpus has
  no reasoning text. Rationale archaeology must come from assistant `text`.
- **Bun auto-serve gotcha:** an entry module whose default export has `.fetch`
  (every incur CLI) gets auto-served as an HTTP server by `bun run` and never
  exits. Entrypoint (`src/main.ts`) must be separate from the CLI definition
  (`src/cli.ts`, default-exported for `incur gen`).
- **macOS ships openrsync** (not GNU rsync); `--stats` wording differs
  ("Number of files transferred" vs "Number of regular files transferred").
- Wells can have **memory but zero sessions** (crypto/*, fun-album, fun-disk main):
  retention ate the transcripts, memory survived. The reverse of the worktree case.

## Preliminary implications for layer 1 (to validate, not gospel)

1. **Archive first, verbatim** — rsync-style snapshot of `~/.claude/projects` +
   `history.jsonl` before any parsing. Raw sources are immutable tier 1.
2. **Parse the envelope, lane the content.** One record schema (type + envelope),
   content split into lanes: human prompts, assistant text, thinking, tool traffic,
   events. FTS indexes lanes separately (or with a lane column) so search doesn't
   drown in tool_result JSON.
3. **`history.jsonl` is the join spine** and the cheap v0: project → sessions →
   prompts with timestamps, no transcript parsing needed to be useful.
4. **Arc detection inputs confirmed available**: session-file boundaries (/clear),
   per-record `gitBranch`, `pr-link` records (landings), plan-file Write/Edit
   tool_use records, `away_summary` free digests, `custom-title`/`ai-title` labels.
5. **Well↔repo resolution via record `cwd`**, not by parsing dash-mangled dir names.
6. Subagent/workflow transcripts and `tool-results/` files are secondary lanes —
   index their existence + metadata first, full text later if ever.
