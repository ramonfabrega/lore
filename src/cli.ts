import { Cli, z } from 'incur'
import { listAgents } from './agents'
import { archive } from './archive'
import { ARCHIVE_DIR, BUILD_INFO, CLAUDE_DIR, CODE_DIR, DB_PATH, DOCS_ASSISTED, DOCS_EXCLUDE, HISTORY_PATH, PROJECTS_DIR, WIKI_DIR } from './config'
import { openDb } from './db'
import { indexDocs, listIndexedRepos, searchDocs } from './docs'
import { buildIndex } from './indexer'
import { indexJobs } from './jobs'
import type { Lane } from './parse'
import { searchHistory, searchMessages } from './search'
import { resolveHost, serverDown, serverLogs, serverRestart, serverStatus, serverUp } from './server'
import { getSession } from './session'
import { listSessions } from './sessions'
import { indexSpawns, listSpawns } from './spawns'
import { listToolUsage } from './tools'
import { getThread } from './thread'
import { getTrace } from './trace'
import { GROUPINGS, listUsage } from './usage'
import { composeHandler, createApp } from './web'
import { listWells } from './wells'
import { wikiCommit, wikiInit } from './wiki'
import { indexWorkflowRuns, listWorkflowRuns } from './workflows'

const LANES = ['prompt', 'text', 'thinking', 'tool', 'event', 'meta', 'relay'] as const

// Session ids are read in prose as their first segment — the form every
// listing, job dir and roster row prints.
const short = (id: string) => id.slice(0, 8)

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
  description:
    'List indexed sessions chronologically — the arc spine of a well (dates, lines, the opening line). `firstPrompt` is what OPENED the session — the user\'s first prompt, or, when a peer session set this one to work, the relayed message with its envelope off, and `openedBy` then names the peer. `last` is the last WORK-lane line (prompt/text/thinking/tool), NOT the last line in the file: harness heartbeats keep timestamping a dormant session for weeks and they DO index (into the event lane), so `idleUntil` — present only when it exceeds `last` — is how long the session stayed open after the work stopped. --limit takes the NEWEST n and renders them oldest-first; use --since (activity-based) for delta ingests. Every row names the models that SERVED it (`models`, most requests first) — a listing answers "what ran this" without opening the session.',
  options: z.object({
    well: z.string().optional().describe('Filter to wells whose dir or real path contains this substring'),
    exact: z
      .boolean()
      .optional()
      .describe('Match --well exactly instead of by substring (the ~/code root well is a prefix of every other well)'),
    since: z
      .string()
      .optional()
      .describe('Only sessions with ACTIVITY on/after this ISO date (e.g. 2026-08-01) — heartbeat-only tails do not qualify'),
    limit: z.coerce.number().default(100).describe('Max results (takes the newest n, then renders oldest-first)'),
  }),
  alias: { well: 'w', limit: 'n' },
  run: ({ options }) => {
    const db = openDb(DB_PATH)
    const sessions = listSessions(db, {
      well: options.well,
      exact: options.exact,
      since: options.since,
      limit: options.limit,
    })
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
      .describe(
        'Lanes to include (default: prompt — what the USER typed, and only that). gitBranch rides along; well membership ≠ work location. `relay` is what other sessions sent this one, attributed by `peer`; `meta` is what the harness injected (skill bodies, command wrappers, images) — both used to sit in `prompt` and read as the user\'s own words. A row whose `type` is `attachment` was read MID-TURN (the harness queues what arrives while the session works and delivers it at the next tool result) — the same lanes, but it opened no turn.',
      ),
    well: z
      .string()
      .optional()
      .describe('Narrow an ambiguous id prefix to wells whose dir or real path contains this substring'),
    exact: z.boolean().optional().describe('Match --well exactly instead of by substring'),
    limit: z.coerce.number().default(500).describe('Max messages'),
  }),
  alias: { lane: 'l', well: 'w', limit: 'n' },
  run: ({ args, options }) => {
    const db = openDb(DB_PATH)
    const lanes = (options.lane ?? ['prompt']) as Lane[]
    const dump = getSession(db, args.id, {
      lanes,
      limit: options.limit,
      well: options.well,
      exact: options.exact,
    })
    return { ...dump.session, workDirs: dump.workDirs, lanes, count: dump.messages.length, messages: dump.messages }
  },
})

