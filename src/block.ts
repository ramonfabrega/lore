import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { cut, hm, hms, ms, tok, usd } from './fmt'
import type { Annotations, Instruction, Trace, Transaction } from './trace'
import { rateFor } from './usage'

// The block view (docs/EXPLORER.md, design pass 2026-09-01): one session
// rendered from `getTrace` alone. Three reads, top to bottom —
//
//   1. the header: identity, the fee split by token class (dollars, not
//      tokens — cache reads are 100× the tokens and a tenth of the money),
//      the model mix;
//   2. the map: a swimlane timeline of every instruction at its wall-clock
//      position, one lane per tool family, width = latency, errors in the
//      status color, transactions as bands you can click into;
//   3. the spine: the transactions, with inline bars so the expensive and
//      the slow ones read without reading digits; each opens into its
//      phases — the assistant's own between-instruction notes ("Now the
//      tests…") heading the run of steps that followed — then the closing
//      text.
//
// No client code: <details> is the only interaction. Text wears text ink;
// marks wear the series tokens; the lane label is the legend.

type H = HtmlEscapedString | Promise<HtmlEscapedString>

// Tool families — the lanes. Fixed order; at most three hued lanes (the
// all-pairs cap), the rest neutral. Lane position carries identity, the
// hue is redundant on purpose.
const FAMILY: Record<string, string> = {
  Read: 'read', Grep: 'read', Glob: 'read', LS: 'read', WebFetch: 'read', WebSearch: 'read', ToolSearch: 'read', LSP: 'read',
  TaskList: 'read', TaskGet: 'read', ListAgents: 'read',
  Edit: 'write', Write: 'write', MultiEdit: 'write', NotebookEdit: 'write',
  Bash: 'run',
  Agent: 'agent', Task: 'agent', Workflow: 'agent', Skill: 'agent', SendMessage: 'agent',
}
const LANES = ['say', 'read', 'write', 'run', 'agent', 'other'] as const
export function family(tool: string): string {
  return FAMILY[tool] ?? 'other'
}

export function tile(label: string, value: string, cls = '') {
  return html`<div class="tile ${cls}"><div class="v">${value}</div><div class="l">${label}</div></div>`
}

export function annotationLine(a: Annotations) {
  const parts: (H | string)[] = []
  if (a.files.length) parts.push(html`<span title="${a.files.join('\n')}">${a.files.length} file${a.files.length === 1 ? '' : 's'}</span>`)
  if (a.commands) parts.push(`${a.commands} cmd${a.commands === 1 ? '' : 's'}`)
  if (a.tests.ran) parts.push(html`tests ${a.tests.ran}: <span class="${a.tests.failed ? 'err' : ''}">${a.tests.failed} fail</span> / ${a.tests.passed} pass`)
  if (a.commits.length) parts.push(html`commit ${a.commits.map((c) => html`<span class="mono">${c}</span> `)}`)
  if (a.retries) parts.push(`${a.retries} retr${a.retries === 1 ? 'y' : 'ies'}`)
  if (!parts.length) return html``
  return html`<p class="ann muted small">${parts.map((p, i) => html`${i ? ' · ' : ''}${p}`)}</p>`
}

// ---- the page ------------------------------------------------------------

