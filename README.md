# lore

Claude Code memory/conversation explorer and knowledge compounder.

Conversations are the raw lore; the wiki is where it accumulates; graduation turns
lore into canon (git-committed CLAUDE.mds and docs). See `CLAUDE.md` for the thesis
and `docs/DESIGN.md` for the design narrative and decision log.

## v0 — layer 1 CLI (model-free)

```sh
bun install

bun src/main.ts archive   # additive mirror of ~/.claude data → ~/.lore/archive (job zero)
bun src/main.ts index     # build/refresh the FTS5 index (~3s full, ~150ms incremental)
bun src/main.ts wells     # list wells: real path, worktree/memory flags, sizes
bun src/main.ts search "sparkle notarization" --history
bun src/main.ts stats

bun src/main.ts skills add  # install lore-* skills so agents discover the CLI
```

Built on [incur](https://github.com/wevm/incur) — agent-first CLI surface (TOON/JSON
output, `--llms` manifest, token pagination, MCP via `--mcp`) — and `bun:sqlite` FTS5.

Env: `LORE_HOME` (default `~/.lore`), `LORE_CLAUDE_DIR` (default `~/.claude`).