cli.command('trace', {
  description:
    'One session opened like a block (docs/EXPLORER.md): transactions (one turn and everything until the next), each with its steps (API requests), fee (four token classes + thinking, dated list-price `listUsd`), instructions (tool calls with the paired result\'s latency `ms` and `error` flag), the assistant\'s closing text, and wall time. Zero inference — every field is a transcript field or a join. Accepts a unique id prefix. `--steps` expands each transaction\'s requests (model, stop reason, per-request fee). Top level: `models` (what served the session, most requests first) and `spawns` (the fan-out ledger — agent type x verified model x output tokens); each transaction carries the `model` that served most of its steps. `kind` says who opened the turn — `prompt` (the user typed it), `command` (a slash command), `relay` (another SESSION sent it) or `meta` (a harness injection, which opened nothing). `prompt` is the message with the harness envelope taken off and `tag` names what was taken off: the peer for a relay, the injection kind (`task`, `stdout`, `image`, `skill`) for meta. The raw record stays in the index — `lore session --lane relay` still shows it whole. A turn also has an INBOUND half that did not open it: `received[]` is every message read WHILE the turn ran — a peer\'s message (`kind: relay`, `tag` the peer), the user\'s own words typed mid-turn (`kind: prompt`), a task notification (`kind: meta`) — placed at its position among the instructions (`at`), the way `sent[]` places the SendMessage calls; on a long turn most of a peer thread arrives this way. `sent[].agent` is set when the address was one of the session\'s own spawns (a subagent follow-up, not a relay).',
  args: z.object({
    id: z.string().describe('Session id or unique prefix (see the sessions listing or `usage --by session`)'),
  }),
  options: z.object({
    well: z.string().optional().describe('Narrow an ambiguous id prefix to wells whose dir or real path contains this substring'),
    exact: z.boolean().optional().describe('Match --well exactly instead of by substring'),
    steps: z.boolean().optional().describe('Expand each transaction\'s API requests'),
    head: z.coerce.number().default(160).describe('Characters kept of each prompt / input / result / reply'),
    limit: z.coerce.number().default(200).describe('Max transactions (totals cover the whole session)'),
  }),
  alias: { well: 'w', limit: 'n' },
  run: ({ args, options }) => {
    const db = openDb(DB_PATH)
    return getTrace(db, args.id, {
      well: options.well,
      exact: options.exact,
      steps: options.steps,
      head: options.head,
      limit: options.limit,
    })
  },
})

cli.command('thread', {
  description:
    'The thread between two agents: every message either sent the other, in order, with BOTH halves — the sender\'s SendMessage (session, turn, ack) and the receiver\'s copy (session, and the turn it opened or was read inside) — paired on the harness\'s own `msg_id` (the ack\'s id equals the receiver\'s `origin.msg_id`), never on prose. A side is a JOB, not a session: name it by its agent name (`lore`, `ccc` — the string `lore agents` prints and the other side\'s rows carry as `peer`) or by any session id of the job, which expands to the job through the bridge id across /clears and respawns. `landed` says what became of each message: `turn` (it opened one on the other side), `mid-turn` (read inside a running turn — most of a long thread arrives this way), `lost` (the ack refused it: a stale socket after the peer restarted; the harness does NOT flag this as a tool error), `unseen` (acked, but no receiver copy is indexed). `message` is the receiver\'s copy when the halves paired (stored whole) and the sender\'s otherwise (cut at index time). A row with `sent: null` is a copy whose sender session is not in the index. `totals` is per direction. This is the conversation view\'s data (docs/EXPLORER.md).',
  args: z.object({
    a: z.string().describe('One side: an agent name (`lore`) or a session id / unique prefix of the job'),
    b: z.string().describe('The other side, same forms'),
  }),
  options: z.object({
    head: z.coerce.number().default(400).describe('Characters kept of each message'),
    limit: z.coerce.number().optional().describe('Max rows (oldest first)'),
    agentsOnly: z.boolean().optional().describe('Leave out the user\'s own words. By default rows with `kind: you` carry what the user typed into either side\'s sessions while the thread ran (turns and mid-turn) — what each agent was answering'),
  }),
  alias: { limit: 'n' },
  run: ({ args, options }) => {
    const db = openDb(DB_PATH)
    return getThread(db, args.a, args.b, { head: options.head, limit: options.limit, you: !options.agentsOnly })
  },
})

