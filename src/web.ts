import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { type AgentRow, listAgents } from './agents'
import { TZ, WIKI_DIR } from './config'
import { JOB_KEY_SQL, type JobKind, type JobRow, jobNames, jobsOfSessions, listJobs, resolveJob } from './job'
import type { Lane } from './parse'
import { FAMILIES, type ModelFamily, modelFamily } from './model'
import { searchSessions } from './search'
import { resolveSessionId } from './session'
import { listSessions, modelsFor } from './sessions'
import { annotationLine, sessionBody, tile } from './block'
import { cut, day, dayName, stamp, tok, todayLocal, usd } from './fmt'
import LORE_SVG from '../assets/lore.svg' with { type: 'text' }
import { CSS, tick } from './style'
import { bars, clockEl, feeBar, feeLegend, ibar, modelChip, modelChips, spanEl, spark, stackedBars, timeEl } from './viz'
import { getThread, listThreads } from './thread'
import { threadBody, threadsBody } from './threadview'
import { getTrace } from './trace'
import { listUsage, type UsageRow } from './usage'

// The mark, inlined as a data URI: the frozen bin is one file, so the icon
// rides the bundle rather than owing a route or a disk read per page.
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(LORE_SVG)

// The explorer's web surface (docs/EXPLORER.md): thin pages over the same
// verbs the CLI runs — `usage`, `sessions`, `trace` — server-rendered, no
// build step, no client framework. Every route answers JSON when asked
// (`?json=1` or an Accept header), which is how incur's `fetch` mount turns
// the same routes into `lore api …` for agents. One definition, two surfaces.
//
// Charts: single-series sparklines and bars only, so no legend is owed (the
// title names the series); one hue from the reference palette (series-1
// blue, stepped for dark), 2px lines, 2px surface gaps, per-mark <title>
// tooltips. Numbers wear text ink, never the series color.
//
// Model attribution (model.ts) runs through every listing that names a
// conversation — recent, a well's sessions, a search hit, the roster — as
// one chip: family hue, short label, full id in the title. The stacked
// charts stack by the same families, so a band and a chip of the same
// colour mean the same model wherever they appear.

type Db = () => Database

// The read verbs the server lets through to `cli.fetch` (docs/EXPLORER.md).
// The CLI as a fetch handler exposes EVERY verb — archive, index, docs index,
// wiki commit, serve itself — and over the tailnet that is a footgun, so the
// fall-through is GET-only against this list. `docs` is split by subcommand.
const READ_VERBS = new Set(['wells', 'sessions', 'session', 'trace', 'usage', 'search', 'spawns', 'workflows', 'tools', 'stats', 'agents', 'jobs'])
const READ_DOCS = new Set(['search', 'list'])
const SPEC_PATHS = new Set(['/openapi.json', '/openapi.yml', '/openapi.yaml', '/.well-known/openapi.json'])

// The CLI lives under /cli/ because the pages own the root and their names
// collide with verbs (/usage, /session): GET /cli/usage?by=week is
// `lore usage --by week`, GET /cli/trace/<id> is `lore trace <id>`, the spec
// is /cli/openapi.json. The prefix is stripped before the CLI sees the path.
export const CLI_PREFIX = '/cli'

export function allowsFallthrough(req: Request): boolean {
  if (req.method !== 'GET') return false
  const path = new URL(req.url).pathname
  if (!path.startsWith(`${CLI_PREFIX}/`)) return false
  const inner = path.slice(CLI_PREFIX.length)
  if (SPEC_PATHS.has(inner)) return true
  const [verb = '', sub = ''] = inner.split('/').filter(Boolean)
  if (verb === 'docs') return READ_DOCS.has(sub)
  return READ_VERBS.has(verb)
}

// Pages for everything outside /cli/; under it, a GET for a read verb goes
// to the CLI as a fetch handler (incur's `Bun.serve(cli)` shape) — every
// verb a route with the JSON envelope. Anything else under /cli/ is 404.
export function composeHandler(pages: (req: Request) => Response | Promise<Response>, cli: (req: Request) => Response | Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (!url.pathname.startsWith(`${CLI_PREFIX}/`)) return pages(req)
    if (!allowsFallthrough(req)) return new Response('404 Not Found', { status: 404 })
    url.pathname = url.pathname.slice(CLI_PREFIX.length)
    return cli(new Request(url.toString(), req))
  }
}

export type Indexed = { at: string | null; busy: boolean; error: string | null }

