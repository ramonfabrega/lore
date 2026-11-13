import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { tile } from './block'
import { railBody } from './convoview'
import { cut, hm, hms, ms, tok, usd } from './fmt'
import type { Run, RunLane } from './run'
import type { Trace } from './trace'
import { clockEl, modelChip, spanEl } from './viz'

// The run page (docs/EXPLORER.md §The run page): a job and the lanes it
// spawned, the question "how is it doing" answered on one screen. The head
// is `lore loop` as a line and tiles — the window, the job's context, the
// daemon's own detail line, the lanes and how many are live, what is
// running under it, the spend — and the TIMELINE: the job's turns as bands
// with its replies as ticks, the lanes packed as bars in their state's hue
// with a mark where each reported back, a dashed line at now. Under it two
// panels side by side with nothing linked out: the dialogue strip (the
// rail's rows for the parent that set the job to work and the job across
// its /clears, each row landing on the voice in that session's
// conversation page) and the lanes table (live first, then newest).
//
// It was a tranche's page until 2026-11-13: a picker across the tranches a
// queue file's history named, landings as ticks, a scoreboard with deltas,
// a `landed` column joined by item number. All of that read one repo's
// prose (loop.ts) and left with it.

type H = HtmlEscapedString | Promise<HtmlEscapedString>

export function runBody(run: Run, traces: { job: Trace[]; parent: Trace[] }) {
  return html`${runHead(run, traces.job)}${strip(run, traces)}${lanesTable(run)}`
}

function runHead(run: Run, job: Trace[]) {
  const { loop } = run
  const j = loop.job
  const name = j.name ? `@${j.name}` : j.key.slice(0, 8)
  const closed = loop.window.until != null
  return html`<div class="page-head">
    <p class="crumbs"><a href="/">lore</a> / <a href="/agents">agents</a> / <a href="/job/${encodeURIComponent(j.key)}">${name}</a> / run
      <span class="views"><a href="/job/${encodeURIComponent(j.key)}?view=conversation">conversation</a> · <a href="/job/${encodeURIComponent(j.key)}">sessions</a></span></p>
    <h1 class="mono">${name} · run${closed ? html` <span class="kind">closed</span>` : html`${j.state ? html` <span class="kind st-${j.state}">${j.state}</span>` : ''}${j.tempo ? html` <span class="muted small">${j.tempo}</span>` : ''}`}</h1>
    <p class="muted">${spanEl(run.window.from, run.window.to)}${
      run.window.defaulted ? html` · <span title="no window asked for: the job's last 24 hours. ?since= and ?until= take an instant or a date">the last day</span>` : ''
    } · ${modelChip(j.model)}${
      // The job's state, context and detail line are NOW's; a closed
      // window's page says what the window was, not what the job is on.
      closed ? '' : html`${j.ctx != null ? html` ctx ${tok(j.ctx)}` : ''}${j.detail ? html` · <span title="the daemon's own detail line">${j.detail}</span>` : ''}`
    }${run.parent ? html` · spawned by <a href="/job/${encodeURIComponent(run.parent.key)}">@${run.parent.name ?? run.parent.key.slice(0, 8)}</a>` : ''}</p>
    <div class="tiles">
      ${tile('lanes', `${run.lanes.length}${run.lanes.some((l) => l.live) ? ` · ${run.lanes.filter((l) => l.live).length} live` : ''}`)}
      ${!closed && loop.running.length ? tile(html`<span title="${loop.running.map((r) => r.label ?? '').join('\n')}">running</span>`, String(loop.running.length)) : ''}
      ${tile(html`<span title="the job's own list price in the window plus its lanes'">spend</span>`, usd(loop.spend.totalUsd))}
      ${tile(`${j.name ?? 'job'} $`, usd(loop.spend.jobUsd))}
      ${tile('lanes $', usd(loop.spend.laneUsd))}
    </div>
    ${timeline(run, job)}
  </div>`
}