// One refresh = every lane the index has (transcripts + history, spawns,
// workflow runs, jobs). `lore index` runs it once; `lore serve` runs it on a
// timer so the pages stop being "as of the last lore index".
async function refreshIndex(db: ReturnType<typeof openDb>, full?: boolean) {
  const stats = await buildIndex(db, { projectsDir: PROJECTS_DIR, historyPath: HISTORY_PATH, full })
  const spawns = await indexSpawns(db, { projectsDir: PROJECTS_DIR, full })
  const workflows = await indexWorkflowRuns(db, { projectsDir: PROJECTS_DIR, full })
  const jobs = await indexJobs(db, { claudeDir: CLAUDE_DIR })
  return { ...stats, spawns, workflows, jobs }
}

cli.command('index', {
  description:
    'Build or refresh the search index over transcripts, spawns, and workflow runs (incremental by mtime/size). This is the DETERMINISTIC read layer — it is NOT a wiki ingest, and `lore wiki` has no `index` verb: mining sources into wiki pages is a session-driven op that costs a subagent fan-out. Confusing the two has cost a round-trip twice.',
  options: z.object({
    full: z.boolean().optional().describe('Reindex everything, ignoring the incremental skip'),
  }),
  run: async (c) => {
    const db = openDb(DB_PATH)
    const result = await refreshIndex(db, c.options.full)
    return c.ok(result, {
      cta: {
        description: 'Next:',
        commands: [{ command: 'search', description: 'Search the index' }, 'stats'],
      },
    })
  },
})

cli.command('search', {
  description:
    'Full-text search across indexed sessions (FTS5 query syntax; plain terms with hyphens/apostrophes fall back to literal matching)',
  args: z.object({
    query: z.string().describe('FTS5 match expression, e.g. "sparkle notarization" or sparkle NEAR(key, 5); plain hyphenated terms like xcode-build-server work as-is'),
  }),
  options: z.object({
    lane: z
      .array(z.enum(LANES))
      .optional()
      .describe('Lanes to search (default: prompt, text). thinking/tool/event/meta/relay are opt-in — `relay` is the fleet\'s cross-session traffic'),
    well: z.string().optional().describe('Filter to wells whose dir or real path contains this substring'),
    exact: z
      .boolean()
      .optional()
      .describe('Match --well exactly instead of by substring (the ~/code root well is a prefix of every other well)'),
    limit: z.coerce.number().default(20).describe('Max results'),
    history: z.boolean().optional().describe('Also search history.jsonl (every prompt ever typed, survives retention)'),
  }),
  alias: { lane: 'l', well: 'w', limit: 'n' },
  run: ({ args, options }) => {
    const db = openDb(DB_PATH)
    const lanes = (options.lane ?? ['prompt', 'text']) as Lane[]
    const hits = searchMessages(db, args.query, { lanes, well: options.well, exact: options.exact, limit: options.limit })
    const history = options.history ? searchHistory(db, args.query, { limit: options.limit }) : undefined
    return { query: args.query, lanes, count: hits.length, hits, ...(history ? { history } : {}) }
  },
})