export function createApp(
  getDb: Db,
  opts: { build?: string; agents?: (db: Database) => Promise<AgentRow[]>; wikiDir?: string; indexed?: Indexed } = {},
) {
  const app = new Hono()
  const startedAt = new Date().toISOString()
  const agents = opts.agents ?? listAgents
  const wikiDir = opts.wikiDir ?? WIKI_DIR
  const indexed = opts.indexed ?? { at: null, busy: false, error: null }
  const chrome = (c?: { req: { query: (k: string) => string | undefined } }) => ({ indexedAt: indexed.at, indexError: indexed.error, theme: c?.req.query('theme') ?? null })

  // In-process memo for the two slow things a page does: the whole-corpus
  // usage aggregates (~150 ms each; keyed on the index's timestamp, so a
  // refresh invalidates) and the daemon roster (~250 ms shell-out; 10 s).
  const memo = new Map<string, { at: number; key: string; value: unknown }>()
  const cached = <T,>(name: string, ttlMs: number, key: string, f: () => T): T => {
    const hit = memo.get(name)
    if (hit && hit.key === key && Date.now() - hit.at < ttlMs) return hit.value as T
    const value = f()
    memo.set(name, { at: Date.now(), key, value })
    return value
  }
  const indexKey = () => indexed.at ?? 'none'
  const roster = () => cached('roster', 10_000, 'live', () => agents(getDb()))

  // A commit trailer's id → its transcript. `/s/session_X`, `/s/cse_X`, a
  // bare suffix, or a transcript uuid prefix all land on /session/<uuid>.
  app.get('/s/:id', (c) => {
    const db = getDb()
    let target: string | null = null
    try {
      target = resolveSessionId(db, c.req.param('id'), {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return c.text(`${msg}\n\n(interactive sessions write no jobs/<id>/state.json, so their trailers cannot resolve — only background jobs can)`, 404)
    }
    return c.redirect(`/session/${target}`, 302)
  })

  app.get('/search', (c) => {
    const db = getDb()
    const q = c.req.query('q') ?? ''
    const lanes = (c.req.query('lanes') ?? 'prompt,text').split(',').filter(Boolean) as Lane[]
    const sort = c.req.query('sort') === 'recent' ? 'recent' : 'rank'
    const well = c.req.query('well') || undefined
    let result: ReturnType<typeof searchSessions> | null = null
    let error: string | null = null
    if (q.trim()) {
      try {
        result = searchSessions(db, q, { lanes, well, limit: 30, sort })
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
    }
    const models: Map<string, { model: string; requests: number }[]> = result ? modelsFor(db, result.sessions.map((x) => x.sessionId)) : new Map()
    const data = {
      q,
      lanes,
      sort,
      well: well ?? null,
      error,
      ...(result ? { ...result, sessions: result.sessions.map((x) => ({ ...x, models: models.get(x.sessionId) ?? [] })) } : { query: '', sessions: [], hits: 0 }),
    }
    if (wantsJson(c.req.raw)) return c.json(data)
    const laneOpt = (v: string, label: string) => html`<label><input type="radio" name="lanes" value="${v}" ${lanes.join(',') === v ? 'checked' : ''}> ${label}</label>`
    const body = html`
      <h1>search</h1>
      <form method="get" action="/search" class="searchform">
        <input type="search" name="q" value="${q}" placeholder="FTS5: words, &quot;a phrase&quot;, prefix*, AND / OR / NOT" autofocus />
        <button type="submit">search</button>
        <span class="muted small">
          ${laneOpt('prompt,text', 'conversation')} ${laneOpt('prompt,text,tool', '+ tools')} ${laneOpt('relay', 'relays')} ${laneOpt('prompt,text,thinking,tool,relay', 'everything')}
          · <label><input type="checkbox" name="sort" value="recent" ${sort === 'recent' ? 'checked' : ''}> newest first</label>
          ${well ? html`· well <input type="text" name="well" value="${well}" size="14" />` : html`<input type="hidden" name="well" value="" />`}
        </span>
      </form>
      ${error ? html`<p class="kind err">${error}</p>` : ''}
      ${result
        ? html`<p class="muted">${result.sessions.length} sessions from ${result.hits} hits${result.hits >= 400 ? ' (top 400 shown — narrow the query)' : ''} · query <span class="mono">${result.query}</span></p>
            ${result.sessions.map(
              (s) => html`<div class="hit">
                <div>
                  <a class="mono" href="/session/${s.sessionId}">${s.sessionId.slice(0, 8)}</a>
                  <a class="mono" href="/well/${encodeURIComponent(s.well)}">${shortWell(s.well)}</a>
                  ${modelChips(models.get(s.sessionId), { max: 2 })}
                  <span class="muted mono">${dayName(s.first)}${s.last !== s.first ? html` → ${dayName(s.last)}` : ''}</span>
                  <span class="muted">${s.hits} hit${s.hits === 1 ? '' : 's'}</span>
                </div>
                <div class="prompt">${s.firstPrompt ? opener(s) : ''}</div>
                ${s.snippets.map(
                  (sn) => html`<div class="snippet"><span class="kind">${sn.lane}</span> <a href="/session/${s.sessionId}${sn.promptId ? `#tx-${sn.promptId}` : ''}">${raw(markSnippet(sn.snippet))}</a></div>`,
                )}
              </div>`,
            )}`
        : html`<p class="muted">Sessions ranked by their best hit, then hit count, then recency. A half-typed last word matches as a prefix. FTS5 syntax passes through.</p>`}`
    return c.html(page(q ? `${q} · search · lore` : 'search · lore', body, { q, ...chrome(c), nav: 'search' }))
  })

  // Every job, live first (docs/EXPLORER.md, Agents). The daemon's roster
  // says what is running NOW — state, detail, live tokens, attach — and the
  // index's jobs (job.ts) say everything the fleet has ever run, the deleted
  // ones included: a row is a job, decorated with the roster when the daemon
  // still lists it. `?all=1` adds interactive sessions as one-session jobs.
  app.get('/agents', async (c) => {
    const db = getDb()
    let live: AgentRow[] = []
    let error: string | null = null
    try {
      live = await roster()
    } catch (e) {
      memo.delete('roster')
      error = e instanceof Error ? e.message : String(e)
    }
    const all = c.req.query('all') === '1'
    const jobs = listJobs(db, { all, limit: 2000 })
    const refs = jobsOfSessions(db, live.flatMap((a) => (a.sessionId ? [a.sessionId] : [])))
    const rows = mergeAgents(jobs, live, (sid) => refs.get(sid)?.key ?? null)
    const data = { count: rows.length, live: live.length, agents: live, jobs, error }
    if (wantsJson(c.req.raw)) return c.json(data)
    const maxLive = Math.max(...live.map((a) => a.liveTokens ?? 0), 0)
    const maxUsd = Math.max(...jobs.map((j) => j.listUsd ?? 0), 0)
    const counts = new Map<string, number>()
    for (const a of live) counts.set(a.state, (counts.get(a.state) ?? 0) + 1)
    const body = html`
      <div class="panel">
        <header><h2>agents</h2><span>${[...counts].map(([st, n]) => html`<span class="kind st-${st}">${n} ${st}</span> `)} · ${jobs.length} jobs${
          all ? html` · <a href="/agents">background only</a>` : html` · <a href="/agents?all=1" title="interactive sessions as one-session jobs">+ interactive</a>`
        }</span>
          <span class="sp small">a row is a JOB — an agent across /clears and respawns, keyed on its bridge id · the daemon's roster for what runs now · a deleted job keeps the name its peers gave it · attach in a terminal</span></header>
        ${error ? html`<p class="footnote err">${error}</p>` : ''}
        <div class="scroll list jobsall">
          <div class="row head"><span>state</span><span>name</span><span>model</span><span>where</span><span>doing</span><span class="num">live tokens</span><span class="num">sess</span><span class="num">req</span><span class="num">list $</span><span>last</span><span>peers</span><span>attach</span></div>
          ${rows.map((r) => agentRow(r, maxLive, maxUsd))}
        </div>
      </div>`
    return c.html(page('agents · lore', body, { ...chrome(c), layout: 'one', nav: 'agents', bare: true }))
  })

  // One job (docs/EXPLORER.md, Job): the agent over time. The url takes
  // anything that names it — a bridge id in any spelling, the root an older
  // link carried, the daemon's id, a session id, the agent's name — and the
  // page is the same. A months-long job is a timeline, so its sessions are
  // bucketed by local day, newest first, and a respawn (a new root under the
  // same bridge) is marked where it happened. Flat: a job is not a tree of
  // incarnations of sessions of turns.
  app.get('/job/:id', (c) => {
    const db = getDb()
    const id = c.req.param('id')
    const ref = resolveJob(db, id)
    const job = ref ? listJobs(db, { key: ref.key, limit: 1 })[0] : undefined
    if (!ref || !job) return c.notFound()
    const members = z
      .array(z.object({ sessionId: z.string(), root: z.string().nullable() }))
      .parse(db.prepare(`SELECT s.session_id AS sessionId, s.job_session_id AS root FROM sessions s WHERE ${JOB_KEY_SQL} = ? ORDER BY s.first_ts, s.session_id`).all(ref.key))
    const ids = members.map((m) => m.sessionId)
    const rootOf = new Map(members.map((m) => [m.sessionId, m.root]))
    const fee = new Map(listUsage(db, { by: 'session', sessions: ids, limit: 10000 }).rows.map((r) => [r.key, r]))
    // Oldest first here, to see the root change; rendered newest first.
    let prevRoot: string | null = null
    const sessions = listSessions(db, { sessions: ids, limit: ids.length }).map((s) => {
      const root = rootOf.get(s.sessionId) ?? null
      const respawn = root != null && prevRoot != null && root !== prevRoot
      if (root != null) prevRoot = root
      return { ...s, root, respawn, usage: fee.get(s.sessionId) ?? null }
    })
    const data = { job, sessions }
    if (wantsJson(c.req.raw)) return c.json(data)
    const today = todayLocal()
    const maxUsd = Math.max(...sessions.map((s) => s.usage?.listUsd ?? 0), 0)
    const days = new Map<string, typeof sessions>()
    for (const s of sessions.slice().reverse()) {
      const d = s.first ?? '?'
      days.set(d, [...(days.get(d) ?? []), s])
    }
    const kindText = { bridge: 'bridge id · the key that survives /clear and a daemon respawn', root: 'root id · a pre-bridge job, one incarnation', session: 'interactive session · a job of one' }[job.kind]
    const title = job.name ? `@${job.name}` : job.key.slice(0, 8)
    const body = html`
      <div class="page-head">
        <p class="crumbs"><a href="/">lore</a> / <a href="/agents">agents</a> / job</p>
        <h1 class="mono">${job.name ? html`<span class="kind side-a">@${job.name}</span> ` : ''}<span class="muted" title="${kindText}">${job.key}</span></h1>
        <p class="muted">${kindText}${job.nameSource === 'peer' ? html` · <span class="kind peer" title="the daemon has forgotten this job; its peers called it this">named by its peers</span>` : ''}${
          job.jobId ? html` · daemon ${job.jobId} · <span class="kind st-${job.state ?? ''}">${job.state ?? '?'}</span> as of the last index` : job.kind === 'session' ? '' : ' · not at the daemon'
        }
          · ${spanEl(job.first, job.last)} · in ${job.wells.map((w, i) => html`${i ? ', ' : ''}<a class="mono" href="/well/${encodeURIComponent(w)}" title="${w}">${shortWell(w)}</a>`)}
          ${job.models.map((m) => html` · ${modelChip(m.model)} <span class="muted">×${m.requests}</span>`)}${
            job.peers.length ? html` · thread with ${job.peers.map((p, i) => html`${i ? ', ' : ''}<a href="/thread/${encodeURIComponent(job.name ?? job.key)}/${encodeURIComponent(p)}">@${p}</a>`)}` : ''
          }</p>
        <div class="tiles">
          ${tile('sessions', String(job.sessions))}
          ${tile(html`<span title="distinct roots under the bridge: one per daemon respawn">incarnations</span>`, String(job.incarnations))}
          ${tile('requests', job.requests.toLocaleString())}
          ${tile('output', tok(job.output))}
          ${tile('list $', usd(job.listUsd))}
          ${tile('lines', job.lines.toLocaleString())}
        </div>
      </div>
      <div class="panel"><div class="scroll list jobsess">
        <div class="row head"><span title="when the session began — these rows are grouped under the day they started">started</span><span>well</span><span>model</span><span>opening</span><span class="num">turns</span><span class="num">req</span><span class="num">out</span><span class="num">list $</span></div>
        ${[...days].map(
          ([d, ss]) => html`<div class="row day"><span>${dayName(d)}${d === today ? ' · today' : ''}</span><span>${ss.length} session${ss.length === 1 ? '' : 's'}</span><span class="sp">${usd(ss.reduce((n, s) => n + (s.usage?.listUsd ?? 0), 0))}</span></div>
          ${ss.map(
            (s) => html`<div class="row">
              <span class="mono"><a href="/session/${s.sessionId}">${clockEl(s.firstAt)}</a></span>
              <span class="mono"><a href="/well/${encodeURIComponent(s.well)}" title="${s.well}">${shortWell(s.well)}</a></span>
              <span>${modelChips(s.models)}</span>
              <span title="${s.firstPrompt ?? ''}">${s.respawn ? html`<span class="kind respawn" title="a new root: the daemon respawned the job here (${s.root ?? ''})">respawn</span>` : ''}${opener(s)}</span>
              <span class="num">${s.prompts || ''}</span>
              <span class="num">${s.usage?.requests ?? ''}</span>
              <span class="num">${s.usage ? tok(s.usage.output) : ''}</span>
              <span class="num">${s.usage?.listUsd ? html`${ibar(s.usage.listUsd, maxUsd, { of: 'priciest session in this job' })}${usd(s.usage.listUsd)}` : ''}</span>
            </div>`,
          )}`,
        )}
      </div></div>`
    return c.html(page(`${title} · job · lore`, body, { ...chrome(c), layout: 'head', nav: 'agents' }))
  })

  // Liveness + provenance for `lore server status`.
  app.get('/_lore', (c) => c.json({ ok: true, build: opts.build ?? 'dev', pid: process.pid, startedAt, indexed }))

  // The control room: what is happening now (agents), what happened last
  // (recent, by last activity), where this week's spend went (active
  // wells), and the 45-day shape by model. Everything windowed so the
  // whole-corpus aggregates never run here.
  app.get('/', async (c) => {
    const db = getDb()
    // The front page's windows are LOCAL days — "today" is the day you are
    // having, not the one Greenwich is. `listUsage` turns each back into the
    // UTC instant of local midnight, so the window and its buckets agree.
    const today = todayLocal()
    const weekAgo = isoDay(Date.now() - 7 * 86_400_000)
    const since45 = isoDay(Date.now() - 45 * 86_400_000)
    // 100 sessions fold into a few dozen jobs (a busy job /clears a dozen
    // times a day); the window is sized for the rows that survive folding.
    const recentSessions = listSessions(db, { limit: 100, byActivity: true }).reverse()
    const feeById = new Map(
      listUsage(db, { by: 'session', sessions: recentSessions.map((s) => s.sessionId), limit: 200 }).rows.map((r) => [r.key, r]),
    )
    // Harness-only sessions (no prompt, no request) are noise here.
    const recentRows = recentSessions.map((s) => ({ ...s, usage: feeById.get(s.sessionId) ?? null })).filter((s) => s.prompts > 0 || s.usage)
    // Grouped by JOB (job.ts): a job /cleared five times today is one row,
    // headed by its newest session, not five. An interactive session is
    // its own job and reads exactly as before.
    const recent = groupRecent(recentRows, jobsOfSessions(db, recentRows.map((s) => s.sessionId)), jobNames(db))
    const active = listUsage(db, { by: 'well', since: weekAgo, limit: 40 })
    const todayU = listUsage(db, { by: 'day', since: today, limit: 2 })
    const days = listUsage(db, { by: 'day', since: since45, limit: 60, split: true })
    let live: AgentRow[] = []
    let agentsError: string | null = null
    try {
      live = await roster()
    } catch (e) {
      memo.delete('roster')
      agentsError = e instanceof Error ? e.message : String(e)
    }
    const liveRefs = jobsOfSessions(db, live.flatMap((a) => (a.sessionId ? [a.sessionId] : [])))
    const data = { today: todayU.totals, week: active.totals, recent, active: active.rows, days: days.rows, agents: live, agentsError }
    if (wantsJson(c.req.raw)) return c.json(data)

    const working = live.filter((a) => a.state === 'working').length
    const blocked = live.filter((a) => a.state === 'blocked').length
    const maxRecent = Math.max(...recent.map((s) => s.usage?.listUsd ?? 0), 0)
    const maxActive = Math.max(...active.rows.map((r) => r.listUsd ?? 0), 0)
    const maxLive = Math.max(...live.map((a) => a.liveTokens ?? 0), 0)
    // The stat tiles' sparklines: the last 14 days, oldest first.
    const byDay = days.rows.slice().sort((a, b) => (a.key < b.key ? -1 : 1)).slice(-14)
    const body = html`
      <div class="area-kpi kpis">
        ${stat('today', usd(todayU.totals.listUsd), byDay, (d) => d.listUsd ?? 0, usd)}
        ${stat('this week', usd(active.totals.listUsd), byDay, (d) => d.listUsd ?? 0, usd)}
        ${stat('requests · wk', active.totals.requests.toLocaleString(), byDay, (d) => d.requests, (v) => v.toLocaleString())}
        ${stat('sessions · wk', String(active.totals.sessions), byDay, (d) => d.sessions, String)}
        ${stat('out · wk', tok(active.totals.output), byDay, (d) => d.output, tok)}
        <div class="tile stat ${working ? 'good' : ''}">
          <div><div class="v">${working + blocked}</div><div class="l">agents</div></div>
          <div class="l states"><span><span class="dot st-working"></span>${working} working</span>${blocked ? html`<span class="warn"><span class="dot st-blocked"></span>${blocked} blocked</span>` : ''}</div>
        </div>
      </div>
      <div class="area-chart panel">
        <header><h2>by day</h2><span class="sub">last 45, list $ by model</span>${modelLegend(days.rows)}</header>
        <div class="body">${bucketChart(days.rows)}</div>
      </div>
      <div class="area-recent panel">
        <header><h2>recent</h2><span>newest by last activity</span><span class="sp small"><a href="/search">search →</a></span></header>
        <div class="scroll list recent">
          <div class="row head"><span title="the newest activity in the job — what this list is sorted by">last</span><span>who · where</span><span>model</span><span>opening</span><span class="num hide">pr</span><span class="num hide">req</span><span class="num hide">out</span><span class="num">list $</span></div>
          ${recent.map(
            (s) => html`<div class="row">
              <span class="mono"><a href="/session/${s.sessionId}">${timeEl(s.lastAt)}</a></span>
              <span class="mono" title="${s.well}${s.sessions > 1 ? ` · ${s.sessions} sessions in this window` : ''}">${
                s.name ? html`<a href="/job/${encodeURIComponent(s.key)}">@${s.name}</a>` : html`<a href="/well/${encodeURIComponent(s.well)}">${shortWell(s.well)}</a>`
              }${s.sessions > 1 ? html` <span class="kind">×${s.sessions}</span>` : ''}</span>
              <span>${modelChips(s.models)}</span>
              <span title="${s.firstPrompt ?? ''}">${opener(s)}</span>
              <span class="num hide">${s.prompts || ''}</span>
              <span class="num hide">${s.usage?.requests ?? ''}</span>
              <span class="num hide">${s.usage ? tok(s.usage.output) : ''}</span>
              <span class="num">${s.usage?.listUsd ? html`${ibar(s.usage.listUsd, maxRecent, { of: 'priciest session listed' })}${usd(s.usage.listUsd)}` : ''}</span>
            </div>`,
          )}
        </div>
      </div>
      <div class="area-agents panel">
        <header><h2>agents</h2><span>${working} working${blocked ? html` · <span class="kind st-blocked">${blocked} blocked</span>` : ''}</span><span class="sp small"><a href="/agents">roster →</a></span></header>
        ${agentsError ? html`<p class="footnote err">${agentsError}</p>` : ''}
        <div class="scroll list agents">
          ${live.slice(0, 14).map(
            (a) => html`<div class="row ${a.state}" title="${a.state}${a.tempo ? ` · ${a.tempo}` : ''}${a.waitingFor ? ` · ${a.waitingFor}` : ''} · ${a.cwd}">
              <span class="dot st-${a.state}"></span>
              <span>${(() => {
                const label = a.name ?? shortPath(a.cwd)
                const ref = a.sessionId ? liveRefs.get(a.sessionId) : undefined
                return ref ? html`<a href="/job/${encodeURIComponent(ref.key)}">${label}</a>` : a.sessionId && a.indexed ? html`<a href="/session/${a.sessionId}">${label}</a>` : label
              })()}</span>
              <span>${modelChip(a.model, { title: modelTitle(a) })}</span>
              <span class="muted">${a.detail ?? ''}</span>
              <span class="num">${a.liveTokens != null ? html`${ibar(a.liveTokens, maxLive, { of: 'largest live context here', fmt: tok })}${tok(a.liveTokens)}` : ''}</span>
              <span class="num">${a.indexed ? usd(a.indexed.listUsd) : ''}</span>
            </div>`,
          )}
        </div>
      </div>
      <div class="area-active panel">
        <header><h2>active this week</h2><span>since ${weekAgo}</span><span class="sp small"><a href="/usage">usage →</a></span></header>
        <div class="scroll list active">
          <div class="row head"><span>well</span><span class="num">sess</span><span class="num">req</span><span class="num">list $</span></div>
          ${active.rows.map(
            (r) => html`<div class="row">
              <span class="mono"><a href="/well/${encodeURIComponent(r.key)}" title="${r.key}">${shortWell(r.key)}</a></span>
              <span class="num">${r.sessions}</span>
              <span class="num">${r.requests.toLocaleString()}</span>
              <span class="num">${ibar(r.listUsd ?? 0, maxActive, { of: 'busiest well listed' })}${usd(r.listUsd)}</span>
            </div>`,
          )}
        </div>
      </div>`
    return c.html(page('lore', body, { ...chrome(c), layout: 'root', nav: 'lore' }))
  })

  // The token profile over ONE window. The window (relative range or absolute
  // since/until) and the granularity are the page's state, in the URL under
  // the CLI's flag names, and every panel follows them — the page is
  // `lore usage --by <by> --since <since> --until <until>` rendered.
  app.get('/usage', (c) => {
    const db = getDb()
    const w = usageWindow(c.req.query())
    // "all time" is really "since the first indexed request" — say so.
    const firstDay = cached('usage.firstDay', 300_000, indexKey(), () =>
      z.object({ d: z.string().nullable() }).parse(db.prepare('SELECT substr(min(ts), 1, 10) AS d FROM requests').get()).d,
    )
    const q = { since: w.since ?? undefined, until: w.untilExclusive ?? undefined }
    const key = `${indexKey()}|${w.by}|${w.since ?? ''}|${w.until ?? ''}`
    const buckets = cached('usage.buckets', 300_000, key, () => listUsage(db, { by: w.by, ...q, limit: 400, split: true }))
    const models = cached('usage.models', 300_000, key, () => listUsage(db, { by: 'model', ...q, limit: 20, split: true }))
    const wells = cached('usage.wells', 300_000, key, () => listUsage(db, { by: 'well', ...q, limit: 60, split: true }))
    const data = { window: { range: w.range, by: w.by, since: w.since ?? firstDay, until: w.until }, buckets, models, wells }
    if (wantsJson(c.req.raw)) return c.json(data)
    const label = w.range === 'all' ? (firstDay ? `since ${firstDay}` : 'all time') : w.range === 'custom' ? `${w.since ?? firstDay ?? '…'} → ${w.until ?? 'today'}` : `last ${w.range.slice(0, -1)} days`
    const href = (patch: Partial<Record<'range' | 'by' | 'since' | 'until', string | null>>) => {
      // a relative window stays relative: its derived `since` never enters a link
      const custom = w.range === 'custom'
      const cur = { range: custom ? null : w.range, by: w.by, since: custom ? w.since : null, until: custom ? w.until : null, ...patch }
      const p = new URLSearchParams()
      if (cur.since || cur.until) {
        if (cur.since) p.set('since', cur.since)
        if (cur.until) p.set('until', cur.until)
      } else if (cur.range && cur.range !== '90d') p.set('range', cur.range)
      if (cur.by && cur.by !== 'day') p.set('by', cur.by)
      const s = p.toString()
      return `/usage${s ? `?${s}` : ''}`
    }
    const seg = (items: string[], on: string, to: (v: string) => string) =>
      html`<span class="seg">${items.map((v) => html`<a class="${v === on ? 'on' : ''}" href="${to(v)}">${v}</a>`)}</span>`
    const maxModel = Math.max(...models.rows.map((r) => r.listUsd ?? 0), 0)
    const maxWell = Math.max(...wells.rows.map((r) => r.listUsd ?? 0), 0)
    const maxBucket = Math.max(...buckets.rows.map((r) => r.listUsd ?? 0), 0)
    const feeOf = (r: UsageRow) => (r.usd ? feeBar(r.usd, { caption: false }) : html``)
    const body = html`
      <div class="area-bar toolbar">
        ${seg(['7d', '30d', '90d', 'all'], w.range, (r) => href({ range: r, since: null, until: null }))}
        ${seg(['day', 'week', 'month'], w.by, (b) => href({ by: b }))}
        <form method="get" action="/usage" class="range ${w.range === 'custom' ? 'on' : ''}">
          <input type="date" name="since" value="${w.since ?? firstDay ?? ''}" aria-label="since" /><span class="muted">→</span><input type="date" name="until" value="${w.until ?? isoDay(Date.now())}" aria-label="until" />
          ${w.by !== 'day' ? html`<input type="hidden" name="by" value="${w.by}" />` : ''}<button type="submit">go</button>
        </form>
        <span class="sp muted">${label} · ${models.totals.requests.toLocaleString()} requests · ${models.totals.sessions} sessions${models.unpriced.length ? html` · <span class="err">unpriced: ${models.unpriced.join(', ')}</span>` : ''}</span>
      </div>
      <div class="area-chart panel">
        <header><h2>by ${w.by}</h2><span class="sub">${label}, list $ by model</span>${modelLegend(buckets.rows)}
          <span class="sp">${usd(models.totals.listUsd)} <span class="muted">${label}</span></span></header>
        <div class="body">${bucketChart(buckets.rows, 96)}</div>
      </div>
      <div class="area-models panel">
        <header><h2>by model</h2><span>${label}</span><span class="sp">${feeLegend()}</span></header>
        <div class="scroll list models">
          <div class="row head"><span>model</span><span class="num">req</span><span class="num">sess</span><span class="num">out</span><span class="num">think</span><span>fee by class</span><span class="num">list $</span></div>
          ${models.rows.map(
            (r) => html`<div class="row">
              <span class="mono" title="${r.key}"><i class="sw m-${modelFamily(r.key)}"></i>${r.key}</span>
              <span class="num">${r.requests.toLocaleString()}</span>
              <span class="num">${r.sessions}</span>
              <span class="num">${tok(r.output)}</span>
              <span class="num">${tok(r.thinking)}</span>
              <span>${feeOf(r)}</span>
              <span class="num">${ibar(r.listUsd ?? 0, maxModel, { of: 'priciest model in this window' })}${usd(r.listUsd)}</span>
            </div>`,
          )}
        </div>
      </div>
      <div class="area-wells panel">
        <header><h2>by well</h2><span>${label}, top ${wells.rows.length}</span></header>
        <div class="scroll list wells">
          <div class="row head"><span>well</span><span class="num">req</span><span class="num">sess</span><span class="num">out</span><span class="num">list $</span></div>
          ${wells.rows.map(
            (r) => html`<div class="row">
              <span class="mono"><a href="/well/${encodeURIComponent(r.key)}" title="${r.key}">${shortWell(r.key)}</a></span>
              <span class="num">${r.requests.toLocaleString()}</span>
              <span class="num">${r.sessions}</span>
              <span class="num">${tok(r.output)}</span>
              <span class="num">${ibar(r.listUsd ?? 0, maxWell, { of: 'priciest well in this window' })}${usd(r.listUsd)}</span>
            </div>`,
          )}
        </div>
      </div>
      <div class="area-days panel">
        <header><h2>by ${w.by}</h2><span>${label}, newest first</span></header>
        <div class="scroll list days">
          <div class="row head"><span>${w.by}</span><span class="num">req</span><span class="num">sess</span><span class="num">out</span><span class="num">think</span><span class="num">list $</span></div>
          ${buckets.rows.slice().sort((a, b) => (a.key < b.key ? 1 : -1)).map(
            (r) => html`<div class="row">
              <span class="mono">${r.key}</span>
              <span class="num">${r.requests.toLocaleString()}</span>
              <span class="num">${r.sessions}</span>
              <span class="num">${tok(r.output)}</span>
              <span class="num">${tok(r.thinking)}</span>
              <span class="num">${ibar(r.listUsd ?? 0, maxBucket, { of: `priciest ${w.by} in this window` })}${usd(r.listUsd)}</span>
            </div>`,
          )}
        </div>
        <p class="footnote">${buckets.note}</p>
      </div>`
    return c.html(page('usage · lore', body, { ...chrome(c), layout: 'usage', nav: 'usage' }))
  })

  app.get('/well/:dir', (c) => {
    const db = getDb()
    const dir = c.req.param('dir')
    const sessions = listSessions(db, { well: dir, exact: true, limit: 1000 })
    if (sessions.length === 0) return c.notFound()
    const usage = listUsage(db, { by: 'session', well: dir, exact: true, limit: 5000 })
    const weeks = listUsage(db, { by: 'week', well: dir, exact: true, limit: 26 })
    const byId = new Map(usage.rows.map((r) => [r.key, r]))
    const rows = sessions.map((s) => ({ ...s, usage: byId.get(s.sessionId) ?? null }))
    // The well's own mix: every model that served it, heaviest first.
    const wellModels = tallyWellModels(rows)
    const data = { well: dir, totals: usage.totals, models: wellModels, sessions: rows }
    if (wantsJson(c.req.raw)) return c.json(data)
    const maxUsd = Math.max(...rows.map((s) => s.usage?.listUsd ?? 0), 0)
    const wiki = wikiPageFor(dir, wikiDir)
    const body = html`
      <div class="page-head">
        <p class="crumbs"><a href="/">lore</a> / well</p>
        <h1>${shortWell(dir)} <span class="muted small mono">${dir}</span>${wiki ? html` <span class="muted small">· wiki <span class="mono">${wiki}</span></span>` : ''}</h1>
        <div class="tiles">
          ${tile('sessions', String(sessions.length))}
          ${tile('requests', usage.totals.requests.toLocaleString())}
          ${tile('output', tok(usage.totals.output))}
          ${tile('cache-read', tok(usage.totals.cacheRead))}
          ${tile('list $', usd(usage.totals.listUsd))}
          ${usage.totals.spawns ? tile('spawns', `${usage.totals.spawns} · ${tok(usage.totals.spawnOutput ?? 0)} out`) : ''}
          ${wellModels.length ? html`<div class="tile models"><div class="v">${wellModels.map((m) => modelChip(m.model, { title: `${m.model} · ${m.requests.toLocaleString()} requests` }))}</div><div class="l">models</div></div>` : ''}
          ${weeks.rows.length > 1 ? html`<div class="tile wide">${bars(weeks.rows.map((r) => ({ label: r.key, value: r.listUsd ?? 0, title: `${r.key}: ${usd(r.listUsd)}` })), { height: 28 })}</div>` : ''}
        </div>
      </div>
      <div class="panel"><div class="scroll list sessions">
        <div class="row head"><span>first</span><span>last</span><span>model</span><span>opening</span><span class="num">pr</span><span class="num">req</span><span class="num">out</span><span class="num">cache</span><span class="num">list $</span><span class="num">spawns</span></div>
        ${rows.map(
          (s) => html`<div class="row">
            <span class="mono"><a href="/session/${s.sessionId}">${timeEl(s.firstAt)}</a></span>
            <span class="mono muted" title="${s.idleUntil ? `open until ${dayName(s.idleUntil)} with no work` : ''}">${
              // the span rule (viz.ts) split across two cells: the date is
              // stated once, and `last` narrows to a clock when the session
              // ended on the day it began — which is nearly all of them, and
              // "19 aug → 19 aug" told the reader nothing twice.
              s.last === s.first ? clockEl(s.lastAt) : timeEl(s.lastAt)
            }${s.idleUntil ? ' ⋯' : ''}</span>
            <span>${modelChips(s.models)}</span>
            <span title="${s.firstPrompt ?? ''}">${opener(s)}</span>
            <span class="num">${s.prompts || ''}</span>
            <span class="num">${s.usage?.requests ?? ''}</span>
            <span class="num">${s.usage ? tok(s.usage.output) : ''}</span>
            <span class="num">${s.usage ? tok(s.usage.cacheRead) : ''}</span>
            <span class="num">${s.usage?.listUsd ? html`${ibar(s.usage.listUsd, maxUsd, { of: 'priciest session in this well' })}${usd(s.usage.listUsd)}` : ''}</span>
            <span class="num">${s.usage?.spawns || ''}</span>
          </div>`,
        )}
      </div></div>`
    return c.html(page(`${dir} · lore`, body, { ...chrome(c), layout: 'head' }))
  })

  app.get('/session/:id', (c) => {
    const db = getDb()
    let trace: ReturnType<typeof getTrace>
    try {
      trace = getTrace(db, c.req.param('id'), { limit: 2000, head: 400, proseHead: 20_000, steps: true })
    } catch (e) {
      return c.text(e instanceof Error ? e.message : String(e), 404)
    }
    if (wantsJson(c.req.raw)) return c.json(trace)
    // ?open=all unfolds every transaction and phase — one page to ⌘F or print.
    return c.html(page(`${trace.session.sessionId.slice(0, 8)} · lore`, sessionBody(trace, { open: c.req.query('open') === 'all' }), { ...chrome(c), layout: 'head' }))
  })

  // The thread between two agents (thread.ts, threadview.ts): the
  // conversation view. `lore api thread lore ccc` is the data.
  app.get('/thread/:a/:b', (c) => {
    const db = getDb()
    let thread: ReturnType<typeof getThread>
    try {
      // ?you=0 leaves the user's words out: the agents' traffic alone.
      thread = getThread(db, c.req.param('a'), c.req.param('b'), { head: 20_000, you: c.req.query('you') !== '0' })
    } catch (e) {
      return c.text(e instanceof Error ? e.message : String(e), 404)
    }
    if (wantsJson(c.req.raw)) return c.json(thread)
    const a = thread.a.name ?? thread.a.query.slice(0, 8)
    const b = thread.b.name ?? thread.b.query.slice(0, 8)
    return c.html(page(`${a} ↔ ${b} · thread · lore`, threadBody(thread), { ...chrome(c), layout: 'head', nav: 'threads' }))
  })
  app.get('/thread', (c) => {
    const db = getDb()
    const pairs = listThreads(db)
    if (wantsJson(c.req.raw)) return c.json({ threads: pairs })
    return c.html(page('threads · lore', threadsBody(pairs), { ...chrome(c), layout: 'head', nav: 'threads' }))
  })

  return app
}

function wantsJson(req: Request): boolean {
  const url = new URL(req.url)
  if (url.searchParams.has('json')) return true
  const accept = req.headers.get('accept') ?? ''
  return accept.includes('application/json') && !accept.includes('text/html')
}

// ---- rendering ---------------------------------------------------------



// FTS5 snippet marks come back as « » in escaped text; turn them into <mark>.
function markSnippet(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc.replace(/«/g, '<mark>').replace(/»/g, '</mark>')
}

function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+\/code\//, '').replace('/.claude/worktrees/', ' · ')
}

// A well's repo has a wiki page when projects/<repo>.md exists — the human
// summary beside the mechanical one. Pointer only; the wiki is not served.
function wikiPageFor(dir: string, wikiDir: string): string | null {
  const i = dir.indexOf('-code-')
  if (i < 0) return null
  const repo = dir.slice(i + '-code-'.length).split('--claude-worktrees-')[0]!.replace(/^(fun|work|personal|games)-/, '')
  const p = join(wikiDir, 'projects', `${basename(repo)}.md`)
  return existsSync(p) ? `projects/${basename(repo)}.md` : null
}

// The opening line of a session, wherever one is listed. A session a PEER
// opened has no prompt of its own — it headed the arc with a dash until the
// relay lane got a head — so it heads with the relayed message, chipped with
// who sent it.
function opener(s: { firstPrompt: string | null; openedBy: string | null }) {
  if (s.firstPrompt == null) return html`<span class="muted">—</span>`
  return html`${s.openedBy ? html`<span class="kind relay">@${s.openedBy}</span> ` : ''}${s.firstPrompt}`
}

// Well dirs are slugged absolute paths; the tail past `code` is the name a
// human uses (`fun/my-app · feature-branch`).
function shortWell(dir: string): string {
  const i = dir.indexOf('-code-')
  const tail = i >= 0 ? dir.slice(i + '-code-'.length) : dir.replace(/^-/, '')
  return tail.replace('--claude-worktrees-', ' · ').replace(/^(fun|work|personal|games)-/, '$1/')
}
// A stat tile: the number, its label, and the 14-day trend behind it.
function stat(label: string, value: string, days: UsageRow[], pick: (d: UsageRow) => number, fmt: (v: number) => string) {
  return html`<div class="tile stat"><div><div class="v">${value}</div><div class="l">${label}</div></div>${spark(
    days.map(pick),
    { title: (i) => `${days[i]!.key}: ${fmt(pick(days[i]!))}` },
  )}</div>`
}


// The day chart: list $ stacked by model FAMILY (model.ts). Stacking by
// exact id meant the colours were assigned by rank within the window — the
// same blue was opus in one window and fable in another, and a chip
// elsewhere on the page agreed with neither. Families are four, fixed, and
// hold their hue everywhere; the exact ids ride in the column's tooltip,
// where the generation belongs.
function familiesIn(rows: UsageRow[]): ModelFamily[] {
  const present = new Set<ModelFamily>()
  for (const d of rows) for (const m of d.models ?? []) if ((m.listUsd ?? 0) > 0) present.add(modelFamily(m.model))
  return FAMILIES.filter((f) => present.has(f))
}
// The usage page's window: a relative range (7d/30d/90d/all) or absolute
// since/until dates (inclusive, as a person writes them; the query's `until`
// is exclusive, so it gets the day after), and the bucket granularity.
// Same names as `lore usage`'s flags. Anything unparseable falls back to the
// default rather than 400ing — a bad URL still shows the profile.
const DAY = 86_400_000
const isoDay = (t: number) => day(new Date(t).toISOString())
const UsageQuery = z.object({
  range: z.enum(['7d', '30d', '90d', 'all']).optional(),
  by: z.enum(['day', 'week', 'month']).optional(),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})
function usageWindow(raw: Record<string, string | undefined>) {
  const clean = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''))
  const parsed = UsageQuery.safeParse(clean)
  const o = parsed.success ? parsed.data : {}
  const by = o.by ?? 'day'
  if (o.since || o.until) {
    const until = o.until ?? null
    return { range: 'custom' as const, by, since: o.since ?? null, until, untilExclusive: until ? isoDay(Date.parse(until) + DAY) : null }
  }
  const range = o.range ?? '90d'
  const days = { '7d': 7, '30d': 30, '90d': 90, all: null }[range]
  return { range, by, since: days ? isoDay(Date.now() - (days - 1) * DAY) : null, until: null, untilExclusive: null }
}

