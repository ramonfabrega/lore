import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { sentHead } from './envelope'
import { cut, day, hm, hms, ms, tok, usd, zone } from './fmt'
import { modelDrift, modelLabel } from './model'
import type { Annotations, Instruction, SpawnGroup, Trace, Transaction } from './trace'
import { priceOf, rateFor } from './usage'
import { type FeeSplit, feeBar, ibar, modelChip } from './viz'

// The block view (docs/EXPLORER.md, design pass 2026-09-01): one session
// rendered from `getTrace` alone. Three reads, top to bottom —
//
//   1. the header: identity, the fee split by token class (dollars, not
//      tokens — cache reads are 100× the tokens and a tenth of the money),
//      the model mix, and the fan-out ledger (which agent type ran on which
//      VERIFIED model — the standing fleet question, answered here and not
//      only in `lore spawns`);
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
const LANES: readonly string[] = ['say', 'read', 'write', 'run', 'agent', 'other']
export function family(tool: string): string {
  return FAMILY[tool] ?? 'other'
}

export function tile(label: string | H, value: string, cls = '') {
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
  // A turn is a transaction somebody OPENED — the user typing, the user's
  // slash command, or a peer session relaying in. Harness preamble (meta)
  // opened nothing, so it is neither counted nor numbered, and the tile and
  // the spine's numbers agree: a session with eight relays in it says so.
  const turns = txs.filter((x) => x.kind !== 'meta')
  // A one-prompt session IS its transaction: open it. A conversation
  // stays folded so the spine reads first.
  const openAll = turns.length <= 2
  const maxUsd = Math.max(...txs.map((x) => x.listUsd ?? 0), 0)
  const maxMs = Math.max(...txs.map((x) => x.ms ?? 0), 0)
  const fee = feeByClass(txs)
  // A session that ran one model says so once, in the header. A session that
  // SWITCHED gets a column: which prompt ran on what is the whole question.
  const mixed = trace.models.length > 1
  const num = new Map<Transaction, number>(turns.map((x, i) => [x, i + 1]))
  // The peers this session spoke with — a relay that opened a turn, one read
  // mid-turn, or a send the address book named — each a way into the thread
  // page, where the exchange reads with neither side nested in the other.
  const peers = [...new Set(txs.flatMap((x) => [
    x.kind === 'relay' ? x.tag : null,
    ...x.received.filter((r) => r.kind === 'relay').map((r) => r.tag),
    ...x.sent.map((sn) => sn.name),
  ]).filter((p): p is string => p != null))]
  return html`
    <div class="page-head">
    <p class="crumbs"><a href="/">lore</a> / <a href="/well/${encodeURIComponent(s.well)}">${s.well}</a> / session</p>
    <h1 class="mono">${s.sessionId}${s.name ? html` <span class="kind self" title="this session's agent">@${s.name}</span>` : ''}</h1>
    <p class="muted">${day(s.first)} ${hms(s.first)} → ${day(s.last) === day(s.first) ? '' : `${day(s.last)} `}${hms(s.last)} ${zone()}
      · ${ms(t.ms)} wall · ${s.lines} lines${s.jobKey ? html` · job <a class="mono" href="/job/${encodeURIComponent(s.jobKey)}" title="${s.jobKey}">${s.name ? `@${s.name}` : s.jobKey.slice(0, 8)}</a>` : ''}
      ${trace.models.map((m) => html` · ${modelChip(m.model)} <span class="muted">×${m.requests}</span>`)}${
        peers.length ? html` · thread with ${peers.map((p, i) => html`${i ? ', ' : ''}<a href="/thread/${encodeURIComponent(s.name ?? s.sessionId)}/${encodeURIComponent(p)}">@${p}</a>`)}` : ''
      }</p>
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
    ${feeBar(fee, { unpriced: fee.unpriced })}
    ${fanout(trace.spawns)}
    ${timeline(trace, num)}
    </div>
    <div class="panel"><div class="scroll">
    <section class="spine ${mixed ? 'mixed' : ''}">
      <div class="row head"><span class="n">#</span><span class="at">at</span><span class="p">prompt</span>${mixed ? html`<span class="m">model</span>` : ''}<span class="num">steps</span><span class="num">instr</span><span class="num">err</span><span class="num">out</span><span class="num">list $</span><span class="num">wall</span></div>
      ${txs.map((x, i) => txRow(x, i, { n: num.get(x) ?? null, open: (openAll || o.open === true) && x.kind !== 'meta', openPhases: o.open === true, maxUsd, maxMs, mixed }))}
    </section>
    </div></div>`
}

