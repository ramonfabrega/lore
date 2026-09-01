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

// Build provenance: scripts/install inlines LORE_BUILD_INFO into the frozen
// bundle; a dev run reads 'dev'. main.ts prints the richer dev form on stderr;
// this is the machine-readable one the server reports so `lore server status`
// can say "running b58, installed b59 — restart owed".
declare const LORE_BUILD_INFO: string
export const BUILD_INFO = typeof LORE_BUILD_INFO === 'string' ? LORE_BUILD_INFO : 'dev'

export const PROJECTS_DIR = join(CLAUDE_DIR, 'projects')
export const HISTORY_PATH = join(CLAUDE_DIR, 'history.jsonl')
export const DB_PATH = join(LORE_HOME, 'lore.db')
export const ARCHIVE_DIR = join(LORE_HOME, 'archive')