function bucketChart(rows: UsageRow[], height = 72) {
  const days = rows.slice().sort((a, b) => (a.key < b.key ? -1 : 1))
  const series = familiesIn(days).map((f) => ({
    name: f,
    cls: `m-${f}`,
    values: days.map((d) => (d.models ?? []).filter((x) => modelFamily(x.model) === f).reduce((a, x) => a + (x.listUsd ?? 0), 0)),
  }))
  const detail = (d: UsageRow) =>
    (d.models ?? [])
      .filter((m) => (m.listUsd ?? 0) > 0)
      .sort((a, b) => (b.listUsd ?? 0) - (a.listUsd ?? 0))
      .map((m) => `${m.model} ${usd(m.listUsd)}`)
      .join('\n')
  return stackedBars(
    days.map((d) => d.key),
    series,
    {
      height,
      title: (i) => `${days[i]!.key}: ${usd(days[i]!.listUsd)} · ${tok(days[i]!.output)} out · ${days[i]!.requests} req\n${detail(days[i]!)}`,
    },
  )
}
function modelLegend(rows: UsageRow[]) {
  return html`<span class="legend small muted">${familiesIn(rows).map((f) => html`<span class="key"><i class="sw m-${f}"></i>${f}</span>`)}</span>`
}

// A roster row's model, and where the answer came from — a live agent's is
// read from its transcript, a finished one's from the index, which a
// mid-session /model switch can outdate.
function modelTitle(a: AgentRow): string {
  if (!a.model) return 'no model recorded yet'
  const mix = (a.indexed?.models ?? []).map((m) => `${m.model} ×${m.requests}`).join('\n')
  const how = a.modelSource === 'transcript' ? 'verified from the transcript' : `as of the last index${mix ? '' : ''}`
  return `${a.model} — ${how}${mix ? `\n${mix}` : ''}`
}