// The fan-out ledger: agent type × verified model, heaviest first. The
// requested alias is shown only when it was passed AND the served model does
// not contain it — the drift rule `lore spawns` uses (model.ts), on the page
// where the fan-out actually happened.
function fanout(groups: SpawnGroup[]) {
  if (groups.length === 0) return html``
  return html`<p class="fan small"><span class="muted">fan-out</span>
    ${groups.map((g) => {
      const drift = modelDrift(g.requestedModel, g.model) === true
      const asked = g.requestedModel ? ` · asked ${g.requestedModel}` : ''
      return html`<span class="g" title="${g.n} spawn${g.n === 1 ? '' : 's'} · ${g.model ?? 'model unknown'}${asked} · ${g.output.toLocaleString()} output tokens">
        <b>${g.n}×</b> ${g.agentType ?? '?'} ${modelChip(g.model)}${drift ? html` <span class="kind err">asked ${g.requestedModel}</span>` : ''} <span class="muted">· ${tok(g.output)} out</span></span>`
    })}</p>`
}

// ---- the fee bar ------------------------------------------------------

type Fee = FeeSplit & { unpriced: number }
function feeByClass(txs: Transaction[]): Fee {
  const f: Fee = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, unpriced: 0 }
  for (const x of txs)
    for (const r of x.requests ?? []) {
      // The rate DATE is a vendor fact (when a price changed), not a day in
      // the reader's life — it stays UTC while the buckets around it go local.
      const rate = rateFor(r.model, r.ts?.slice(0, 10) ?? null)
      if (!rate) {
        f.unpriced++
        continue
      }
      const usd = priceOf(r, rate)
      f.input += usd.input
      f.cacheWrite += usd.cacheWrite
      f.cacheRead += usd.cacheRead
      f.output += usd.output
    }
  return f
}

// ---- the timeline -----------------------------------------------------

