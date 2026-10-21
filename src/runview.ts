import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { tile } from './block'
import { railBody } from './convoview'
import { cut, hm, hms, ms, tok, usd } from './fmt'
import type { ScoreLine } from './loop'
import type { Run, RunLane } from './run'
import type { Trace } from './trace'
import { clockEl, modelChip, spanEl, timeEl } from './viz'

// The run page (docs/EXPLORER.md §The run page): one tranche of an
// unattended loop, the question "how is the loop doing" answered on one
// screen. The head is `lore loop` as a line and tiles — landed of twenty,
// from which base, the last landing and how long ago, the rate and when the
// twentieth lands at it, the commander's context, the daemon's own detail
// line — a picker across the tranches the queue's history names, the
// scoreboard with its deltas against the base, and the tranche TIMELINE:
// landings as ticks, the commander's turns as bands with its replies as
// ticks, the lanes packed as bars in their state's hue with a mark where
// each reported back, a dashed line at now. Under it the two panels the
// design sync asked for side by side with nothing linked out: the dialogue
// strip (the rail's rows for the steer pass that armed the tranche and the
// commander across its /clears, each row landing on the voice in that
// session's conversation page) and the lanes table (live first, then
// newest; the `landed` column is the booking commit joined by item).

type H = HtmlEscapedString | Promise<HtmlEscapedString>

export function runBody(run: Run, traces: { job: Trace[]; parent: Trace[] }) {
  return html`${runHead(run, traces.job)}${strip(run, traces)}${lanesTable(run)}`
}