// ---- jobs on the pages (job.ts) -------------------------------------------

type RecentSession = ReturnType<typeof listSessions>[number] & { usage: UsageRow | null }
type RecentJob = {
  key: string
  kind: JobKind
  name: string | null
  // The newest session of the job in the window — the row's link and opener.
  sessionId: string
  well: string
  lastAt: string | null
  firstPrompt: string | null
  openedBy: string | null
  models: { model: string; requests: number }[]
  sessions: number
  prompts: number
  usage: { requests: number; output: number; listUsd: number }
}

// The recent panel's rows: sessions (newest first) folded into their jobs,
// first-seen order kept, so the row sits where its newest session was.
function groupRecent(rows: RecentSession[], refs: Map<string, { key: string; kind: JobKind }>, name: (key: string, kind: JobKind) => string | null): RecentJob[] {
  const groups = new Map<string, RecentJob & { members: RecentSession[] }>()
  for (const s of rows) {
    const ref = refs.get(s.sessionId) ?? { key: s.sessionId, kind: 'session' as const }
    let g = groups.get(ref.key)
    if (!g) {
      g = {
        key: ref.key, kind: ref.kind, name: name(ref.key, ref.kind),
        sessionId: s.sessionId, well: s.well, lastAt: s.lastAt, firstPrompt: s.firstPrompt, openedBy: s.openedBy,
        models: [], sessions: 0, prompts: 0, usage: { requests: 0, output: 0, listUsd: 0 }, members: [],
      }
      groups.set(ref.key, g)
    }
    g.sessions++
    g.prompts += s.prompts
    g.usage.requests += s.usage?.requests ?? 0
    g.usage.output += s.usage?.output ?? 0
    g.usage.listUsd += s.usage?.listUsd ?? 0
    g.members.push(s)
  }
  return [...groups.values()].map(({ members, ...g }) => ({ ...g, models: tallyWellModels(members) }))
}