export function sessionBody(trace: Trace, o: { open?: boolean } = {}) {
  const s = trace.session
  const t = trace.totals
  const txs = trace.transactions
  const prompts = txs.filter((x) => x.kind === 'prompt')
  // A one-prompt session IS its transaction: open it. A conversation
  // stays folded so the spine reads first.
  const openAll = prompts.length <= 2
  const maxUsd = Math.max(...txs.map((x) => x.listUsd ?? 0), 0)
  const maxMs = Math.max(...txs.map((x) => x.ms ?? 0), 0)
  const models = modelMix(txs)
  const fee = feeByClass(txs)
  // Transactions the user started get the numbers; harness preamble (meta)
  // rows stay unnumbered so #1 is the first prompt on every surface.
  const num = new Map<Transaction, number>()
  txs.forEach((x) => {
    if (x.kind !== 'meta') num.set(x, num.size + 1)
  })
  return html`
    <p class="crumbs"><a href="/">lore</a> / <a href="/well/${encodeURIComponent(s.well)}">${s.well}</a> / session</p>
    <h1 class="mono">${s.sessionId}</h1>
    <p class="muted">${s.first?.slice(0, 10) ?? ''} ${hms(s.first)} → ${s.last?.slice(0, 10) === s.first?.slice(0, 10) ? '' : `${s.last?.slice(0, 10) ?? ''} `}${hms(s.last)} UTC
      · ${ms(t.ms)} wall · ${s.lines} lines${s.jobSessionId ? html` · job <a class="mono" href="/job/${s.jobSessionId}">${s.jobSessionId.slice(0, 8)}</a>` : ''}
      ${models.length ? html` · ${models.map((m, i) => html`${i ? ', ' : ''}<span class="mono">${m.model}</span> ×${m.n}`)}` : ''}</p>
    <div class="tiles">
      ${tile('transactions', String(prompts.length))}
      ${tile('steps', String(t.steps))}
      ${tile('instructions', String(t.instructions))}
      ${tile('errors', String(t.errors), t.errors > 0 ? 'warn' : '')}
      ${tile('output', tok(t.output))}
      ${tile('cache-read', tok(t.cacheRead))}
      ${tile('list $', usd(t.listUsd))}
      ${t.spawns ? tile('spawns', `${t.spawns} · ${tok(t.spawnOutput)} out`) : ''}
    </div>
    ${feeBar(fee)}
    ${timeline(trace, num)}
    <section class="spine">
      <div class="row head"><span class="n">#</span><span class="at">at</span><span class="p">prompt</span><span class="num">steps</span><span class="num">instr</span><span class="num">err</span><span class="num">out</span><span class="num">list $</span><span class="num">wall</span></div>
      ${txs.map((x, i) => txRow(x, i, { n: num.get(x) ?? null, open: (openAll || o.open === true) && x.kind === 'prompt', openPhases: o.open === true, maxUsd, maxMs }))}
    </section>`
}

function modelMix(txs: Transaction[]): { model: string; n: number }[] {
  const n = new Map<string, number>()
  for (const x of txs) for (const r of x.requests ?? []) if (r.model) n.set(r.model, (n.get(r.model) ?? 0) + 1)
  return [...n].map(([model, count]) => ({ model, n: count })).sort((a, b) => b.n - a.n)
}

// ---- the fee bar ------------------------------------------------------

type Fee = { input: number; cacheWrite: number; cacheRead: number; output: number; unpriced: number }
function feeByClass(txs: Transaction[]): Fee {
  const f: Fee = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, unpriced: 0 }
  for (const x of txs)
    for (const r of x.requests ?? []) {
      const rate = rateFor(r.model, r.ts?.slice(0, 10) ?? null)
      if (!rate) {
        f.unpriced++
        continue
      }
      f.input += (r.input * rate.input) / 1e6
      f.cacheWrite += (r.cacheWrite * rate.cacheWrite) / 1e6
      f.cacheRead += (r.cacheRead * rate.cacheRead) / 1e6
      f.output += (r.output * rate.output) / 1e6
    }
  return f
}

// One stacked bar of the list-price fee by token class, direct-labeled
// below (text ink beside a swatch). Segments keep a 2px surface gap and a
// 2px floor so a tiny class still registers.
function feeBar(f: Fee) {
  const parts = [
    { key: 'output', label: 'output', v: f.output },
    { key: 'cache-read', label: 'cache read', v: f.cacheRead },
    { key: 'cache-write', label: 'cache write', v: f.cacheWrite },
    { key: 'input', label: 'input', v: f.input },
  ]
  const total = parts.reduce((a, p) => a + p.v, 0)
  if (total <= 0) return html``
  return html`<figure class="fee">
    <div class="feebar" role="img" aria-label="${parts.map((p) => `${p.label} ${usd(p.v)}`).join(', ')}">
      ${parts.map((p) => html`<span class="seg ${p.key}" style="flex-basis:${((p.v / total) * 100).toFixed(2)}%" title="${p.label} ${usd(p.v)}"></span>`)}
    </div>
    <figcaption class="small muted">${parts.map(
      (p) => html`<span class="key"><i class="sw ${p.key}"></i>${p.label} <b>${usd(p.v)}</b> <span class="pct">${Math.round((p.v / total) * 100)}%</span></span>`,
    )}${f.unpriced ? html`<span class="key err">${f.unpriced} unpriced steps</span>` : ''}</figcaption>
  </figure>`
}