cli.command('spawns', {
  description:
    'The subagent observatory: per-spawn agentType, VERIFIED model (first-request JSONL — the spawn parameter and completion notification are never trusted), boot envelope + cache reuse, totals. Newest first, with per-agentType and per-week rollups (the trend: did a config change move boot cost). `telemetryPartial` marks a spawn whose transcript never reached a terminal stop_reason (in flight, or its final usage row never landed) — its token totals are a FLOOR, not a measurement; `partialTelemetry` counts them across all matches. An empty `--session` answer never stays silent: `sessionMiss` says what the id actually resolved to and which job-mate holds the spawns (a job id and a session id sit side by side in `lore agents`, and only the session id works here). Populated by `lore index`.',
  options: z.object({
    well: z.string().optional().describe('Filter to wells whose dir or real path contains this substring'),
    exact: z
      .boolean()
      .optional()
      .describe('Match --well exactly instead of by substring (the ~/code root well is a prefix of every other well)'),
    agent: z.string().optional().describe('Filter to this agentType (e.g. lore-miner, general-purpose)'),
    since: z.string().optional().describe('Only spawns on/after this ISO date (e.g. 2026-07-15)'),
    workflow: z
      .string()
      .optional()
      .describe('Only agents of one Workflow run — run id or prefix (see the workflows listing)'),
    session: z
      .string()
      .optional()
      .describe(
        'Only agents spawned by this SESSION — id or unique prefix (see the sessions listing). Not the job id `lore agents` prints as `id`: that resolves to the stub session a /clear left behind, which spawned nothing. An empty answer names the job-mate that holds the spawns.',
      ),
    limit: z.coerce.number().default(50).describe('Max spawn rows (the rollup always covers all matches)'),
  }),
  alias: { well: 'w', agent: 'a', limit: 'n' },
  run: (c) => {
    const db = openDb(DB_PATH)
    const { options } = c
    const { spawns, partialTelemetry, byAgentType, byWeek, sessionMiss } = listSpawns(db, {
      well: options.well,
      exact: options.exact,
      agent: options.agent,
      since: options.since,
      workflow: options.workflow,
      session: options.session,
      limit: options.limit,
    })
    const result = {
      count: spawns.length,
      partialTelemetry,
      byAgentType,
      byWeek,
      ...(sessionMiss ? { sessionMiss } : {}),
      spawns,
    }
    if (!sessionMiss) return result
    // Three empty answers, three different next moves — never the same silence.
    const sib = sessionMiss.siblings[0]
    if (sib)
      return c.ok(result, {
        cta: {
          description: `${short(sessionMiss.matched[0]?.sessionId ?? sessionMiss.asked)} spawned nothing, but ${short(sib.sessionId)} did — same background job (${short(sib.job)}), a /clear apart. --session wants the session id, not the job id:`,
          commands: sessionMiss.siblings.slice(0, 3).map((s) => ({
            command: 'spawns',
            options: { session: s.sessionId },
            description: `${s.spawns} spawn${s.spawns === 1 ? '' : 's'} (${s.lines} lines)`,
          })),
        },
      })
    if (sessionMiss.matched.length)
      return c.ok(result, {
        cta: {
          description: `${short(sessionMiss.matched[0]!.sessionId)} is indexed and really spawned nothing — no job-mate of it did either.`,
          commands: [{ command: 'trace', args: { id: sessionMiss.matched[0]!.sessionId }, description: 'What it did instead' }],
        },
      })
    return c.ok(result, {
      cta: {
        description: `No indexed session starts with "${sessionMiss.asked}" — the 0 is a miss, not a measurement.`,
        commands: [
          { command: 'sessions', description: 'The session ids the index actually holds' },
          { command: 'index', description: 'Refresh first if the session is newer than the last index' },
        ],
      },
    })
  },
})

cli.command('workflows', {
  description:
    'The workflow observatory: one row per Workflow orchestration run — name/description/phases self-described by the persisted script meta, agent count, output tokens, boot cache reuse, verified model mix and drift count joined from spawns. Newest first, plus the byName rollup (the catalog: which workflows exist, how often they run, what a run costs). Drill into one run with `spawns --workflow <runId>`. Populated by `lore index`.',
  options: z.object({
    well: z.string().optional().describe('Filter to wells whose dir or real path contains this substring'),
    exact: z
      .boolean()
      .optional()
      .describe('Match --well exactly instead of by substring (the ~/code root well is a prefix of every other well)'),
    name: z.string().optional().describe('Filter to runs whose workflow name contains this substring'),
    since: z.string().optional().describe('Only runs recorded on/after this ISO date (e.g. 2026-07-15)'),
    limit: z.coerce.number().default(25).describe('Max run rows (the rollup always covers all matches)'),
  }),
  alias: { well: 'w', limit: 'n' },
  run: ({ options }) => {
    const db = openDb(DB_PATH)
    const { runs, byName } = listWorkflowRuns(db, {
      well: options.well,
      exact: options.exact,
      name: options.name,
      since: options.since,
      limit: options.limit,
    })
    return { count: runs.length, byName, runs }
  },
})