// The timeline. Rows: the job (its turns as bands, its replies as ticks),
// then the lanes packed so concurrent ones stack.
function timeline(run: Run, job: Trace[]) {
  const { loop } = run
  const from = run.window.from
  if (!from) return html``
  const t0 = Math.min(Date.parse(from), ...job.map((t) => Date.parse(t.session.first ?? from)))
  const t1 = Date.parse(run.window.to)
  const span = Math.max(1, t1 - t0)
  const PW = 1000
  const LH = 12
  const TOP = 14
  const AX = 14
  const x = (ts: string | number | null) => (ts == null ? null : (((typeof ts === 'number' ? ts : Date.parse(ts)) - t0) / span) * PW)
  const pct = (v: number) => `${(v / 10).toFixed(2)}%`
  const ends: number[] = []
  const rowOf = new Map<RunLane, number>()
  for (const l of [...run.lanes].sort((a, b) => (a.spawnedAt ?? '').localeCompare(b.spawnedAt ?? ''))) {
    const a = Date.parse(l.spawnedAt ?? '')
    const b = l.live ? t1 : Date.parse(l.last ?? '')
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    let r = ends.findIndex((e) => e <= a)
    if (r < 0) r = ends.push(b) - 1
    else ends[r] = b
    rowOf.set(l, r)
  }
  const rows = [loop.job.name ?? 'job', ...Array.from({ length: ends.length }, (_, i) => (i === 0 ? 'lanes' : ''))]
  const H = TOP + rows.length * LH + AX
  const yJob = TOP
  const yLane = (r: number) => yJob + (1 + r) * LH
  const parts: H[] = []
  const labels: H[] = []
  for (const t of job)
    t.transactions.forEach((tx, i) => {
      const bx = x(tx.ts)
      if (bx == null || !tx.ms) return
      const bw = Math.max(1, (tx.ms / span) * PW)
      parts.push(html`<a href="/session/${t.session.sessionId}?view=conversation#tx-${tx.promptId ?? i}"><rect class="band ${i % 2 ? 'alt' : ''} ${tx.kind}" x="${bx.toFixed(2)}" y="${yJob}" width="${bw.toFixed(2)}" height="${LH}"><title>${tx.kind === 'relay' ? `@${tx.tag}` : tx.kind} ${hms(tx.ts)} · ${cut(tx.prompt, 100)} · ${ms(tx.ms)} · ${usd(tx.listUsd)}</title></rect></a>`)
      if (tx.reply && tx.ts) {
        const rx = x(Date.parse(tx.ts) + tx.ms)
        if (rx != null) parts.push(html`<rect class="m say" x="${(rx - 1.5).toFixed(2)}" y="${yJob + 1}" width="1.5" height="${LH - 2}"><title>${hms(tx.ts)} ${loop.job.name ?? 'job'}: ${cut(tx.reply, 140)}</title></rect>`)
      }
    })
  for (const [l, r] of rowOf) {
    const a = Math.max(Date.parse(l.spawnedAt ?? ''), t0)
    const b = Math.min(l.live ? t1 : Date.parse(l.last ?? ''), t1)
    if (!(b > a)) continue
    const lx = ((a - t0) / span) * PW
    const lw = Math.max(1.5, ((b - a) / span) * PW)
    const y = yLane(r)
    parts.push(html`<a href="/job/${encodeURIComponent(l.key)}"><rect class="ln st-${l.state ?? ''}" x="${lx.toFixed(2)}" y="${y + 2}" width="${lw.toFixed(2)}" height="${LH - 4}"><title>@${l.name ?? l.key.slice(0, 8)} · ${l.state ?? '?'} · spawned ${hms(l.spawnedAt)} → ${hms(l.last)} · ${usd(l.listUsd)}</title></rect></a>`)
    for (const m of l.msgs) {
      const mx = x(m)
      if (mx != null) parts.push(html`<rect class="m msg" x="${(mx - 1).toFixed(2)}" y="${y + 2}" width="2" height="${LH - 4}"><title>${hms(m)} @${l.name} → ${loop.job.name ?? 'job'}</title></rect>`)
    }
    if (lw >= 24) labels.push(html`<span class="bandn ln" style="left:${pct(lx)};top:${y - 1}px">${l.name ?? ''}</span>`)
  }
  const stepMin = [5, 10, 15, 30, 60, 120, 240, 480].find((m) => span / (m * 60_000) <= 12) ?? 1440
  const ticks: H[] = []
  const axis: H[] = []
  const first = Math.ceil(t0 / (stepMin * 60_000)) * stepMin * 60_000
  for (let tt = first; tt <= t1; tt += stepMin * 60_000) {
    const tx = ((tt - t0) / span) * PW
    ticks.push(html`<line class="tick" x1="${tx.toFixed(2)}" x2="${tx.toFixed(2)}" y1="${TOP}" y2="${H - AX}" />`)
    if (tx <= PW - 40) axis.push(html`<span class="axis" style="left:${pct(tx)}">${hm(new Date(tt).toISOString())}</span>`)
  }
  const closed = loop.window.until != null
  return html`<figure class="tl run" role="img" aria-label="the ${loop.job.name ?? 'job'} and its lanes">
    <div class="lanes" style="padding-top:${TOP}px">${rows.map((l) => html`<span class="${l === 'lanes' ? 'ln' : ''}">${l}</span>`)}</div>
    <div class="plot" style="height:${H}px">
      <svg viewBox="0 0 ${PW} ${H}" preserveAspectRatio="none">
        ${ticks}
        ${rows.map((_, i) => html`<line class="lanel" x1="0" x2="${PW}" y1="${TOP + (i + 1) * LH}" y2="${TOP + (i + 1) * LH}" />`)}
        ${parts}
        ${closed ? '' : html`<line class="now" x1="${PW}" x2="${PW}" y1="0" y2="${H - AX}" />`}
      </svg>
      ${labels}${axis}
    </div></figure>`
}