// ---- the timeline -----------------------------------------------------

// Every instruction at its wall-clock x, in the lane of its family, width
// = latency (1.5px floor so a 40 ms Read still exists), errors in the
// status color. `say` marks the assistant's notes and closing text — the
// phase boundaries. Transactions are bands behind, numbered, linked.
function timeline(trace: Trace, num: Map<Transaction, number>) {
  const s = trace.session
  if (!s.first || !s.last) return html``
  const t0 = Date.parse(s.first)
  const span = Math.max(1, Date.parse(s.last) - t0)
  const W = 1200
  const G = 40 // lane-label gutter
  const TOP = 14 // transaction band labels
  const LH = 12
  const AX = 14
  const x = (ts: string | null) => (ts ? G + ((Date.parse(ts) - t0) / span) * (W - G) : null)
  const w = (msv: number | null) => Math.max(1.5, ((msv ?? 0) / span) * (W - G))

  const present = new Set<string>()
  for (const tx of trace.transactions) {
    for (const ix of tx.instructions) present.add(family(ix.tool))
    if (tx.notes.length || tx.reply) present.add('say')
  }
  const lanes = LANES.filter((l) => present.has(l))
  if (lanes.length === 0) return html``
  const laneY = new Map(lanes.map((l, i) => [l, TOP + i * LH]))
  const H = TOP + lanes.length * LH + AX

  const bands: H[] = []
  const marks: H[] = []
  trace.transactions.forEach((tx, i) => {
    const bx = x(tx.ts)
    if (bx == null || !tx.ms) return
    const bw = Math.max(1, (tx.ms / span) * (W - G))
    const href = tx.promptId ? `#tx-${tx.promptId}` : `#tx-${i}`
    bands.push(html`<a href="${href}"><rect class="band ${i % 2 ? 'alt' : ''} ${tx.kind}" x="${bx.toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H - AX}"><title>#${num.get(tx) ?? '–'} ${cut(tx.prompt, 80)} · ${ms(tx.ms)} · ${usd(tx.listUsd)}</title></rect>${
      bw >= 10 && tx.kind === 'prompt' ? html`<text class="bandn" x="${(bx + 2).toFixed(1)}" y="10">${num.get(tx) ?? ''}</text>` : ''
    }</a>`)
    for (const ix of tx.instructions) {
      const mx = x(ix.ts)
      if (mx == null) continue
      const fam = family(ix.tool)
      const y = laneY.get(fam)
      if (y == null) continue
      marks.push(html`<rect class="m ${fam} ${ix.error ? 'err' : ''}" x="${mx.toFixed(1)}" y="${y + 1}" width="${w(ix.ms).toFixed(1)}" height="${LH - 2}"><title>${hms(ix.ts)} ${ix.tool} · ${ms(ix.ms)}${ix.error ? ' · error' : ''}\n${cut(ix.input, 120)}</title></rect>`)
    }
    const sy = laneY.get('say')
    if (sy != null) {
      for (const n of tx.notes) {
        const nx = x(n.ts)
        if (nx != null) marks.push(html`<rect class="m say" x="${nx.toFixed(1)}" y="${sy + 1}" width="2" height="${LH - 2}"><title>${hms(n.ts)} ${cut(n.text, 120)}</title></rect>`)
      }
      if (tx.reply && tx.ts && tx.ms) {
        const rx = x(new Date(Date.parse(tx.ts) + tx.ms).toISOString())
        if (rx != null) marks.push(html`<rect class="m say reply" x="${(rx - 2).toFixed(1)}" y="${sy + 1}" width="2" height="${LH - 2}"><title>reply · ${cut(tx.reply, 120)}</title></rect>`)
      }
    }
  })

  // Axis: clock ticks at a nice step (≤ 12 across), labels HH:MM UTC.
  const stepMin = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480].find((m) => span / (m * 60_000) <= 12) ?? 1440
  const ticks: H[] = []
  const first = Math.ceil(t0 / (stepMin * 60_000)) * stepMin * 60_000
  for (let tt = first; tt <= t0 + span; tt += stepMin * 60_000) {
    const tx = G + ((tt - t0) / span) * (W - G)
    ticks.push(html`<line class="tick" x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="${TOP}" y2="${H - AX}" />${tx <= W - 30 ? html`<text class="axis" x="${(tx + 2).toFixed(1)}" y="${H - 3}">${hm(new Date(tt).toISOString())}</text>` : ''}`)
  }

  return html`<figure class="tl" role="img" aria-label="timeline of ${trace.totals.instructions} instructions over ${ms(trace.totals.ms)}">
    <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMinYMid meet">
      ${bands}
      ${ticks}
      ${lanes.map((l) => html`<text class="lane" x="0" y="${(laneY.get(l) ?? 0) + LH - 3}">${l}</text><line class="lanel" x1="${G}" x2="${W}" y1="${(laneY.get(l) ?? 0) + LH}" y2="${(laneY.get(l) ?? 0) + LH}" />`)}
      ${marks}
    </svg>
  </figure>`
}

