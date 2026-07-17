import { Cli, z } from 'incur'
import { archive } from './archive'
import { ARCHIVE_DIR, CLAUDE_DIR, DB_PATH, HISTORY_PATH, PROJECTS_DIR, WIKI_DIR } from './config'
import { openDb } from './db'
import { buildIndex } from './indexer'
import type { Lane } from './parse'
import { searchHistory, searchMessages } from './search'
import { listSessions } from './sessions'
import { listWells } from './wells'
import { wikiCommit } from './wiki'

const LANES = ['prompt', 'text', 'thinking', 'tool', 'event', 'meta'] as const

const cli = Cli.create('lore', {
  version: '0.1.0',
  description:
    'Claude Code memory/conversation explorer. Archives, indexes, and searches the wells in ~/.claude/projects.',
  sync: {
    suggestions: [
      'search my sessions for when we set up sparkle notarization',
      'which wells are the biggest?',
      'archive my claude data',
    ],
  },
})

cli.command('wells', {
  description: 'List discovered wells (per-directory transcript+memory stores)',
  options: z.object({
    worktrees: z.boolean().optional().describe('Only worktree wells'),
  }),
  run: async ({ options }) => {
    let wells = await listWells(PROJECTS_DIR)
    if (options.worktrees) wells = wells.filter((w) => w.isWorktree)
    return {
      count: wells.length,
      wells: wells.map((w) => ({
        dir: w.dir,
        realPath: w.realPath,
        isWorktree: w.isWorktree,
        hasMemory: w.hasMemory,
        sessions: w.sessions.length,
        bytes: w.sessions.reduce((n, s) => n + s.size, 0),
      })),
    }
  },
})

cli.command('sessions', {
  description: 'List indexed sessions chronologically — the arc spine of a well (dates, lines, opening prompt)',
  options: z.object({
    well: z.string().optional().describe('Filter to wells whose dir or real path contains this substring'),
    limit: z.number().default(100).describe('Max results'),
  }),
  alias: { well: 'w', limit: 'n' },
  run: ({ options }) => {
    const db = openDb(DB_PATH)
    const sessions = listSessions(db, { well: options.well, limit: options.limit })
    return { count: sessions.length, sessions }
  },
})

cli.command('index', {
  description: 'Build or refresh the search index (incremental by mtime/size)',
  options: z.object({
    full: z.boolean().optional().describe('Reindex everything, ignoring the incremental skip'),
  }),
  run: async (c) => {
    const db = openDb(DB_PATH)
    const stats = await buildIndex(db, { projectsDir: PROJECTS_DIR, historyPath: HISTORY_PATH, full: c.options.full })
    return c.ok(stats, {
      cta: {
        description: 'Next:',
        commands: [{ command: 'search', description: 'Search the index' }, 'stats'],
      },
    })
  },
})

cli.command('search', {
  description: 'Full-text search across indexed sessions (FTS5 query syntax)',
  args: z.object({
    query: z.string().describe('FTS5 match expression, e.g. "sparkle notarization" or sparkle NEAR(key, 5)'),
  }),
  options: z.object({
    lane: z
      .array(z.enum(LANES))
      .optional()
      .describe('Lanes to search (default: prompt, text). thinking/tool/event/meta are opt-in'),
    well: z.string().optional().describe('Filter to wells whose dir or real path contains this substring'),
    limit: z.number().default(20).describe('Max results'),
    history: z.boolean().optional().describe('Also search history.jsonl (every prompt ever typed, survives retention)'),
  }),
  alias: { lane: 'l', well: 'w', limit: 'n' },
  run: ({ args, options }) => {
    const db = openDb(DB_PATH)
    const lanes = (options.lane ?? ['prompt', 'text']) as Lane[]
    const hits = searchMessages(db, args.query, { lanes, well: options.well, limit: options.limit })
    const history = options.history ? searchHistory(db, args.query, { limit: options.limit }) : undefined
    return { query: args.query, lanes, count: hits.length, hits, ...(history ? { history } : {}) }
  },
})

cli.command('stats', {
  description: 'Index statistics: lanes, wells, date range',
  run: () => {
    const db = openDb(DB_PATH)
    const lanes = db.prepare('SELECT lane, COUNT(*) AS n FROM messages GROUP BY lane ORDER BY n DESC').all()
    const wells = db
      .prepare(
        `SELECT w.dir, COUNT(DISTINCT s.session_id) AS sessions, COUNT(m.id) AS messages
         FROM wells w LEFT JOIN sessions s ON s.well_id = w.id LEFT JOIN messages m ON m.session_id = s.session_id
         GROUP BY w.id ORDER BY messages DESC LIMIT 15`,
      )
      .all()
    const range = db.prepare('SELECT MIN(first_ts) AS earliest, MAX(last_ts) AS latest FROM sessions').get()
    const totals = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM messages) AS messages,
                (SELECT COUNT(*) FROM history) AS historyRows`,
      )
      .get()
    return { totals, range, lanes, topWells: wells }
  },
})

const wiki = Cli.create('wiki', {
  description: 'Operations on the lore wiki (the compounding middle tier)',
})

wiki.command('commit', {
  description:
    'Commit pending wiki changes — the passage model: a wiki mutation is not durable until committed, and the commit is the tool’s job. Call at the end of every wiki op.',
  options: z.object({
    message: z.string().optional().describe('Commit message (default: auto-generated from changed files)'),
  }),
  alias: { message: 'm' },
  run: ({ options }) => wikiCommit(WIKI_DIR, options.message),
})

cli.command(wiki)

cli.command('archive', {
  description: 'Additive mirror of ~/.claude data (projects, history, todos) — deleted sources stay preserved',
  run: async (c) => {
    const stats = await archive({ claudeDir: CLAUDE_DIR, archiveDir: ARCHIVE_DIR })
    return c.ok(stats, {
      cta: { description: 'Next:', commands: [{ command: 'index', description: 'Refresh the search index' }] },
    })
  },
})

export default cli