// The agents page's row: a job, and the roster's live half when the daemon
// still lists it. A roster row the index has no job for yet (a job that has
// not been indexed) rides alone.
type AgentJob = { key: string | null; job: JobRow | null; live: AgentRow | null }
function mergeAgents(jobs: JobRow[], live: AgentRow[], keyOfSession: (sid: string) => string | null): AgentJob[] {
  // A daemon id names one job; were two rows to claim it, the bridge-keyed
  // one is the job and the other a fragment.
  const byJobId = new Map<string, JobRow>()
  for (const j of jobs.slice().sort((x, y) => (x.kind === 'bridge' ? 0 : 1) - (y.kind === 'bridge' ? 0 : 1))) if (j.jobId && !byJobId.has(j.jobId)) byJobId.set(j.jobId, j)
  const byKey = new Map(jobs.map((j) => [j.key, j]))
  const taken = new Set<string>()
  const rows: AgentJob[] = []
  for (const a of live) {
    const key = (a.id && byJobId.get(a.id)?.key) || (a.sessionId ? keyOfSession(a.sessionId) : null)
    const job = key ? (byKey.get(key) ?? null) : null
    if (job) taken.add(job.key)
    rows.push({ key: key ?? null, job, live: a })
  }
  for (const j of jobs) if (!taken.has(j.key)) rows.push({ key: j.key, job: j, live: null })
  // Attention first — working, then blocked — then everything by last activity.
  const active = (r: AgentJob) => (r.live?.state === 'working' ? 0 : r.live?.state === 'blocked' ? 1 : 2)
  const last = (r: AgentJob) => r.job?.last ?? r.live?.updatedAt ?? r.live?.startedAt ?? ''
  rows.sort((x, y) => active(x) - active(y) || (last(y) < last(x) ? -1 : last(y) > last(x) ? 1 : 0))
  return rows
}