// ---- the spine --------------------------------------------------------

function txRow(x: Transaction, i: number, o: { n: number | null; open: boolean; openPhases: boolean; maxUsd: number; maxMs: number }) {
  const id = x.promptId ? `tx-${x.promptId}` : `tx-${i}`
  const cells = html`<span class="n muted">${o.n ?? ''}</span><span class="at mono muted">${hms(x.ts)}</span>
    <span class="p">${x.kind !== 'prompt' ? html`<span class="kind ${x.kind}">${x.kind}</span> ` : ''}<span class="${x.kind === 'prompt' ? 'ptext' : 'ptext muted'}">${x.prompt || raw('&nbsp;')}</span></span>
    <span class="num">${x.steps || ''}</span>
    <span class="num">${x.instructions.length || ''}</span>
    <span class="num ${x.errors ? 'err' : ''}">${x.errors || ''}</span>
    <span class="num">${x.output ? tok(x.output) : ''}</span>
    <span class="num">${x.listUsd ? html`${ibar(x.listUsd, o.maxUsd)}${usd(x.listUsd)}` : ''}</span>
    <span class="num">${x.ms ? html`${ibar(x.ms, o.maxMs)}${ms(x.ms)}` : ''}</span>`
  const body = x.instructions.length || x.reply || x.notes.length
  if (!body) return html`<div class="row txn ${x.kind}" id="${id}">${cells}</div>`
  return html`<details class="txn ${x.kind}" id="${id}" ${o.open ? 'open' : ''}>
    <summary class="row">${cells}</summary>
    <div class="body">
      ${annotationLine(x.annotations)}
      ${txBody(x, o.openPhases)}
    </div>
  </details>`
}

// An inline bar beside a number: the value as a fraction of the session's
// largest, so the heavy transaction is visible before it is read.
function ibar(v: number, max: number) {
  if (!(max > 0)) return html``
  return html`<span class="ib" aria-hidden="true"><i style="width:${Math.max(2, Math.round((v / max) * 100))}%"></i></span>`
}

