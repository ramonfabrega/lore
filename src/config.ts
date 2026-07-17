import { homedir } from 'node:os'
import { join } from 'node:path'

export const CLAUDE_DIR = process.env.LORE_CLAUDE_DIR ?? join(homedir(), '.claude')
export const LORE_HOME = process.env.LORE_HOME ?? join(homedir(), '.lore')

export const PROJECTS_DIR = join(CLAUDE_DIR, 'projects')
export const HISTORY_PATH = join(CLAUDE_DIR, 'history.jsonl')
export const DB_PATH = join(LORE_HOME, 'lore.db')
export const ARCHIVE_DIR = join(LORE_HOME, 'archive')