function agentRow(r: AgentJob, maxLive: number, maxUsd: number) {
  const a = r.live
  const j = r.job
  const name = a?.name ?? j?.name ?? null
  const label = name ? `@${name}` : j ? j.key.slice(0, 8) : a ? shortPath(a.cwd) : '?'
  const href = r.key ? `/job/${encodeURIComponent(r.key)}` : null
  const gone = !a && !j?.jobId
  // The live session when there is one — what runs now — else the newest.
  const sid = a?.sessionId ?? j?.latest?.sessionId ?? null
  const lastAt = j?.last ?? a?.indexed?.last ?? null
  const cls = a ? a.state : gone ? 'gone' : ''
  return html`<div class="row ${cls}" title="${a ? `started ${stamp(a.startedAt)}${a.updatedAt ? ` · updated ${stamp(a.updatedAt)}` : ''}` : j ? `${stamp(j.first)} → ${stamp(j.last)} · ${j.kind} ${j.key}` : ''}">
    <span title="${a?.tempo ?? ''}${a?.waitingFor ? ` · waiting for ${a.waitingFor}` : ''}">${
      a ? html`<span class="dot st-${a.state}"></span> ${a.state}` : j?.jobId ? html`<span class="muted">${j.state ?? ''}</span>` : html`<span class="muted" title="the daemon no longer lists this job">gone</span>`
    }</span>
    <span title="${name ?? ''}${j?.nameSource === 'peer' ? ' · the daemon has forgotten this job; its peers called it this' : ''}">${href ? html`<a href="${href}">${label}</a>` : label}${
      j?.nameSource === 'peer' ? html` <span class="kind peer">peer</span>` : ''
    }</span>
    <span class="${a?.modelSource === 'index' ? 'stale' : ''}">${a ? modelChip(a.model, { title: modelTitle(a) }) : modelChips(j?.models)}</span>
    <span class="mono muted" title="${a ? `${a.cwd}${a.branch ? ` @ ${a.branch}` : ''}` : (j?.wells ?? []).join('\n')}">${
      a ? html`${shortPath(a.cwd)}${a.branch ? ` @ ${a.branch}` : ''}` : j ? html`${shortWell(j.wells[0] ?? '')}${j.wells.length > 1 ? html` <span class="kind">+${j.wells.length - 1}</span>` : ''}` : ''
    }</span>
    <span title="${a?.detail ?? j?.latest?.firstPrompt ?? ''}">${a?.detail ?? (j?.latest ? opener(j.latest) : '')}</span>
    <span class="num">${a?.liveTokens != null ? html`${ibar(a.liveTokens, maxLive, { of: 'largest live context here', fmt: tok })}${tok(a.liveTokens)}` : ''}</span>
    <span class="num" title="${j ? `${j.incarnations} incarnation${j.incarnations === 1 ? '' : 's'}` : ''}">${j?.sessions ?? ''}</span>
    <span class="num">${j ? j.requests.toLocaleString() : (a?.indexed?.requests ?? '')}</span>
    <span class="num">${j ? html`${ibar(j.listUsd ?? 0, maxUsd, { of: 'priciest job here' })}${usd(j.listUsd)}` : a?.indexed ? usd(a.indexed.listUsd) : ''}</span>
    <span class="mono">${sid && (j || a?.indexed) ? html`<a href="/session/${sid}">${lastAt ? timeEl(lastAt) : 'yes'}</a>` : sid ? html`<span class="muted">not yet</span>` : ''}</span>
    <span>${(j?.peers ?? []).map((p, i) => html`${i ? ' ' : ''}<a href="/thread/${encodeURIComponent(name ?? r.key ?? '')}/${encodeURIComponent(p)}">@${p}</a>`)}</span>
    <span class="mono">${a?.attach ?? ''}</span>
  </div>`
}