cli.command('tools', {
  description:
    'Invocation usage counts — the evidence half of the ambient ROI ledger: how often each tool, MCP tool (mcp__…), skill (Skill:<name> via the Skill tool, command:<name> via slash invocation), was ACTUALLY used, over which wells and when. Score against the ambient roster to find zero-use items.',
  options: z.object({
    well: z.string().optional().describe('Filter to wells whose dir or real path contains this substring'),
    exact: z
      .boolean()
      .optional()
      .describe('Match --well exactly instead of by substring (the ~/code root well is a prefix of every other well)'),
    since: z.string().optional().describe('Only invocations on/after this ISO date (e.g. 2026-06-17)'),
    prefix: z
      .string()
      .optional()
      .describe('Only names starting with this prefix (e.g. mcp__, Skill:, command:, mcp__argent)'),
    limit: z.coerce.number().default(100).describe('Max rows'),
  }),
  alias: { well: 'w', prefix: 'p', limit: 'n' },
  run: ({ options }) => {
    const db = openDb(DB_PATH)
    const tools = listToolUsage(db, {
      well: options.well,
      exact: options.exact,
      since: options.since,
      prefix: options.prefix,
      limit: options.limit,
    })
    return { count: tools.length, tools }
  },
})

cli.command('usage', {
  description:
    'The token profile: where the tokens go — by well, session, model, day, week, or month — in the four billed classes (input, cacheWrite, cacheRead, output) plus thinking, with `listUsd`, a LIST-PRICE equivalent at dated first-party API rates (cache reads are priced per model AND date: Fable 5.1 cut them 75% on 2026-09-01). Not a bill — the fleet is on subscription OAuth; it is the exchange rate the usage limit is believed to track. Main-thread API requests only, deduped by message id; `spawns`/`spawnOutput` ride along on well/session rows from the subagent observatory (`lore spawns` for the detail). A model with no known rate is summed but listed in `unpriced`, never silently zero. Populated by `lore index`. Time buckets (`--by day|week|month`) and the `--since`/`--until` window are LOCAL days (the process TZ); the instants they filter, and the dated rates, are UTC. Drill: `lore usage --by session --well X`, then `lore session <id>`.',
  options: z.object({
    by: z.enum(GROUPINGS).default('well').describe('Grouping key (time groupings sort ascending and page from the newest end)'),
    well: z.string().optional().describe('Filter to wells whose dir or real path contains this substring'),
    exact: z
      .boolean()
      .optional()
      .describe('Match --well exactly instead of by substring (the ~/code root well is a prefix of every other well)'),
    session: z.string().optional().describe('Filter to one session id (or prefix) — the per-conversation profile'),
    model: z.string().optional().describe('Filter to models containing this substring (e.g. fable, opus-5, sonnet)'),
    since: z.string().optional().describe('Only requests on/after this ISO date (e.g. 2026-08-28)'),
    until: z.string().optional().describe('Only requests before this ISO date (exclusive)'),
    limit: z.coerce.number().default(50).describe('Max rows (totals cover every matching row, not just the page)'),
  }),
  alias: { by: 'b', well: 'w', session: 's', model: 'm', limit: 'n' },
  run: ({ options }) => {
    const db = openDb(DB_PATH)
    return listUsage(db, {
      by: options.by,
      well: options.well,
      exact: options.exact,
      session: options.session,
      model: options.model,
      since: options.since,
      until: options.until,
      limit: options.limit,
    })
  },
})

