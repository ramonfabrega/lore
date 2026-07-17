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
  })
  .parse(process.env)

export const CLAUDE_DIR = env.LORE_CLAUDE_DIR
export const LORE_HOME = env.LORE_HOME
export const WIKI_DIR = env.LORE_WIKI_DIR
export const CODE_DIR = env.LORE_CODE_DIR

export const PROJECTS_DIR = join(CLAUDE_DIR, 'projects')
export const HISTORY_PATH = join(CLAUDE_DIR, 'history.jsonl')
export const DB_PATH = join(LORE_HOME, 'lore.db')
export const ARCHIVE_DIR = join(LORE_HOME, 'archive')