// Every instruction at its wall-clock x, in the lane of its family, width
// = latency (1.5‰ floor so a 40 ms Read still exists), errors in the
// status color. `say` marks the assistant's notes and closing text — the
// phase boundaries. Transactions are bands behind, numbered, linked.
//
// The plot is an SVG stretched to the panel (preserveAspectRatio none):
// x in permille of the plot's width, y in CSS pixels. Only widths stretch,
// and widths are time spans, so the stretch is exact. Type — lane labels,
// band numbers, the axis — is HTML at 9px, positioned by percentage, so it
// stays 9px whether the panel is 700px or 2000px wide.
function timeline(trace: Trace, num: Map<Transaction, number>) {
  const s = trace.session
  if (!s.first || !s.last) return html``
  const t0 = Date.parse(s.first)
  const span = Math.max(1, Date.parse(s.last) - t0)
  const PW = 1000 // permille
  const TOP = 14 // transaction band numbers
  const LH = 12
  const AX = 14
  const x = (ts: string | null) => (ts ? ((Date.parse(ts) - t0) / span) * PW : null)
  const w = (msv: number | null) => Math.max(1.5, ((msv ?? 0) / span) * PW)
  const pct = (v: number) => `${(v / 10).toFixed(2)}%`

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
  const labels: H[] = []
  trace.transactions.forEach((tx, i) => {
    const bx = x(tx.ts)
    if (bx == null || !tx.ms) return
    const bw = Math.max(1, (tx.ms / span) * PW)
    const href = tx.promptId ? `#tx-${tx.promptId}` : `#tx-${i}`
    bands.push(html`<a href="${href}"><rect class="band ${i % 2 ? 'alt' : ''} ${tx.kind}" x="${bx.toFixed(2)}" y="0" width="${bw.toFixed(2)}" height="${H - AX}"><title>#${num.get(tx) ?? '–'} ${cut(tx.prompt, 80)} · ${ms(tx.ms)} · ${usd(tx.listUsd)}</title></rect></a>`)
    if (bw >= 9 && tx.kind === 'prompt') labels.push(html`<span class="bandn" style="left:${pct(bx)}">${num.get(tx) ?? ''}</span>`)
    for (const ix of tx.instructions) {
      const mx = x(ix.ts)
      if (mx == null) continue
      const fam = family(ix.tool)
      const y = laneY.get(fam)
      if (y == null) continue
      marks.push(html`<rect class="m ${fam} ${ix.error ? 'err' : ''}" x="${mx.toFixed(2)}" y="${y + 1}" width="${w(ix.ms).toFixed(2)}" height="${LH - 2}"><title>${hms(ix.ts)} ${ix.tool} · ${ms(ix.ms)}${ix.error ? ' · error' : ''}\n${cut(ix.input, 120)}</title></rect>`)
    }
    const sy = laneY.get('say')
    if (sy != null) {
      for (const n of tx.notes) {
        const nx = x(n.ts)
        if (nx != null) marks.push(html`<rect class="m say" x="${nx.toFixed(2)}" y="${sy + 1}" width="1.5" height="${LH - 2}"><title>${hms(n.ts)} ${cut(n.text, 120)}</title></rect>`)
      }
      if (tx.reply && tx.ts && tx.ms) {
        const rx = x(new Date(Date.parse(tx.ts) + tx.ms).toISOString())
        if (rx != null) marks.push(html`<rect class="m say reply" x="${(rx - 1.5).toFixed(2)}" y="${sy + 1}" width="1.5" height="${LH - 2}"><title>reply · ${cut(tx.reply, 120)}</title></rect>`)
      }
    }
  })

  // Axis: clock ticks at a nice step (≤ 12 across), labels HH:MM local.
  const stepMin = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480].find((m) => span / (m * 60_000) <= 12) ?? 1440
  const ticks: H[] = []
  const axis: H[] = []
  const first = Math.ceil(t0 / (stepMin * 60_000)) * stepMin * 60_000
  for (let tt = first; tt <= t0 + span; tt += stepMin * 60_000) {
    const tx = ((tt - t0) / span) * PW
    ticks.push(html`<line class="tick" x1="${tx.toFixed(2)}" x2="${tx.toFixed(2)}" y1="${TOP}" y2="${H - AX}" />`)
    if (tx <= PW - 40) axis.push(html`<span class="axis" style="left:${pct(tx)}">${hm(new Date(tt).toISOString())}</span>`)
  }

  return html`<figure class="tl" role="img" aria-label="timeline of ${trace.totals.instructions} instructions over ${ms(trace.totals.ms)}">
    <div class="lanes" style="padding-top:${TOP}px">${lanes.map((l) => html`<span>${l}</span>`)}</div>
    <div class="plot" style="height:${H}px">
      <svg viewBox="0 0 ${PW} ${H}" preserveAspectRatio="none">
        ${bands}
        ${ticks}
        ${lanes.map((l) => html`<line class="lanel" x1="0" x2="${PW}" y1="${(laneY.get(l) ?? 0) + LH}" y2="${(laneY.get(l) ?? 0) + LH}" />`)}
        ${marks}
      </svg>
      ${labels}${axis}
    </div>
  </figure>`
}

// ---- the spine --------------------------------------------------------