// Phases: each note heads the run of instructions up to the next note.
// A transaction with no notes is one implicit phase, rendered bare.
function txBody(x: Transaction, openPhases: boolean) {
  const stepFee = new Map((x.requests ?? []).map((r) => [r.requestId, r]))
  const len = x.instructions.length
  const phases: { note: { text: string; ts: string | null } | null; from: number; to: number }[] = []
  const firstAt = x.notes[0]?.at ?? len
  if (firstAt > 0) phases.push({ note: null, from: 0, to: firstAt })
  x.notes.forEach((n, k) => phases.push({ note: n, from: n.at, to: x.notes[k + 1]?.at ?? len }))
  if (phases.length === 0) phases.push({ note: null, from: 0, to: len })
  const many = x.notes.length > 1

  return html`
    ${phases.map((p) => {
      const ix = x.instructions.slice(p.from, p.to)
      const table = ix.length ? ixTable(x, p.from, p.to, stepFee) : html``
      if (!p.note) return table
      const errs = ix.filter((i) => i.error).length
      const t0 = ix[0]?.ts
      const t1 = ix[ix.length - 1]?.ts
      const span = t0 && t1 ? Date.parse(t1) - Date.parse(t0) : null
      const meta = html`<span class="muted small">${ix.length ? `${ix.length} instr` : ''}${span ? ` · ${ms(span)}` : ''}${errs ? html` · <span class="err">${errs} err</span>` : ''}</span>`
      return many
        ? html`<details class="phase" ${openPhases ? 'open' : ''}><summary><span class="note">${p.note.text}</span> ${meta}</summary>${table}</details>`
        : html`<p class="note">${p.note.text} ${meta}</p>${table}`
    })}
    ${x.reply ? html`<p class="reply">${x.reply}</p>` : ''}`
}

function ixTable(x: Transaction, from: number, to: number, stepFee: Map<string, { output: number; listUsd: number | null; thinking: number }>) {
  const rows: H[] = []
  let lastReq: string | null | undefined
  const thoughts = x.thoughts.filter((t) => t.at >= from && t.at < to)
  for (let i = from; i < to; i++) {
    const ix = x.instructions[i]!
    for (const th of thoughts) if (th.at === i) rows.push(thoughtRow(th.text))
    const newStep = ix.requestId !== lastReq
    lastReq = ix.requestId
    const fee = newStep && ix.requestId ? stepFee.get(ix.requestId) : undefined
    rows.push(html`<tr class="${family(ix.tool)} ${ix.error ? 'err' : ''} ${newStep ? 'step' : ''}">
      <td class="mono muted t">${hms(ix.ts)}</td>
      <td class="mono tool"><i class="sw ${family(ix.tool)}"></i>${ix.tool}</td>
      <td class="mono small in">${inputHead(ix.tool, ix.input)}</td>
      <td class="num muted">${ms(ix.ms)}</td>
      <td class="small res">${ix.error ? html`<span class="kind err">error</span> ` : ''}${cut(ix.result, 200)}</td>
      <td class="num muted small fee">${fee ? html`${tok(fee.output)}${fee.thinking ? html` <span title="thinking">(${tok(fee.thinking)}t)</span>` : ''} · ${usd(fee.listUsd)}` : ''}</td>
    </tr>`)
  }
  return html`<table class="ix">
    <thead><tr><th>at</th><th>tool</th><th>input</th><th class="num">ms</th><th>result</th><th class="num">step out · $</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

// The argument that names the call: Bash's command, a file tool's path,
// Grep's pattern, an Agent's description — else the JSON head. The input
// is already cut, so a long one may not parse; the raw head is the fallback.
function inputHead(tool: string, input: string): H | string {
  let j: unknown
  try {
    j = JSON.parse(input)
  } catch {
    return cut(input, 200)
  }
  if (!j || typeof j !== 'object') return cut(input, 200)
  const o = j as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null)
  const main =
    str('command') ?? str('file_path') ?? str('notebook_path') ?? str('pattern') ?? str('query') ?? str('url') ?? str('description') ?? str('prompt') ?? str('skill')
  if (main == null) return cut(input, 200)
  const path = tool === 'Grep' || tool === 'Glob' ? str('path') : null
  const desc = tool === 'Bash' ? str('description') : tool === 'Agent' ? str('subagent_type') : null
  return html`${cut(main, 200)}${path ? html` <span class="muted">in ${cut(path, 60)}</span>` : ''}${desc ? html` <span class="muted">— ${cut(desc, 80)}</span>` : ''}`
}

function thoughtRow(text: string) {
  return html`<tr class="thought"><td colspan="6"><details><summary class="muted small">thinking</summary><p class="small muted">${text}</p></details></td></tr>`
}

export type { Instruction }
