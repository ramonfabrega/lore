import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { listSessions } from './sessions'
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

type Db = () => Database

// The read verbs the server lets through to `cli.fetch` (docs/EXPLORER.md).
// The CLI as a fetch handler exposes EVERY verb — archive, index, docs index,
// wiki commit, serve itself — and over the tailnet that is a footgun, so the
// fall-through is GET-only against this list. `docs` is split by subcommand.
const READ_VERBS = new Set(['wells', 'sessions', 'session', 'trace', 'usage', 'search', 'spawns', 'workflows', 'tools', 'stats'])
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

export function createApp(getDb: Db, opts: { build?: string } = {}) {
  const app = new Hono()
  const startedAt = new Date().toISOString()

  // Liveness + provenance for `lore server status`.
  app.get('/_lore', (c) => c.json({ ok: true, build: opts.build ?? 'dev', pid: process.pid, startedAt }))

  app.get('/', (c) => {
    const db = getDb()
    const wells = listUsage(db, { by: 'well', limit: 60 })
    const weeks = listUsage(db, { by: 'week', limit: 26 })
    const models = listUsage(db, { by: 'model', limit: 12 })
    const data = { wells, weeks, models }
    if (wantsJson(c.req.raw)) return c.json(data)
    const body = html`
      <h1>lore</h1>
      <p class="muted">${wells.totals.requests.toLocaleString()} requests · ${wells.totals.sessions.toLocaleString()} sessions ·
        ${tok(wells.totals.output)} out · ${tok(wells.totals.cacheRead)} cache-read · ${usd(wells.totals.listUsd)} list-equivalent</p>
      <section>
        <h2>by week <span class="muted">list-equivalent USD</span></h2>
        ${bars(weeks.rows.map((r) => ({ label: r.key, value: r.listUsd ?? 0, title: `${r.key}: ${usd(r.listUsd)} · ${tok(r.output)} out · ${r.requests} req` })))}
      </section>
      <section>
        <h2>by model</h2>
        ${usageTable(models.rows, { keyLabel: 'model' })}
      </section>
      <section>
        <h2>wells</h2>
        ${usageTable(wells.rows, { keyLabel: 'well', link: (k) => `/well/${encodeURIComponent(k)}` })}
        ${wells.unpriced.length ? html`<p class="muted">unpriced models: ${wells.unpriced.join(', ')}</p>` : ''}
      </section>
      <p class="muted">${wells.note}</p>`
    return c.html(page('lore', body))
  })

  app.get('/usage', (c) => {
    const db = getDb()
    const days = listUsage(db, { by: 'day', limit: 45 })
    const weeks = listUsage(db, { by: 'week', limit: 52 })
    const models = listUsage(db, { by: 'model', limit: 20 })
    const data = { days, weeks, models }
    if (wantsJson(c.req.raw)) return c.json(data)
    const body = html`
      <h1>usage</h1>
      <section>
        <h2>by day <span class="muted">last 45, list-equivalent USD</span></h2>
        ${bars(days.rows.map((r) => ({ label: r.key, value: r.listUsd ?? 0, title: `${r.key}: ${usd(r.listUsd)} · ${tok(r.output)} out · ${r.requests} req` })))}
        ${usageTable(days.rows.slice().reverse(), { keyLabel: 'day' })}
      </section>
      <section><h2>by week</h2>${usageTable(weeks.rows.slice().reverse(), { keyLabel: 'week' })}</section>
      <section><h2>by model</h2>${usageTable(models.rows, { keyLabel: 'model' })}</section>
      <p class="muted">${days.note}</p>`
    return c.html(page('usage · lore', body))
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
    const data = { well: dir, totals: usage.totals, sessions: rows }
    if (wantsJson(c.req.raw)) return c.json(data)
    const body = html`
      <p class="crumbs"><a href="/">lore</a> / well</p>
      <h1>${dir}</h1>
      <p class="muted">${sessions.length} sessions · ${usage.totals.requests.toLocaleString()} requests · ${tok(usage.totals.output)} out ·
        ${usd(usage.totals.listUsd)} list-equivalent${usage.totals.spawns ? html` · ${usage.totals.spawns} spawns (${tok(usage.totals.spawnOutput ?? 0)} out)` : ''}</p>
      ${weeks.rows.length > 1 ? html`<section><h2>by week <span class="muted">list-equivalent USD</span></h2>${bars(weeks.rows.map((r) => ({ label: r.key, value: r.listUsd ?? 0, title: `${r.key}: ${usd(r.listUsd)}` })))}</section>` : ''}
      <section>
        <table>
          <thead><tr><th>first</th><th>last</th><th>opening prompt</th><th class="num">prompts</th><th class="num">requests</th><th class="num">out</th><th class="num">cache-read</th><th class="num">list $</th><th class="num">spawns</th></tr></thead>
          <tbody>
          ${rows.map(
            (s) => html`<tr>
              <td class="mono"><a href="/session/${s.sessionId}">${s.first ?? ''}</a></td>
              <td class="mono">${s.last ?? ''}${s.idleUntil ? html` <span class="muted" title="open until ${s.idleUntil} with no work">idle→${s.idleUntil}</span>` : ''}</td>
              <td class="prompt">${cut(s.firstPrompt ?? '', 120)}</td>
              <td class="num">${s.prompts}</td>
              <td class="num">${s.usage?.requests ?? ''}</td>
              <td class="num">${s.usage ? tok(s.usage.output) : ''}</td>
              <td class="num">${s.usage ? tok(s.usage.cacheRead) : ''}</td>
              <td class="num">${s.usage ? usd(s.usage.listUsd) : ''}</td>
              <td class="num">${s.usage?.spawns || ''}</td>
            </tr>`,
          )}
          </tbody>
        </table>
      </section>`
    return c.html(page(`${dir} · lore`, body))
  })

  app.get('/session/:id', (c) => {
    const db = getDb()
    let trace: ReturnType<typeof getTrace>
    try {
      trace = getTrace(db, c.req.param('id'), { limit: 2000, head: 240 })
    } catch (e) {
      return c.text(e instanceof Error ? e.message : String(e), 404)
    }
    if (wantsJson(c.req.raw)) return c.json(trace)
    const s = trace.session
    const t = trace.totals
    const body = html`
      <p class="crumbs"><a href="/">lore</a> / <a href="/well/${encodeURIComponent(s.well)}">${s.well}</a> / session</p>
      <h1 class="mono">${s.sessionId}</h1>
      <p class="muted">${s.first ?? ''} → ${s.last ?? ''} · ${ms(t.ms)} wall · ${s.lines} lines${s.jobSessionId ? html` · job <span class="mono">${s.jobSessionId.slice(0, 8)}</span>` : ''}</p>
      <div class="tiles">
        ${tile('transactions', String(t.transactions))}
        ${tile('steps', String(t.steps))}
        ${tile('instructions', String(t.instructions))}
        ${tile('errors', String(t.errors), t.errors > 0 ? 'warn' : '')}
        ${tile('output', tok(t.output))}
        ${tile('cache-read', tok(t.cacheRead))}
        ${tile('list $', usd(t.listUsd))}
        ${t.spawns ? tile('spawns', `${t.spawns} · ${tok(t.spawnOutput)} out`) : ''}
      </div>
      <section>
        <table class="tx">
          <thead><tr><th>#</th><th>at</th><th>kind</th><th>prompt</th><th class="num">steps</th><th class="num">instr</th><th class="num">err</th><th class="num">out</th><th class="num">list $</th><th class="num">wall</th></tr></thead>
          <tbody>
          ${trace.transactions.map(
            (x, i) => html`<tr class="${x.kind}">
              <td class="num">${i + 1}</td>
              <td class="mono">${x.ts ? x.ts.slice(11, 19) : ''}</td>
              <td><span class="kind ${x.kind}">${x.kind}</span></td>
              <td class="prompt">
                ${x.instructions.length || x.reply
                  ? html`<details>
                      <summary>${x.prompt || raw('&nbsp;')}</summary>
                      ${x.instructions.length
                        ? html`<table class="ix">
                            <thead><tr><th>tool</th><th>input</th><th class="num">ms</th><th>result</th></tr></thead>
                            <tbody>
                            ${x.instructions.map(
                              (ix) => html`<tr class="${ix.error ? 'err' : ''}">
                                <td class="mono">${ix.tool}</td>
                                <td class="mono small">${ix.input}</td>
                                <td class="num">${ix.ms ?? ''}</td>
                                <td class="small">${ix.error ? html`<span class="kind err">error</span> ` : ''}${ix.result}</td>
                              </tr>`,
                            )}
                            </tbody>
                          </table>`
                        : ''}
                      ${x.reply ? html`<p class="reply">${x.reply}</p>` : ''}
                    </details>`
                  : x.prompt}
              </td>
              <td class="num">${x.steps || ''}</td>
              <td class="num">${x.instructions.length || ''}</td>
              <td class="num">${x.errors || ''}</td>
              <td class="num">${x.output ? tok(x.output) : ''}</td>
              <td class="num">${x.listUsd ? usd(x.listUsd) : ''}</td>
              <td class="num">${x.ms ? ms(x.ms) : ''}</td>
            </tr>`,
          )}
          </tbody>
        </table>
      </section>`
    return c.html(page(`${s.sessionId.slice(0, 8)} · lore`, body))
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

function usageTable(rows: UsageRow[], opts: { keyLabel: string; link?: (key: string) => string }) {
  return html`<table>
    <thead><tr><th>${opts.keyLabel}</th><th class="num">requests</th><th class="num">sessions</th><th class="num">input</th><th class="num">cache-write</th><th class="num">cache-read</th><th class="num">out</th><th class="num">thinking</th><th class="num">list $</th>${rows.some((r) => r.spawns != null) ? html`<th class="num">spawns</th>` : ''}</tr></thead>
    <tbody>
    ${rows.map(
      (r) => html`<tr>
        <td class="mono">${opts.link ? html`<a href="${opts.link(r.key)}">${r.key}</a>` : r.key}</td>
        <td class="num">${r.requests.toLocaleString()}</td>
        <td class="num">${r.sessions}</td>
        <td class="num">${tok(r.input)}</td>
        <td class="num">${tok(r.cacheWrite)}</td>
        <td class="num">${tok(r.cacheRead)}</td>
        <td class="num">${tok(r.output)}</td>
        <td class="num">${tok(r.thinking)}</td>
        <td class="num">${usd(r.listUsd)}</td>
        ${r.spawns != null ? html`<td class="num">${r.spawns || ''}</td>` : ''}
      </tr>`,
    )}
    </tbody>
  </table>`
}

// A single-series bar strip: thin marks, 2px surface gap, rounded data-end
// anchored to the baseline, per-mark <title> tooltip. Text stays text-ink.
function bars(points: { label: string; value: number; title: string }[]) {
  if (points.length === 0) return html``
  const w = 8
  const gap = 2
  const h = 56
  const max = Math.max(...points.map((p) => p.value), 1)
  const width = points.length * (w + gap)
  return html`<figure class="viz" role="img" aria-label="${points.map((p) => p.title).join('; ')}">
    <svg viewBox="0 0 ${width} ${h + 14}" width="${width}" height="${h + 14}" preserveAspectRatio="none">
      ${points.map((p, i) => {
        const bh = Math.max(1, Math.round((p.value / max) * h))
        return html`<g><title>${p.title}</title><rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="2" class="mark" /><rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh + 14}" fill="transparent" /></g>`
      })}
      <text x="0" y="${h + 11}" class="axis">${points[0]!.label}</text>
      <text x="${width}" y="${h + 11}" text-anchor="end" class="axis">${points[points.length - 1]!.label}</text>
    </svg>
  </figure>`
}

function tile(label: string, value: string, cls = '') {
  return html`<div class="tile ${cls}"><div class="v">${value}</div><div class="l">${label}</div></div>`
}

function tok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return String(n)
}
function usd(n: number | null): string {
  return n == null ? '—' : `$${n.toFixed(2)}`
}
function ms(n: number | null): string {
  if (n == null) return ''
  if (n < 1000) return `${n}ms`
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`
  if (n < 3_600_000) return `${Math.round(n / 60_000)}min`
  return `${(n / 3_600_000).toFixed(1)}h`
}
function cut(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function page(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
:root { color-scheme: light dark;
  --surface: #fcfcfb; --surface-2: #f1f1ee; --line: #e2e2dd; --ink: #0b0b0b; --ink-2: #52514e; --ink-3: #8a8985;
  --series-1: #2a78d6; --warn: #b45309; --err: #b91c1c; --link: #1d5fb3; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --surface: #1a1a19; --surface-2: #232322; --line: #34342f; --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #8d8c84;
  --series-1: #3987e5; --warn: #f59e0b; --err: #f87171; --link: #7ab3f5; } }
:root[data-theme="dark"] {
  --surface: #1a1a19; --surface-2: #232322; --line: #34342f; --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #8d8c84;
  --series-1: #3987e5; --warn: #f59e0b; --err: #f87171; --link: #7ab3f5; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 28px 64px; background: var(--surface); color: var(--ink);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
h1 { font-size: 22px; margin: 0 0 6px; } h2 { font-size: 15px; margin: 28px 0 8px; }
h2 .muted { font-weight: 400; margin-left: 8px; }
a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
.muted { color: var(--ink-3); } .crumbs { color: var(--ink-3); margin: 0 0 8px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.small { font-size: 12px; }
table { border-collapse: collapse; width: 100%; } th, td { padding: 5px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--ink-2); font-weight: 500; font-size: 12px; position: sticky; top: 0; background: var(--surface); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.prompt { max-width: 640px; }
section { overflow-x: auto; }
.tiles { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 4px; }
.tile { background: var(--surface-2); border-radius: 6px; padding: 8px 12px; min-width: 96px; }
.tile .v { font-size: 18px; font-variant-numeric: tabular-nums; } .tile .l { font-size: 11px; color: var(--ink-3); }
.tile.warn .v { color: var(--warn); }
.kind { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--surface-2); color: var(--ink-2); }
.kind.err { color: var(--err); } tr.meta td, tr.command td { color: var(--ink-3); }
table.ix { margin: 6px 0 4px; } table.ix th { position: static; } tr.err td { color: var(--err); }
details > summary { cursor: pointer; } .reply { color: var(--ink-2); margin: 6px 0 2px; }
.viz svg { display: block; max-width: 100%; height: auto; } .viz { margin: 0 0 8px; }
.viz .mark { fill: var(--series-1); } .viz .axis { fill: var(--ink-3); font-size: 9px; font-family: ui-monospace, Menlo, monospace; }
</style>
</head>
<body>${body}</body>
</html>`
}
