# lore

Claude Code memory/conversation explorer and knowledge compounder.

Conversations are the raw lore; the wiki is where it accumulates; graduation turns
lore into canon (git-committed CLAUDE.mds and docs). See `CLAUDE.md` for the thesis
and `docs/DESIGN.md` for the design narrative and decision log.

## v0 — layer 1 CLI (model-free)

The blessed bin: `scripts/install` builds the installed `lore` from a clean
landed tree (test-gated, provenance on stderr) — sessions and subagents use
that by default. The `bun src/main.ts` forms below are the dev lane, invoked
from this checkout by explicit path only.

```sh
bun install

bun src/main.ts archive   # additive mirror of ~/.claude data → ~/.lore/archive (job zero)
bun src/main.ts index     # build/refresh the FTS5 index + spawns lane (~4s full, sub-second incremental)
bun src/main.ts wells     # list wells: real path, worktree/memory flags, sizes
bun src/main.ts sessions --well tv          # a well's arc spine; --exact for prefix wells
bun src/main.ts session <id-prefix> --lane prompt
bun src/main.ts search "sparkle notarization" --history
bun src/main.ts spawns    # subagent observatory: verified model, drift, boot cost, weekly trend
bun src/main.ts workflows # workflow runs: script meta, agents, tokens, model mix; drill: spawns --workflow
bun src/main.ts tools --prefix Skill:       # invocation usage — the ambient ROI evidence
bun src/main.ts usage --by week             # the token profile: 4 billed classes + thinking, dated list-price equivalent; --by well|session|model|day|month
bun src/main.ts trace <id-prefix>           # one session as a block: transactions → steps (fee) + instructions (tool, latency, error); docs/EXPLORER.md
bun src/main.ts docs index --fetch          # canon corpus (git objects, never working trees)
bun src/main.ts stats

bun src/main.ts skills add  # install lore-* skills so agents discover the CLI
```

Built on [incur](https://github.com/wevm/incur) — agent-first CLI surface (TOON/JSON
output, `--llms` manifest, token pagination, MCP via `--mcp`) — and `bun:sqlite` FTS5.

Env: `LORE_HOME` (default `~/.lore`), `LORE_CLAUDE_DIR` (default `~/.claude`).