function runHead(run: Run, job: Trace[]) {
  const { loop } = run
  const j = loop.job
  const tr = loop.tranche
  const name = j.name ? `@${j.name}` : j.key.slice(0, 8)
  const closed = tr?.endAt != null
  const since = tr?.sinceLastMs ?? null
  const stale = !closed && since != null && since > 3_600_000
  const t1 = Date.parse(tr?.endAt ?? loop.asOf)
  const pick = run.tranches.length
    ? html`<p class="muted small">tranche <span class="seg tranches">${run.tranches.map((t) => {
        const n = (t.label ?? t.base).replace(/^the /, '').replace(/ tranche$/, '')
        const on = tr?.base === t.base
        return html`<a class="${on ? 'on' : ''}" href="?base=${t.base}" title="${t.label ?? ''} · from ${t.base}${t.until ? ` to ${t.until}` : ' · open'}">${n}</a>`
      })}</span>${tr && !run.tranches.some((t) => t.base === tr.base) ? html` <span class="muted">· from ${tr.base}, not in the queue's history</span>` : ''}</p>`
    : ''
  return html`<div class="page-head">
    <p class="crumbs"><a href="/">lore</a> / <a href="/agents">agents</a> / <a href="/job/${encodeURIComponent(j.key)}">${name}</a> / run
      <span class="views"><a href="/job/${encodeURIComponent(j.key)}?view=conversation">conversation</a> · <a href="/job/${encodeURIComponent(j.key)}">sessions</a></span></p>
    <h1 class="mono">${tr?.label ?? `${name} · run`} <span class="kind side-a">${name}</span>${closed ? html` <span class="kind">closed</span>` : html`${j.state ? html` <span class="kind st-${j.state}">${j.state}</span>` : ''}${j.tempo ? html` <span class="muted small">${j.tempo}</span>` : ''}`}</h1>
    <p class="muted">${
      tr
        ? html`<b class="ink">${tr.landings} of ${tr.of}</b> landed from <span class="mono">${tr.base}</span>${tr.until ? html` to <span class="mono">${tr.until}</span>` : ''} · ${spanEl(tr.baseAt, tr.endAt ?? loop.asOf)}${
            tr.last ? html` · last landing ${clockEl(tr.last)}${since != null ? html` <span class="${stale ? 'warn' : ''}">(${ms(since)} ${closed ? 'before the end' : 'ago'})</span>` : ''}` : ' · no landing yet'
          }${tr.perHour != null ? html` · ${tr.perHour}/h` : ''}${tr.etaMs != null ? html` · at this rate the ${ordinal(tr.of)} lands ${timeEl(new Date(t1 + tr.etaMs).toISOString())}` : ''}`
        : html`no tranche: the job's cwd has no queue file naming a base (\`lore loop --help\`) · ${spanEl(j.startedAt, loop.asOf)}`
    }
      · ${modelChip(j.model)}${
        // The job's state, context and detail line are NOW's; a closed
        // tranche's page says what the tranche was, not what the job is on.
        closed ? '' : html`${j.ctx != null ? html` ctx ${tok(j.ctx)}` : ''}${j.detail ? html` · <span title="the daemon's own detail line">${j.detail}</span>` : ''}`
      }${run.parent ? html` · spawned by <a href="/job/${encodeURIComponent(run.parent.key)}">@${run.parent.name ?? run.parent.key.slice(0, 8)}</a>` : ''}</p>
    ${pick}
    <div class="tiles">
      ${tr ? tile('landed', `${tr.landings} / ${tr.of}`) : ''}
      ${since != null ? tile(closed ? 'last → end' : 'since last', ms(since), stale ? 'warn' : '') : ''}
      ${tr?.perHour != null ? tile('per hour', String(tr.perHour)) : ''}
      ${tr ? tile('merges · commits', `${tr.merges} · ${tr.commits}`) : ''}
      ${tile('lanes', `${run.lanes.length}${run.lanes.some((l) => l.live) ? ` · ${run.lanes.filter((l) => l.live).length} live` : ''}`)}
      ${!closed && loop.running.length ? tile(html`<span title="${loop.running.map((r) => r.label ?? '').join('\n')}">running</span>`, String(loop.running.length)) : ''}
      ${loop.gate?.running ? tile('gate', `since ${hm(loop.gate.since)}`) : ''}
      ${tile(html`<span title="the job's own list price in the tranche plus its lanes'">spend</span>`, `${usd(loop.spend.totalUsd)}${loop.spend.perLanding != null ? ` · ${usd(loop.spend.perLanding)}/landing` : ''}`)}
      ${tile(`${j.name ?? 'job'} $`, usd(loop.spend.jobUsd))}
    </div>
    ${scoreEl(loop.score)}
    ${timeline(run, job)}
  </div>`
}

function ordinal(n: number): string {
  const words = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth']
  return words[n] ?? `${n}th`
}

// The scoreboard: each queue line's items with the delta against the base,
// the long lines (a battery of 28) folded to a count.
function scoreEl(lines: ScoreLine[]) {
  if (lines.length === 0) return html``
  const item = (i: ScoreLine['items'][number]) =>
    html`<span class="si" title="${i.label}: ${i.value.toLocaleString()}${i.of != null ? ` of ${i.of.toLocaleString()}` : ''}${i.open != null ? ` · ${i.open.toLocaleString()} at the base` : ''}"><span class="sl">${i.label}</span> <b>${i.value.toLocaleString()}</b>${i.of != null && i.of !== i.value ? html`<span class="muted">/${i.of.toLocaleString()}</span>` : ''}${i.delta ? html` <span class="delta ${i.delta > 0 ? 'up' : 'down'}">${i.delta > 0 ? '+' : ''}${i.delta.toLocaleString()}</span>` : ''}</span>`
  const moved = (l: ScoreLine) => l.items.reduce((n, i) => n + (i.delta ?? 0), 0)
  return html`<div class="score">
    ${lines.filter((l) => l.items.length <= 6).map((l) => html`<div class="sline"><span class="sn">${l.line}</span>${l.items.map(item)}</div>`)}
    ${lines
      .filter((l) => l.items.length > 6)
      .map(
        (l) => html`<details class="sline fold"><summary><span class="sn">${l.line}</span><span class="muted">${l.items.length} · ${l.items.filter((i) => i.of != null && i.value >= i.of).length} at their mark · ${moved(l) ? `${moved(l) > 0 ? '+' : ''}${moved(l).toLocaleString()} this tranche` : 'no change this tranche'}</span></summary><div class="sitems">${l.items.map(item)}</div></details>`,
      )}
  </div>`
}

// The tranche timeline. Rows: landings, the job (its turns as bands, its
// replies as ticks), then the lanes packed so concurrent ones stack.
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
  const booked = loop.tranche?.booked ?? []
  const rows = [...(booked.length || loop.tranche ? ['landings'] : []), loop.job.name ?? 'job', ...Array.from({ length: ends.length }, (_, i) => (i === 0 ? 'lanes' : ''))]
  const H = TOP + rows.length * LH + AX
  const yLand = TOP
  const yJob = TOP + (rows[0] === 'landings' ? LH : 0)
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
  for (const b of booked) {
    const lx = x(b.at)
    if (lx == null) continue
    parts.push(html`<rect class="m land" x="${(lx - 1).toFixed(2)}" y="${yLand + 1}" width="2" height="${LH - 2}"><title>${hms(b.at)} ${cut(b.subject, 100)} · ${b.sha}</title></rect>`)
    parts.push(html`<line class="landl" x1="${lx.toFixed(2)}" x2="${lx.toFixed(2)}" y1="${yLand + LH}" y2="${H - AX}" />`)
  }
  for (const [l, r] of rowOf) {
    const a = Math.max(Date.parse(l.spawnedAt ?? ''), t0)
    const b = Math.min(l.live ? t1 : Date.parse(l.last ?? ''), t1)
    if (!(b > a)) continue
    const lx = ((a - t0) / span) * PW
    const lw = Math.max(1.5, ((b - a) / span) * PW)
    const y = yLane(r)
    parts.push(html`<a href="/job/${encodeURIComponent(l.key)}"><rect class="ln st-${l.state ?? ''}" x="${lx.toFixed(2)}" y="${y + 2}" width="${lw.toFixed(2)}" height="${LH - 4}"><title>@${l.name ?? l.key.slice(0, 8)} · ${l.state ?? '?'} · spawned ${hms(l.spawnedAt)} → ${hms(l.last)} · ${usd(l.listUsd)}${l.landed ? ` · landed ${hms(l.landed.at)}` : ''}</title></rect></a>`)
    for (const m of l.msgs) {
      const mx = x(m)
      if (mx != null) parts.push(html`<rect class="m msg" x="${(mx - 1).toFixed(2)}" y="${y + 2}" width="2" height="${LH - 4}"><title>${hms(m)} @${l.name} → ${loop.job.name ?? 'job'}</title></rect>`)
    }
    if (lw >= 24) labels.push(html`<span class="bandn ln" style="left:${pct(lx)};top:${y - 1}px">${l.item ?? l.name ?? ''}</span>`)
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
  const closed = loop.tranche?.endAt != null
  return html`<figure class="tl run" role="img" aria-label="the tranche: landings, the ${loop.job.name ?? 'job'}, its lanes">
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
// steer pass that armed the tranche), then the job's across its /clears.
function strip(run: Run, traces: { job: Trace[]; parent: Trace[] }) {
  const all = [...traces.parent, ...traces.job]
  if (all.length === 0) return html`<div class="panel rail strip"><header><h2>said</h2><span class="sub">no session of the job in this window is indexed</span></header><div class="scroll"></div></div>`
  const parentIds = new Set(traces.parent.map((t) => t.session.sessionId))
  const pname = run.parent?.name
  return railBody(all, {
    name: run.loop.job.name,
    pages: true,
    title: 'said',
    sub: `${pname ? `the @${pname} pass that armed this tranche, then ` : ''}@${run.loop.job.name ?? 'the job'} across its /clears — a row opens the voice on the session's page`,
    rule: (t) => (parentIds.has(t.session.sessionId) ? `@${pname ?? 'parent'}` : `@${run.loop.job.name ?? 'job'}`),
  })
}

function lanesTable(run: Run) {
  const lanes = [...run.lanes].sort((a, b) => Number(b.live) - Number(a.live) || (b.spawnedAt ?? '').localeCompare(a.spawnedAt ?? ''))
  const t1 = Date.parse(run.window.to)
  return html`<div class="panel"><header><h2>lanes</h2><span class="sub">${lanes.length} this tranche${lanes.some((l) => l.live) ? ` · ${lanes.filter((l) => l.live).length} live` : ''} · ${lanes.filter((l) => l.landed).length} landed · live first, then newest</span></header><div class="scroll">
    <table class="ix lanes run">
      <thead><tr><th>lane</th><th>state</th><th>model</th><th>spawned</th><th class="num">wall</th><th class="num" title="the context the lane's next turn carries">ctx</th><th class="num">req</th><th class="num">list $</th><th class="num" title="messages the lane sent the job">msgs</th><th>landed</th></tr></thead>
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
          <td class="mono">${l.landed ? html`<span class="good">${clockEl(l.landed.at)}</span> <span class="muted">${l.landed.sha}</span>` : html`<span class="muted">—</span>`}</td>
        </tr>`
      })}</tbody>
    </table>
  </div></div>`
}