// Every model a well's sessions ran on, heaviest first.
function tallyWellModels(rows: { models: { model: string; requests: number }[] }[]): { model: string; requests: number }[] {
  const n = new Map<string, number>()
  for (const r of rows) for (const m of r.models) n.set(m.model, (n.get(m.model) ?? 0) + m.requests)
  return [...n].map(([model, requests]) => ({ model, requests })).sort((a, b) => b.requests - a.requests || (a.model < b.model ? -1 : 1))
}

type Layout = 'one' | 'head' | 'root' | 'usage'
function page(
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
  opts: { q?: string; indexedAt?: string | null; indexError?: string | null; layout?: Layout; nav?: string; bare?: boolean; theme?: string | null } = {},
) {
  // The freshness LED: colour is the staleness signal (fresh under a quarter
  // hour), so the text beside it is the same ladder every other stamp wears —
  // "indexed 3m ago" while it is warm, "indexed yest 03:12" when it is not,
  // and ticking, because it is the stamp most likely to be read off a page
  // that has been open a while.
  const agoMs = opts.indexedAt ? Date.now() - Date.parse(opts.indexedAt) : null
  const layout = opts.layout ?? 'one'
  const theme = opts.theme === 'light' || opts.theme === 'dark' ? opts.theme : null
  const link = (href: string, label: string) => html`<a href="${href}" class="${opts.nav === label ? 'on' : ''}">${label}</a>`
  const nav = html`<nav class="nav">
    ${link('/', 'lore')} ${link('/usage', 'usage')} ${link('/agents', 'agents')} ${link('/thread', 'threads')}
    <form method="get" action="/search" class="navsearch"><input type="search" name="q" value="${opts.q ?? ''}" placeholder="search sessions…" /></form>
    <span class="muted small" title="${opts.indexedAt ? '' : 'the server has not refreshed the index; pages show the last lore index'}"><span class="led ${opts.indexError ? 'err' : agoMs != null && agoMs < 15 * 60_000 ? 'fresh' : ''}"></span>${
      opts.indexError ? html`<span class="err">index refresh failed</span>` : opts.indexedAt ? html`indexed ${timeEl(opts.indexedAt)}` : 'index: last `lore index`'
    }</span>
  </nav>`
  // layout-one wraps a plain document body in a single scrolling panel;
  // `bare` bodies bring their own panel.
  const main = layout === 'one' && !opts.bare ? html`<div class="panel"><div class="scroll body">${body}</div></div>` : body
  return html`<!doctype html>
<html lang="en"${theme ? html` data-theme="${theme}"` : ''}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="icon" href="${FAVICON}" />
<style>${raw(CSS)}</style>
</head>
<body>${nav}<main class="layout-${layout}">${main}</main>
<script>${raw(tick(TZ, todayLocal()))}</script></body>
</html>`
}
