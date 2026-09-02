import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { type AgentRow, listAgents } from './agents'
import { WIKI_DIR } from './config'
import type { Lane } from './parse'
import { FAMILIES, type ModelFamily, modelFamily } from './model'
import { searchSessions } from './search'
import { resolveSessionId } from './session'
import { listSessions, modelsFor } from './sessions'
import { annotationLine, sessionBody, tile } from './block'
import { cut, tok, usd } from './fmt'
import { CSS } from './style'
import { bars, feeBar, feeLegend, ibar, modelChip, modelChips, spark, stackedBars } from './viz'
import { getTrace } from './trace'
import { listUsage, type UsageRow } from './usage'

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
const READ_VERBS = new Set(['wells', 'sessions', 'session', 'trace', 'usage', 'search', 'spawns', 'workflows', 'tools', 'stats', 'agents'])
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
          ${laneOpt('prompt,text', 'conversation')} ${laneOpt('prompt,text,tool', '+ tools')} ${laneOpt('prompt,text,thinking,tool', 'everything')}
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
                  <span class="muted mono">${s.first ?? ''} → ${s.last ?? ''}</span>
                  <span class="muted">${s.hits} hit${s.hits === 1 ? '' : 's'}</span>
                </div>
                <div class="prompt">${s.firstPrompt ?? ''}</div>
                ${s.snippets.map(
                  (sn) => html`<div class="snippet"><span class="kind">${sn.lane}</span> <a href="/session/${s.sessionId}${sn.promptId ? `#tx-${sn.promptId}` : ''}">${raw(markSnippet(sn.snippet))}</a></div>`,
                )}
              </div>`,
            )}`
        : html`<p class="muted">Sessions ranked by their best hit, then hit count, then recency. A half-typed last word matches as a prefix. FTS5 syntax passes through.</p>`}`
    return c.html(page(q ? `${q} · search · lore` : 'search · lore', body, { q, ...chrome(c), nav: 'search' }))
  })

  app.get('/agents', async (c) => {
    let rows: AgentRow[] = []
    let error: string | null = null
    try {
      rows = await roster()
    } catch (e) {
      memo.delete('roster')
      error = e instanceof Error ? e.message : String(e)
    }
    const data = { agents: rows, error }
    if (wantsJson(c.req.raw)) return c.json(data)
    const maxLive = Math.max(...rows.map((a) => a.liveTokens ?? 0), 0)
    const counts = new Map<string, number>()
    for (const a of rows) counts.set(a.state, (counts.get(a.state) ?? 0) + 1)
    const body = html`
      <div class="panel">
        <header><h2>agents</h2><span>${[...counts].map(([st, n]) => html`<span class="kind st-${st}">${n} ${st}</span> `)}</span>
          <span class="sp small">the daemon's roster + each job's state.json, joined to the index · a live agent's model is read from its transcript · attach in a terminal</span></header>
        ${error ? html`<p class="footnote err">${error}</p>` : ''}
        <div class="scroll list roster">
          <div class="row head"><span>state</span><span>name</span><span>model</span><span>where</span><span>doing</span><span class="num">live tokens</span><span class="num">req</span><span class="num">list $</span><span>indexed</span><span>links</span><span>attach</span></div>
          ${rows.map(
            (a) => html`<div class="row ${a.state}" title="started ${a.startedAt.slice(0, 16)}${a.updatedAt ? ` · updated ${a.updatedAt.slice(0, 16)}` : ''}">
              <span title="${a.tempo ?? ''}${a.waitingFor ? ` · waiting for ${a.waitingFor}` : ''}"><span class="dot st-${a.state}"></span> ${a.state}</span>
              <span title="${a.name ?? ''}">${a.name ?? ''}</span>
              <span class="${a.modelSource === 'index' ? 'stale' : ''}">${modelChip(a.model, { title: modelTitle(a) })}</span>
              <span class="mono muted" title="${a.cwd}${a.branch ? ` @ ${a.branch}` : ''}">${shortPath(a.cwd)}${a.branch ? ` @ ${a.branch}` : ''}</span>
              <span title="${a.detail ?? ''}">${a.detail ?? ''}</span>
              <span class="num">${a.liveTokens != null ? html`${ibar(a.liveTokens, maxLive)}${tok(a.liveTokens)}` : ''}</span>
              <span class="num">${a.indexed ? a.indexed.requests : ''}</span>
              <span class="num">${a.indexed ? usd(a.indexed.listUsd) : ''}</span>
              <span class="mono">${a.sessionId ? (a.indexed ? html`<a href="/session/${a.sessionId}" title="${a.indexed.last ?? ''}">${a.indexed.last ? agoText(Date.now() - Date.parse(a.indexed.last)) : 'yes'}</a>` : html`<span class="muted">not yet</span>`) : ''}</span>
              <span>${a.children.length > 3
                ? html`<details><summary>${a.children.length} links</summary>${a.children.map((ch) => html`<a href="${ch.href}">${ch.kind === 'pr' ? `#${ch.id}` : ch.kind}</a> `)}</details>`
                : a.children.map((ch) => html`<a href="${ch.href}">${ch.kind === 'pr' ? `#${ch.id}` : ch.kind}</a> `)}</span>
              <span class="mono">${a.attach ?? ''}</span>
            </div>`,
          )}
        </div>
      </div>`
    return c.html(page('agents · lore', body, { ...chrome(c), layout: 'one', nav: 'agents', bare: true }))
  })

  app.get('/job/:id', (c) => {
    const db = getDb()
    const id = c.req.param('id')
    const rows = z
      .array(z.object({ sessionId: z.string(), well: z.string(), first: z.string().nullable(), last: z.string().nullable(), lines: z.number() }))
      .parse(
        db
          .prepare(
            `SELECT s.session_id AS sessionId, w.dir AS well, s.first_ts AS first, COALESCE(s.last_activity_ts, s.last_ts) AS last, s.lines
             FROM sessions s JOIN wells w ON w.id = s.well_id WHERE s.job_session_id = ? ORDER BY s.first_ts`,
          )
          .all(id),
      )
    if (rows.length === 0) return c.notFound()
    const fee = new Map(listUsage(db, { by: 'session', sessions: rows.map((r) => r.sessionId), limit: 10000 }).rows.map((r) => [r.key, r]))
    const models = modelsFor(db, rows.map((r) => r.sessionId))
    const sessions = rows.map((r) => ({ ...r, usage: fee.get(r.sessionId) ?? null, models: models.get(r.sessionId) ?? [] }))
    const totals = sessions.reduce(
      (t, s) => ({ requests: t.requests + (s.usage?.requests ?? 0), output: t.output + (s.usage?.output ?? 0), listUsd: t.listUsd + (s.usage?.listUsd ?? 0) }),
      { requests: 0, output: 0, listUsd: 0 },
    )
    const data = { job: id, totals, sessions }
    if (wantsJson(c.req.raw)) return c.json(data)
    const maxUsd = Math.max(...sessions.map((s) => s.usage?.listUsd ?? 0), 0)
    const body = html`
      <div class="page-head">
        <p class="crumbs"><a href="/">lore</a> / job</p>
        <h1 class="mono">${id}</h1>
        <p class="muted small">${sessions.length} transcripts across /clears · ${totals.requests.toLocaleString()} requests · ${tok(totals.output)} out · ${usd(Math.round(totals.listUsd * 100) / 100)} list-equivalent</p>
      </div>
      <div class="panel"><div class="scroll list jobs">
        <div class="row head"><span>first</span><span>last</span><span>well</span><span>model</span><span class="num">lines</span><span class="num">req</span><span class="num">out</span><span class="num">list $</span></div>
        ${sessions.map(
          (s) => html`<div class="row">
            <span class="mono"><a href="/session/${s.sessionId}">${s.first?.slice(0, 16).replace('T', ' ') ?? ''}</a></span>
            <span class="mono muted">${s.last?.slice(0, 16).replace('T', ' ') ?? ''}</span>
            <span class="mono"><a href="/well/${encodeURIComponent(s.well)}">${shortWell(s.well)}</a></span>
            <span>${modelChips(s.models)}</span>
            <span class="num">${s.lines}</span>
            <span class="num">${s.usage?.requests ?? ''}</span>
            <span class="num">${s.usage ? tok(s.usage.output) : ''}</span>
            <span class="num">${s.usage?.listUsd ? html`${ibar(s.usage.listUsd, maxUsd)}${usd(s.usage.listUsd)}` : ''}</span>
          </div>`,
        )}
      </div></div>`
    return c.html(page(`job ${id.slice(0, 8)} · lore`, body, { ...chrome(c), layout: 'head' }))
  })

  // Liveness + provenance for `lore server status`.
  app.get('/_lore', (c) => c.json({ ok: true, build: opts.build ?? 'dev', pid: process.pid, startedAt, indexed }))

  // The control room: what is happening now (agents), what happened last
  // (recent, by last activity), where this week's spend went (active
  // wells), and the 45-day shape by model. Everything windowed so the
  // whole-corpus aggregates never run here.
  app.get('/', async (c) => {
    const db = getDb()
    const today = new Date().toISOString().slice(0, 10)
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
    const since45 = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10)
    const recentSessions = listSessions(db, { limit: 60, byActivity: true }).reverse()
    const feeById = new Map(
      listUsage(db, { by: 'session', sessions: recentSessions.map((s) => s.sessionId), limit: 200 }).rows.map((r) => [r.key, r]),
    )
    // Harness-only sessions (no prompt, no request) are noise here.
    const recent = recentSessions.map((s) => ({ ...s, usage: feeById.get(s.sessionId) ?? null })).filter((s) => s.prompts > 0 || s.usage)
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
          <div class="row head"><span>at</span><span>well</span><span>model</span><span>opening prompt</span><span class="num hide">pr</span><span class="num hide">req</span><span class="num hide">out</span><span class="num">list $</span></div>
          ${recent.map(
            (s) => html`<div class="row">
              <span class="mono"><a href="/session/${s.sessionId}" title="${s.lastAt ?? ''}">${whenLabel(s.lastAt, today)}</a></span>
              <span class="mono"><a href="/well/${encodeURIComponent(s.well)}" title="${s.well}">${shortWell(s.well)}</a></span>
              <span>${modelChips(s.models)}</span>
              <span title="${s.firstPrompt ?? ''}">${s.firstPrompt ?? html`<span class="muted">—</span>`}</span>
              <span class="num hide">${s.prompts || ''}</span>
              <span class="num hide">${s.usage?.requests ?? ''}</span>
              <span class="num hide">${s.usage ? tok(s.usage.output) : ''}</span>
              <span class="num">${s.usage?.listUsd ? html`${ibar(s.usage.listUsd, maxRecent)}${usd(s.usage.listUsd)}` : ''}</span>
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
              <span>${a.sessionId && a.indexed ? html`<a href="/session/${a.sessionId}">${a.name ?? shortPath(a.cwd)}</a>` : (a.name ?? shortPath(a.cwd))}</span>
              <span>${modelChip(a.model, { title: modelTitle(a) })}</span>
              <span class="muted">${a.detail ?? ''}</span>
              <span class="num">${a.liveTokens != null ? html`${ibar(a.liveTokens, maxLive)}${tok(a.liveTokens)}` : ''}</span>
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
              <span class="num">${ibar(r.listUsd ?? 0, maxActive)}${usd(r.listUsd)}</span>
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
              <span class="num">${ibar(r.listUsd ?? 0, maxModel)}${usd(r.listUsd)}</span>
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
              <span class="num">${ibar(r.listUsd ?? 0, maxWell)}${usd(r.listUsd)}</span>
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
              <span class="num">${ibar(r.listUsd ?? 0, maxBucket)}${usd(r.listUsd)}</span>
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
        <div class="row head"><span>first</span><span>last</span><span>model</span><span>opening prompt</span><span class="num">pr</span><span class="num">req</span><span class="num">out</span><span class="num">cache</span><span class="num">list $</span><span class="num">spawns</span></div>
        ${rows.map(
          (s) => html`<div class="row">
            <span class="mono"><a href="/session/${s.sessionId}">${s.first ?? ''}</a></span>
            <span class="mono muted" title="${s.idleUntil ? `open until ${s.idleUntil} with no work` : ''}">${s.last ?? ''}${s.idleUntil ? ' ⋯' : ''}</span>
            <span>${modelChips(s.models)}</span>
            <span title="${s.firstPrompt ?? ''}">${s.firstPrompt ?? html`<span class="muted">—</span>`}</span>
            <span class="num">${s.prompts || ''}</span>
            <span class="num">${s.usage?.requests ?? ''}</span>
            <span class="num">${s.usage ? tok(s.usage.output) : ''}</span>
            <span class="num">${s.usage ? tok(s.usage.cacheRead) : ''}</span>
            <span class="num">${s.usage?.listUsd ? html`${ibar(s.usage.listUsd, maxUsd)}${usd(s.usage.listUsd)}` : ''}</span>
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
      trace = getTrace(db, c.req.param('id'), { limit: 2000, head: 400, steps: true })
    } catch (e) {
      return c.text(e instanceof Error ? e.message : String(e), 404)
    }
    if (wantsJson(c.req.raw)) return c.json(trace)
    // ?open=all unfolds every transaction and phase — one page to ⌘F or print.
    return c.html(page(`${trace.session.sessionId.slice(0, 8)} · lore`, sessionBody(trace, { open: c.req.query('open') === 'all' }), { ...chrome(c), layout: 'head' }))
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

// "14:32" for today, "08-29" otherwise.
function whenLabel(ts: string | null, today: string): string {
  if (!ts) return ''
  return ts.slice(0, 10) === today ? ts.slice(11, 16) : ts.slice(5, 10)
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
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10)
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

// Every model a well's sessions ran on, heaviest first.
function tallyWellModels(rows: { models: { model: string; requests: number }[] }[]): { model: string; requests: number }[] {
  const n = new Map<string, number>()
  for (const r of rows) for (const m of r.models) n.set(m.model, (n.get(m.model) ?? 0) + m.requests)
  return [...n].map(([model, requests]) => ({ model, requests })).sort((a, b) => b.requests - a.requests || (a.model < b.model ? -1 : 1))
}

function agoText(msAgo: number): string {
  if (msAgo < 60_000) return 'just now'
  if (msAgo < 3_600_000) return `${Math.round(msAgo / 60_000)} min ago`
  if (msAgo < 48 * 3_600_000) return `${(msAgo / 3_600_000).toFixed(1)} h ago`
  return `${Math.round(msAgo / 86_400_000)} d ago`
}

type Layout = 'one' | 'head' | 'root' | 'usage'
function page(
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
  opts: { q?: string; indexedAt?: string | null; indexError?: string | null; layout?: Layout; nav?: string; bare?: boolean; theme?: string | null } = {},
) {
  const agoMs = opts.indexedAt ? Date.now() - Date.parse(opts.indexedAt) : null
  const ago = agoMs != null ? agoText(agoMs) : null
  const layout = opts.layout ?? 'one'
  const theme = opts.theme === 'light' || opts.theme === 'dark' ? opts.theme : null
  const link = (href: string, label: string) => html`<a href="${href}" class="${opts.nav === label ? 'on' : ''}">${label}</a>`
  const nav = html`<nav class="nav">
    ${link('/', 'lore')} ${link('/usage', 'usage')} ${link('/agents', 'agents')}
    <form method="get" action="/search" class="navsearch"><input type="search" name="q" value="${opts.q ?? ''}" placeholder="search sessions…" /></form>
    <span class="muted small" title="${opts.indexedAt ?? 'the server has not refreshed the index; pages show the last lore index'}"><span class="led ${opts.indexError ? 'err' : agoMs != null && agoMs < 15 * 60_000 ? 'fresh' : ''}"></span>${
      opts.indexError ? html`<span class="err">index refresh failed</span>` : ago ? `indexed ${ago}` : 'index: last `lore index`'
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
<style>${raw(CSS)}</style>
</head>
<body>${nav}<main class="layout-${layout}">${main}</main></body>
</html>`
}
