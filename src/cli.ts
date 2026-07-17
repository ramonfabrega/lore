import { Cli, z } from 'incur'
import { archive } from './archive'
import { ARCHIVE_DIR, CLAUDE_DIR, CODE_DIR, DB_PATH, HISTORY_PATH, PROJECTS_DIR, WIKI_DIR } from './config'
import { openDb } from './db'
import { indexDocs, listIndexedRepos, searchDocs } from './docs'
import { buildIndex } from './indexer'
import type { Lane } from './parse'
import { searchHistory, searchMessages } from './search'
import { getSession } from './session'
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

cli.command('session', {
  description:
    'Dump one session’s messages in order — the transcript slice behind an arc (default lane: prompt). Accepts a unique id prefix.',
  args: z.object({
    id: z.string().describe('Session id or unique prefix (see the sessions listing)'),
  }),
  options: z.object({
    lane: z
      .array(z.enum(LANES))
      .optional()
      .describe('Lanes to include (default: prompt). gitBranch rides along — well membership ≠ work location'),
    limit: z.number().default(500).describe('Max messages'),
  }),
  alias: { lane: 'l', limit: 'n' },
  run: ({ args, options }) => {
    const db = openDb(DB_PATH)
    const lanes = (options.lane ?? ['prompt']) as Lane[]
    const dump = getSession(db, args.id, { lanes, limit: options.limit })
    return { ...dump.session, workDirs: dump.workDirs, lanes, count: dump.messages.length, messages: dump.messages }
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
    const lanes = z
      .array(z.object({ lane: z.string(), n: z.number() }))
      .parse(db.prepare('SELECT lane, COUNT(*) AS n FROM messages GROUP BY lane ORDER BY n DESC').all())
    const wells = z
      .array(z.object({ dir: z.string(), sessions: z.number(), messages: z.number() }))
      .parse(
        db
          .prepare(
            `SELECT w.dir, COUNT(DISTINCT s.session_id) AS sessions, COUNT(m.id) AS messages
             FROM wells w LEFT JOIN sessions s ON s.well_id = w.id LEFT JOIN messages m ON m.session_id = s.session_id
             GROUP BY w.id ORDER BY messages DESC LIMIT 15`,
          )
          .all(),
      )
    const range = z
      .object({ earliest: z.string().nullable(), latest: z.string().nullable() })
      .parse(db.prepare('SELECT MIN(first_ts) AS earliest, MAX(last_ts) AS latest FROM sessions').get())
    const totals = z
      .object({
        sessions: z.number(),
        messages: z.number(),
        historyRows: z.number(),
        repos: z.number(),
        docs: z.number(),
      })
      .parse(
        db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM messages) AS messages,
                    (SELECT COUNT(*) FROM history) AS historyRows,
                    (SELECT COUNT(*) FROM repos) AS repos, (SELECT COUNT(*) FROM docs) AS docs`,
          )
          .get(),
      )
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
  run: async ({ options }) => wikiCommit(WIKI_DIR, options.message),
})

cli.command(wiki)

const docs = Cli.create('docs', {
  description:
    'The canon corpus: git-committed .md files across the repos under ~/code, read from git objects (husk repos keep canon only at origin — the working tree is never trusted)',
})

docs.command('index', {
  description: 'Scan repos and index their canon .md files (incremental by commit sha; prunes gone repos)',
  options: z.object({
    full: z.boolean().optional().describe('Reindex every repo, ignoring the commit-sha skip'),
  }),
  run: async (c) => {
    const db = openDb(DB_PATH)
    const stats = await indexDocs(db, { codeDir: CODE_DIR, exclude: [WIKI_DIR], full: c.options.full })
    return c.ok(stats, {
      cta: {
        description: 'Next:',
        commands: [{ command: 'docs search', description: 'Search the canon corpus' }, 'docs list'],
      },
    })
  },
})

docs.command('search', {
  description: 'Full-text search across indexed canon docs (FTS5 query syntax) — lint fodder and graduation dedup ("does canon already say this?")',
  args: z.object({
    query: z.string().describe('FTS5 match expression'),
  }),
  options: z.object({
    repo: z.string().optional().describe('Filter to repos whose path contains this substring'),
    limit: z.number().default(20).describe('Max results'),
  }),
  alias: { repo: 'r', limit: 'n' },
  run: ({ args, options }) => {
    const db = openDb(DB_PATH)
    const hits = searchDocs(db, args.query, { repo: options.repo, limit: options.limit })
    return { query: args.query, count: hits.length, hits }
  },
})

docs.command('list', {
  description: 'List indexed repos: ref canon was read from, commit, doc count, husk flag',
  options: z.object({
    husks: z.boolean().optional().describe('Only husk repos (canon exists solely in git objects at origin)'),
  }),
  run: ({ options }) => {
    const db = openDb(DB_PATH)
    let repos = listIndexedRepos(db)
    if (options.husks) repos = repos.filter((r) => r.isHusk)
    return { count: repos.length, repos }
  },
})

cli.command(docs)

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