// The explorer (docs/EXPLORER.md): one hono app, three surfaces. `serve`
// binds the pages AND, on a 404, falls through to the CLI as a fetch handler
// (incur's `Bun.serve(cli)` shape — every read verb a route, spec at
// /openapi.json; writers blocked). `api` mounts the pages as CLI commands via
// incur's fetch mount, forcing JSON so agents get data, not markup. `server`
// is the launchd wrapper that keeps `serve` alive.
// The server refreshes the index itself (see `serve --refresh`); this holder
// is how the pages learn when that last happened.
const indexed: { at: string | null; busy: boolean; error: string | null } = { at: null, busy: false, error: null }
const web = createApp(() => openDb(DB_PATH), { build: BUILD_INFO, indexed })

cli.command('serve', {
  description:
    'Serve the explorer (docs/EXPLORER.md) in the foreground: / wells + spend, /usage the profile, /well/<dir> the arc spine with fees, /session/<id> one session as a block (transactions → steps, instructions, fee); every page answers JSON with ?json=1. Under /cli/ the read verbs are routes with the JSON envelope (GET /cli/usage?by=week, GET /cli/trace/<id>, spec at /cli/openapi.json); writers (archive, index, wiki commit…) are not exposed. `--host auto` binds the Tailscale address so the tailnet reaches http://<host>:<port>/ without binding the LAN; 0.0.0.0 when there is none. For always-on, use `lore server up`.',
  options: z.object({
    port: z.coerce.number().default(4949).describe('Port'),
    host: z.string().default('auto').describe('Bind address: auto (Tailscale IP, else 0.0.0.0), 127.0.0.1 (this machine only), or an address'),
    refresh: z.coerce
      .number()
      .default(5)
      .describe('Minutes between incremental index refreshes run by the server itself (0 = never; the pages then show the last `lore index`)'),
  }),
  alias: { port: 'p' },
  run: async ({ options }) => {
    const hostname = await resolveHost(options.host)
    const handler = composeHandler(web.fetch, (req) => cli.fetch(req))
    const server = Bun.serve({ hostname, port: options.port, fetch: handler })
    console.error(`lore serve ${BUILD_INFO} → http://${server.hostname}:${server.port}/`)
    // Incremental refresh in-process: sub-second when nothing changed, a few
    // seconds after a busy hour; the shared db's busy_timeout covers a CLI
    // `lore index` landing at the same moment. Never `full` — a schema bump
    // is a reinstall + restart, not something a timer should trigger.
    const refresh = async () => {
      if (indexed.busy) return
      indexed.busy = true
      try {
        await refreshIndex(openDb(DB_PATH))
        indexed.at = new Date().toISOString()
        indexed.error = null
      } catch (e) {
        indexed.error = e instanceof Error ? e.message : String(e)
        console.error(`lore serve: index refresh failed: ${indexed.error}`)
      } finally {
        indexed.busy = false
      }
    }
    if (options.refresh > 0) {
      await refresh()
      setInterval(refresh, options.refresh * 60_000)
    }
    await new Promise<never>(() => {})
  },
})

const serverCli = Cli.create('server', {
  description:
    'The always-on explorer as a launchd user agent (KeepAlive; logs under ~/.lore): up writes ~/Library/LaunchAgents/com.ramonfabrega.lore.plist and bootstraps it, down boots it out, restart kickstarts it, status compares the RUNNING build (the server\'s /_lore) with the installed bin — a frozen bundle does not follow scripts/install.ts, so status says "restart owed" — and logs tails stdout/stderr.',
})
serverCli.command('up', {
  description: 'Write the plist and bootstrap the agent (re-bootstraps if already loaded, so a changed port/host takes)',
  options: z.object({
    port: z.coerce.number().default(4949).describe('Port'),
    host: z.string().default('auto').describe('Bind address: auto (Tailscale IP, else 0.0.0.0), 127.0.0.1, or an address — resolved once, written into the plist'),
  }),
  run: async ({ options }) => serverUp({ port: options.port, host: await resolveHost(options.host) }),
})
serverCli.command('down', { description: 'Boot the agent out (the plist stays; `up` reloads it)', run: () => serverDown() })
serverCli.command('restart', { description: 'Kickstart the agent — after scripts/install.ts, or when status says restart owed', run: () => serverRestart() })
serverCli.command('status', {
  description: 'launchd state, the URL, the running build vs the installed bin, and warnings (not loaded, not answering, restart owed)',
  run: () => serverStatus({ installedBuild: BUILD_INFO }),
})
serverCli.command('logs', {
  description: 'Tail the agent\'s stdout and stderr (~/.lore/serve.log, serve.err)',
  options: z.object({ lines: z.coerce.number().default(40).describe('Lines from the end of each') }),
  alias: { lines: 'n' },
  run: ({ options }) => serverLogs(options.lines),
})
cli.command(serverCli)