// The dialogue strip: the parent's sessions that touch the window (the
// job that set this one to work), then the job's across its /clears.
function strip(run: Run, traces: { job: Trace[]; parent: Trace[] }) {
  const all = [...traces.parent, ...traces.job]
  if (all.length === 0) return html`<div class="panel rail strip"><header><h2>said</h2><span class="sub">no session of the job in this window is indexed</span></header><div class="scroll"></div></div>`
  const parentIds = new Set(traces.parent.map((t) => t.session.sessionId))
  const pname = run.parent?.name
  return railBody(all, {
    name: run.loop.job.name,
    pages: true,
    title: 'said',
    sub: `${pname ? `@${pname}, which set it to work, then ` : ''}@${run.loop.job.name ?? 'the job'} across its /clears — a row opens the voice on the session's page`,
    rule: (t) => (parentIds.has(t.session.sessionId) ? `@${pname ?? 'parent'}` : `@${run.loop.job.name ?? 'job'}`),
  })
}

function lanesTable(run: Run) {
  const lanes = [...run.lanes].sort((a, b) => Number(b.live) - Number(a.live) || (b.spawnedAt ?? '').localeCompare(a.spawnedAt ?? ''))
  const t1 = Date.parse(run.window.to)
  return html`<div class="panel"><header><h2>lanes</h2><span class="sub">${lanes.length} in this window${lanes.some((l) => l.live) ? ` · ${lanes.filter((l) => l.live).length} live` : ''} · live first, then newest</span></header><div class="scroll">
    <table class="ix lanes run">
      <thead><tr><th>lane</th><th>state</th><th>model</th><th>spawned</th><th class="num">wall</th><th class="num" title="the context the lane's next turn carries">ctx</th><th class="num">req</th><th class="num">list $</th><th class="num" title="messages the lane sent the job">msgs</th></tr></thead>
      <tbody>${lanes.map((l) => {
        const end = l.live ? t1 : l.last ? Date.parse(l.last) : null
        const wall = l.spawnedAt && end != null && end > Date.parse(l.spawnedAt) ? ms(end - Date.parse(l.spawnedAt)) : ''
        return html`<tr class="${l.live ? 'live' : ''}">
          <td><a class="mono" href="/job/${encodeURIComponent(l.key)}">@${l.name ?? l.key.slice(0, 8)}</a></td>
          <td><span class="kind st-${l.state ?? ''}">${l.state ?? '?'}</span></td>
          <td>${modelChip(l.model)}</td>
          <td class="mono muted">${clockEl(l.spawnedAt)}</td>
          <td class="num">${wall}</td>
          <td class="num ${l.deep ? 'warn' : ''}">${l.ctx != null ? tok(l.ctx) : ''}</td>
          <td class="num">${l.requests.toLocaleString()}</td>
          <td class="num">${usd(l.listUsd)}</td>
          <td class="num">${l.msgs.length || ''}</td>
        </tr>`
      })}</tbody>
    </table>
  </div></div>`
}
