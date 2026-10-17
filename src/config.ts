import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

// All env config in one validated pass — no scattered `process.env.X ?? default`.
const env = z
  .object({
    LORE_CLAUDE_DIR: z.string().default(join(homedir(), '.claude')),
    LORE_HOME: z.string().default(join(homedir(), '.lore')),
    LORE_WIKI_DIR: z.string().default(join(homedir(), 'code', 'personal', 'lore-wiki')),
    LORE_CODE_DIR: z.string().default(join(homedir(), 'code')),
    LORE_DOCS_EXCLUDE: z.string().default(''),
    LORE_DOCS_ASSISTED: z.string().default(''),
  })
  .parse(process.env)

// An instant is UTC everywhere — storage, ordering, `--since`, index cursors.
// A DAY is local: `usage --by day` answers "what did I do Tuesday", and at
// UTC-5 the UTC boundary falls at 7pm, cutting the most active hours in half.
// lore is a localhost/tailnet explorer where the user is both server and
// client (CLAUDE.md), so the server's own zone IS the reader's — no client
// code, no per-viewer negotiation.
//
// There is deliberately no LORE_TZ: the zone is the PROCESS zone, the
// standard `TZ` env var, because that is the only knob both halves obey.
// SQLite's `localtime` (usage.ts's day buckets) reads TZ through the C
// library, which caches it at first use — assigning `process.env.TZ` at
// runtime moves the Intl formatters and leaves the SQL buckets behind, which
// is precisely the half-migration that makes a page contradict itself
// (measured 2026-09-02: the runtime assignment reached Intl and not SQLite).
// So: set TZ in the environment before launch, as with any process, and both
// layers move together and stay DST-correct off the OS zone database.
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

export const CLAUDE_DIR = env.LORE_CLAUDE_DIR
export const LORE_HOME = env.LORE_HOME
export const WIKI_DIR = env.LORE_WIKI_DIR
export const CODE_DIR = env.LORE_CODE_DIR
// Repos to skip in the docs scan entirely (comma-separated path suffixes),
// on top of the automatic upstream-remote foreign flag.
export const DOCS_EXCLUDE = env.LORE_DOCS_EXCLUDE.split(',').map((s) => s.trim()).filter(Boolean)
// Repos to force-flag assisted (same suffix syntax) when the zero-authored
// auto-signal gets one wrong.
export const DOCS_ASSISTED = env.LORE_DOCS_ASSISTED.split(',').map((s) => s.trim()).filter(Boolean)

// Build provenance: scripts/install.ts inlines LORE_BUILD_INFO into the frozen
// bundle; a dev run reads 'dev'. main.ts prints the richer dev form on stderr;
// this is the machine-readable one the server reports so `lore server status`
// can say "running b58, installed b59 — restart owed".
declare const LORE_BUILD_INFO: string
export const BUILD_INFO = typeof LORE_BUILD_INFO === 'string' ? LORE_BUILD_INFO : 'dev'

// The command that re-invokes THIS lore — the same build, not whatever
// `lore` on PATH resolves to. The server spawns its index refresh as a child
// (cli.ts, `serve --refresh`), and the child has to be the server's own
// build: openDb rebuilds the db over an older schema and refuses a newer
// one, so a server still running b58 that spawned an installed b59 would
// have the child migrate the db out from under it and then refuse its own
// next statement. Three lanes: the frozen bundle (`bun ~/.lore/dist/lore.js`,
// Bun.main is the bundle), the dev lane (`bun <checkout>/src/main.ts`, an
// explicit absolute path as the convention asks), and a `--compile`
// executable, where Bun.main is a path inside the embedded virtual fs and
// the executable alone is the program.
export function selfArgv(): string[] {
  const embedded = Bun.main.startsWith('/$bunfs/') || Bun.main.includes('/~BUN/')
  return embedded ? [process.execPath] : [process.execPath, Bun.main]
}

export const PROJECTS_DIR = join(CLAUDE_DIR, 'projects')
export const HISTORY_PATH = join(CLAUDE_DIR, 'history.jsonl')
export const DB_PATH = join(LORE_HOME, 'lore.db')
export const ARCHIVE_DIR = join(LORE_HOME, 'archive')