cli.command('api', {
  description:
    'The explorer\'s routes as commands (agent surface of `lore serve`), path segments as arguments: `lore api usage`, `lore api well <dir>`, `lore api session <id-prefix>` (a leading-slash path 404s — segments, not a URL). Same data the pages render, as JSON.',
  fetch: (req: Request) => {
    const url = new URL(req.url)
    url.searchParams.set('json', '1')
    return web.fetch(new Request(url.toString(), req))
  },
})

cli.command('agents', {
  description:
    'The live roster joined to the index: what `claude agents --json --all` lists (state, name, cwd, waitingFor) + each job\'s state.json (detail, tempo, LIVE tokens, links, worktree branch) + lore\'s side per session (well, requests, list $, last indexed activity — as of the last `lore index`). Active (working/blocked) first, then by last update. Attach is a command to copy, never done for you. Each row names its `model`: for a live agent (working/blocked) read from the transcript\'s last assistant record and marked `modelSource: transcript`, otherwise the session\'s dominant model as of the last index (`modelSource: index`) — neither the daemon listing nor state.json carries a model at all. The agents page of the explorer is this verb rendered.',
  run: async () => {
    const db = openDb(DB_PATH)
    const agents = await listAgents(db)
    return { count: agents.length, active: agents.filter((a) => a.state === 'working' || a.state === 'blocked').length, agents }
  },
})

cli.command('stats', {
  description:
    'Index statistics: lanes, wells, date range, and `peers` — who has sent this fleet cross-session messages (the relay lane), how many, over what span.',
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
        requests: z.number(),
        jobs: z.number(),
      })
      .parse(
        db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM messages) AS messages,
                    (SELECT COUNT(*) FROM history) AS historyRows,
                    (SELECT COUNT(*) FROM repos) AS repos, (SELECT COUNT(*) FROM docs) AS docs,
                    (SELECT COUNT(*) FROM requests) AS requests,
                    (SELECT COUNT(*) FROM jobs) AS jobs`,
          )
          .get(),
      )
    // A corpus reading zero is almost never real — it means an indexer never
    // ran for it. `lore index` does NOT populate the docs corpus (`lore docs
    // index` is its own command), so a SCHEMA_VERSION bump's drop-and-rebuild
    // silently empties docs until someone notices canon lint has gone blind
    // (observed 2026-07-24, empty since the v9 bump). Rebuild-beats-migrate is
    // supposed to make a wipe cheap, not invisible — so say it out loud.
    const warnings: string[] = []
    if (totals.docs === 0 || totals.repos === 0) {
      warnings.push('docs corpus is EMPTY — canon lint and graduation dedup are blind. Run `lore docs index`.')
    }
    if (totals.sessions === 0) warnings.push('no sessions indexed — run `lore index`.')
    // Who has sent this fleet a cross-session message, and when — the routing
    // ledger the wiki keeps by hand, mechanized. Sessions, not people: a peer
    // name is whatever the sending session called itself.
    const peers = z
      .array(z.object({ peer: z.string(), messages: z.number(), sessions: z.number(), first: z.string().nullable(), last: z.string().nullable() }))
      .parse(
        db
          .prepare(
            `SELECT peer, COUNT(*) AS messages, COUNT(DISTINCT session_id) AS sessions,
                    MIN(ts) AS first, MAX(ts) AS last
             FROM messages WHERE lane = 'relay' AND peer IS NOT NULL
             GROUP BY peer ORDER BY messages DESC`,
          )
          .all(),
      )
    return { totals, ...(warnings.length ? { warnings } : {}), range, lanes, ...(peers.length ? { peers } : {}), topWells: wells }
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