function txRow(x: Transaction, i: number, o: { n: number | null; open: boolean; openPhases: boolean; maxUsd: number; maxMs: number; mixed?: boolean }) {
  const id = x.promptId ? `tx-${x.promptId}` : `tx-${i}`
  // The chip carries the envelope so the text doesn't (trace.ts): a relay
  // wears its sender, `@lore`, and reads in full ink — another agent's turn
  // is work, not preamble. Harness injections wear what they are and stay
  // muted.
  const chip = x.kind === 'relay' ? `@${x.tag ?? 'peer'}` : x.kind === 'meta' ? (x.tag ?? 'meta') : x.kind === 'command' ? 'command' : null
  const cells = html`<span class="n muted">${o.n ?? ''}</span><span class="at mono muted">${hms(x.ts)}</span>
    <span class="p">${chip ? html`<span class="kind ${x.kind} ${x.tag ?? ''}">${chip}</span> ` : ''}<span class="${x.kind === 'meta' ? 'ptext muted' : 'ptext'}">${x.prompt || raw('&nbsp;')}</span>${receivedBadges(x.received)}${sentBadges(x.sent)}</span>
    ${o.mixed ? html`<span class="m">${modelChip(x.model)}</span>` : ''}
    <span class="num">${x.steps || ''}</span>
    <span class="num">${x.instructions.length || ''}</span>
    <span class="num ${x.errors ? 'err' : ''}">${x.errors || ''}</span>
    <span class="num">${x.output ? tok(x.output) : ''}</span>
    <span class="num">${x.listUsd ? html`${ibar(x.listUsd, o.maxUsd, { of: 'priciest transaction in this session' })}${usd(x.listUsd)}` : ''}</span>
    <span class="num">${x.ms ? html`${ibar(x.ms, o.maxMs, { of: 'longest transaction in this session', fmt: ms })}${ms(x.ms)}` : ''}</span>`
  const body = x.instructions.length || x.reply || x.notes.length || x.received.length
  if (!body) return html`<div class="row txn ${x.kind}" id="${id}">${cells}</div>`
  return html`<details class="txn ${x.kind} ${x.message ? 'hasmsg' : ''}" id="${id}" ${o.open ? 'open' : ''}>
    <summary class="row">${cells}</summary>
    <div class="body">
      ${annotationLine(x.annotations)}
      ${x.message ? html`<p class="msg">${x.message}</p>` : ''}
      ${txBody(x, o.openPhases)}
    </div>
  </details>`
}

// One badge per recipient, with a count — never one per message. A turn that
// answered a peer six times says `→ @lore ×6`; six identical chips said the
// same thing six times and cost the row its width. The summaries differ and
// are worth reading, so they ride the title here and the body below.
function sentBadges(sent: Transaction['sent']) {
  if (sent.length === 0) return html``
  // A follow-up to one of the session's own spawns is not a message to a
  // peer: it wears `agent`, neutral, with the spawn's description in the
  // title — never `@af80d234…` beside `@lore` as if it were a third session.
  const byTo = new Map<string, { addr: string; agent: boolean; lost: number; lines: string[] }>()
  for (const s of sent) {
    const label = s.agent ? 'agent' : (s.name ?? shortTo(s.to))
    const g = byTo.get(label) ?? { addr: s.agent ? `${s.to ?? '?'} · ${s.agent}` : (s.to ?? '?'), agent: s.agent != null, lost: 0, lines: [] }
    g.lines.push(`${s.delivered === false ? 'LOST · ' : ''}${s.summary ?? ''}`)
    if (s.delivered === false) g.lost++
    byTo.set(label, g)
  }
  // A send the ack refused is not a send: it wears the status colour and
  // says so, since the row would otherwise advertise a message nobody got.
  return html`${[...byTo].map(
    ([label, g]) =>
      html`<span class="kind sent ${g.agent ? 'agent' : ''} ${g.lost ? 'lost' : ''}" title="${[g.addr, ...g.lines.filter(Boolean)].join('\n')}">→ ${g.agent ? '' : '@'}${label}${g.lines.length > 1 ? html` <b>×${g.lines.length}</b>` : ''}${g.lost ? html` <b class="err">${g.lost} lost</b>` : ''}</span>`,
  )}`
}

// The inbound half that did not open the turn: one badge per sender, with a
// count — `← @lore ×6`, `← you ×3`. The same signal-not-list rule as the
// outbound badge. A harness notification read mid-turn is in the table
// below but earns no badge; the row would say `task ×12` on every long turn.
function receivedBadges(received: Transaction['received']) {
  const byFrom = new Map<string, { you: boolean; lines: string[] }>()
  for (const r of received) {
    if (r.kind === 'meta') continue
    const label = r.kind === 'prompt' ? 'you' : `@${r.tag ?? 'peer'}`
    const g = byFrom.get(label) ?? { you: r.kind === 'prompt', lines: [] }
    g.lines.push(cut(r.text, 120))
    byFrom.set(label, g)
  }
  if (byFrom.size === 0) return html``
  return html`${[...byFrom].map(
    ([label, g]) => html`<span class="kind recv ${g.you ? 'you' : ''}" title="${g.lines.join('\n')}">← ${label}${g.lines.length > 1 ? html` <b>×${g.lines.length}</b>` : ''}</span>`,
  )}`
}

// An outgoing message, in the instruction stream where it happened. The
// recipient is named from the session's own address book (trace.ts) so this
// and the row badge never disagree — they did, `@32093` against `@lore`.
function sentCell(ix: Instruction) {
  const { summary } = sentHead(ix.input)
  if (ix.toAgent) return html`<b title="${ix.to ?? ''}">→ agent</b> <span class="muted">${cut(ix.toAgent, 60)}</span> <span class="msgline">${cut(summary ?? ix.input, 200)}</span>`
  const label = ix.toName ?? shortTo(ix.to ?? null)
  return html`<b title="${ix.to ?? ''}">→ @${label}</b> <span class="msgline">${cut(summary ?? ix.input, 200)}</span>`
}

// A message read mid-turn, in the instruction stream where the turn read it
// (trace.ts `received`): the peer's words, the user's, or a harness
// notification, at the tool result it was delivered after. The row is the
// preview; a message longer than it unfolds in full beneath.
const RECV_PREVIEW = 240
function receivedRow(r: Transaction['received'][number]) {
  const who = r.kind === 'relay' ? html`<b>← @${r.tag ?? 'peer'}</b>` : r.kind === 'prompt' ? html`<b>← you</b>` : html`<span class="muted">← ${r.tag ?? 'harness'}</span>`
  const long = r.text.length > RECV_PREVIEW
  return html`<tr class="recv ${r.kind}">
    <td class="mono muted t">${hms(r.ts)}</td>
    <td class="mono tool"><i class="sw agent"></i>${r.kind === 'relay' ? 'message' : r.kind === 'prompt' ? 'you' : 'harness'}</td>
    <td class="in" colspan="4">${who} <span class="msgline">${cut(r.text, RECV_PREVIEW)}</span>${long ? html`<details><summary class="muted small">full message</summary><p class="msgfull">${r.text}</p></details>` : ''}</td>
  </tr>`
}