wiki.command('init', {
  description:
    'Create a wiki from the built-in template (the maintainer schema as CLAUDE.md, an empty index and log, projects/ and patterns/) and make its first commit. Default location is LORE_WIKI_DIR; refuses a non-empty directory. Run once, then drive ingests from a Claude Code session — the schema tells the session how.',
  args: z.object({
    dir: z.string().optional().describe('Where to create the wiki (default: LORE_WIKI_DIR)'),
  }),
  run: async ({ args }) => wikiInit(args.dir ?? WIKI_DIR),
})

cli.command(wiki)

const docs = Cli.create('docs', {
  description:
    'The canon corpus: git-committed .md files across the repos under ~/code, read from git objects (husk repos keep canon only at origin — the working tree is never trusted)',
})

docs.command('index', {
  description:
    'Scan repos and index their canon .md files (incremental by commit sha; prunes gone repos). Ownership is auto-detected per repo: foreign (`upstream` remote — a fork, docs skipped), assisted (zero commits under the user identity — indexed but flagged: not the user\'s doctrine), mine. Overrides: LORE_DOCS_EXCLUDE skips repos entirely, LORE_DOCS_ASSISTED force-flags.',
  options: z.object({
    full: z.boolean().optional().describe('Reindex every repo, ignoring the commit-sha skip'),
    fetch: z
      .boolean()
      .optional()
      .describe(
        'Run `git fetch origin` in each repo first. Canon detection is a ref-diff and origin refs only move when something fetches — without this, upstream merges stay invisible to every re-index. Offline-safe: fetch failures degrade to stale refs.',
      ),
  }),
  run: async (c) => {
    const db = openDb(DB_PATH)
    const stats = await indexDocs(db, {
      codeDir: CODE_DIR,
      exclude: [WIKI_DIR, ...DOCS_EXCLUDE],
      assisted: DOCS_ASSISTED,
      full: c.options.full,
      fetch: c.options.fetch,
    })
    return c.ok(stats, {
      cta: {
        description: 'Next:',
        commands: [{ command: 'docs search', description: 'Search the canon corpus' }, 'docs list'],
      },
    })
  },
})

docs.command('search', {
  description:
    'Full-text search across indexed canon docs (FTS5 query syntax; plain terms with hyphens/apostrophes fall back to literal matching) — lint fodder and graduation dedup ("does canon already say this?"). Hits carry ownership: treat `assisted` hits as someone else\'s doctrine — context only, never user provenance.',
  args: z.object({
    query: z.string().describe('FTS5 match expression; plain hyphenated terms work as-is'),
  }),
  options: z.object({
    repo: z.string().optional().describe('Filter to repos whose path contains this substring'),
    limit: z.coerce.number().default(20).describe('Max results'),
  }),
  alias: { repo: 'r', limit: 'n' },
  run: ({ args, options }) => {
    const db = openDb(DB_PATH)
    const hits = searchDocs(db, args.query, { repo: options.repo, limit: options.limit })
    return { query: args.query, count: hits.length, hits }
  },
})

docs.command('list', {
  description: 'List indexed repos: ref canon was read from, commit, doc count, husk flag, ownership',
  options: z.object({
    husks: z.boolean().optional().describe('Only husk repos (canon exists solely in git objects at origin)'),
    ownership: z
      .enum(['mine', 'assisted', 'foreign'])
      .optional()
      .describe('Only repos with this ownership (assisted/foreign canon is not the user\'s doctrine)'),
  }),
  run: ({ options }) => {
    const db = openDb(DB_PATH)
    let repos = listIndexedRepos(db)
    if (options.husks) repos = repos.filter((r) => r.isHusk)
    if (options.ownership) repos = repos.filter((r) => r.ownership === options.ownership)
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