// A recipient the address book could not name: a raw unix socket, or a task
// id when the call went to a background agent rather than a peer. Show the
// part that identifies it, not the path around it — the full address rides
// the title.
function shortTo(to: string | null): string {
  if (!to) return '?'
  const tail = to.replace(/^uds:/, '').split('/').filter(Boolean).pop() ?? to
  const name = tail.replace(/\.sock$/, '')
  return name.length > 12 ? `${name.slice(0, 8)}…` : name
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
    ${phases.map((p, k) => {
      const ix = x.instructions.slice(p.from, p.to)
      // A message read after the last instruction sits at cursor `len`; it
      // belongs to the last phase.
      const last = k === phases.length - 1
      const recv = x.received.filter((r) => r.at >= p.from && (r.at < p.to || (last && r.at === p.to)))
      const table = ix.length || recv.length ? ixTable(x, p.from, p.to, stepFee, last) : html``
      if (!p.note) return table
      const errs = ix.filter((i) => i.error).length
      const t0 = ix[0]?.ts
      const t1 = ix[ix.length - 1]?.ts
      const span = t0 && t1 ? Date.parse(t1) - Date.parse(t0) : null
      const meta = html`<span class="muted small">${ix.length ? `${ix.length} instr` : ''}${span ? ` · ${ms(span)}` : ''}${errs ? html` · <span class="err">${errs} err</span>` : ''}</span>`
      // A fold must not hide what the row advertises. The badge promises
      // `→ @ccc`; with several notes the phases close by default, and in the
      // golden records EVERY outgoing message landed inside a closed one —
      // instruction 8 of 8 here, 5 / 21 / 29 of 31 there. So a phase carrying
      // a message opens with the turn, and only the rest stay folded.
      const sends = ix.some((i) => i.tool === 'SendMessage') || recv.some((r) => r.kind !== 'meta')
      return many
        ? html`<details class="phase ${sends ? 'sends' : ''}" ${openPhases || sends ? 'open' : ''}><summary><span class="note">${p.note.text}</span> ${meta}${
            sends ? html` <span class="kind sent">→ message</span>` : ''
          }</summary>${table}</details>`
        : html`<p class="note">${p.note.text} ${meta}</p>${table}`
    })}
    ${x.reply ? html`<p class="reply">${x.reply}</p>` : ''}`
}

function ixTable(x: Transaction, from: number, to: number, stepFee: Map<string, { output: number; listUsd: number | null; thinking: number; model: string | null }>, tail = false) {
  const rows: H[] = []
  let lastReq: string | null | undefined
  const thoughts = x.thoughts.filter((t) => t.at >= from && t.at < to)
  const received = x.received.filter((r) => r.at >= from && (r.at < to || (tail && r.at === to)))
  for (let i = from; i < to; i++) {
    const ix = x.instructions[i]!
    for (const rv of received) if (rv.at === i) rows.push(receivedRow(rv))
    for (const th of thoughts) if (th.at === i) rows.push(thoughtRow(th.text))
    const newStep = ix.requestId !== lastReq
    lastReq = ix.requestId
    const fee = newStep && ix.requestId ? stepFee.get(ix.requestId) : undefined
    const out = ix.tool === 'SendMessage'
    rows.push(html`<tr class="${family(ix.tool)} ${ix.error ? 'err' : ''} ${newStep ? 'step' : ''} ${out ? 'sent' : ''}">
      <td class="mono muted t">${hms(ix.ts)}</td>
      <td class="mono tool"><i class="sw ${family(ix.tool)}"></i>${ix.tool}</td>
      <td class="mono small in">${out ? sentCell(ix) : inputHead(ix.tool, ix.input)}</td>
      <td class="num muted">${ms(ix.ms)}</td>
      <td class="small res">${ix.error ? html`<span class="kind err">error</span> ` : ''}${
        out && !ix.error
          ? ix.delivered === false
            ? html`<span class="kind err">lost</span> <span class="muted">${cut(ix.result.replace(/^\{"success":false,"message":"/, ''), 160)}</span>`
            : html`<span class="muted">delivered</span>`
          : cut(ix.result, 200)
      }</td>
      <td class="num muted small fee">${fee ? html`${fee.model ? html`<span title="${fee.model}">${modelLabel(fee.model)}</span> · ` : ''}${tok(fee.output)}${fee.thinking ? html` <span title="thinking">(${tok(fee.thinking)}t)</span>` : ''} · ${usd(fee.listUsd)}` : ''}</td>
    </tr>`)
  }
  if (tail) for (const rv of received) if (rv.at === to) rows.push(receivedRow(rv))
  return html`<table class="ix">
    <thead><tr><th>at</th><th>tool</th><th>input</th><th class="num">ms</th><th>result</th><th class="num">step out · $</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

// The argument that names the call: Bash's command, a file tool's path,
// Grep's pattern, an Agent's description — else the JSON head. The input
// is already cut, so a long one may not parse; the raw head is the fallback.
function inputHead(tool: string, input: string): H | string {
  // A relay out is addressed: who it went to, then the sender's own one-line
  // summary. This runs BEFORE the JSON parse below — the input arrives cut to
  // `head` characters, so any message long enough to be worth reading fails to
  // parse, and a branch placed after the parse would never fire.
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
