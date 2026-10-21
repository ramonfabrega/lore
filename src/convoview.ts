import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { ixTable } from './block'
import { type Beat, type Turn, type Work, conversationOf } from './conversation'
import { cut, cutMarkdown, ms, tok, usd } from './fmt'
import { mdBlock, mdLead, mdUser } from './md'
import type { Trace, Transaction } from './trace'
import { clockEl, modelChip } from './viz'

// The conversation view (docs/EXPLORER.md): a session read top to bottom as
// the dialogue it was. Every turn is open — the message, the assistant's
// words, the reply, at reading size — and the tool work between them is one
// muted line that unfolds into the block view's own tables. The same
// `getTrace` behind both; `conversation.ts` is the projection, this is its
// rendering, and `lore conversation` prints the same beats.
//
// Who is speaking is a left rule and a small mono name, never a bubble
// floated left or right: the page is a console, and a column of text with a
// coloured edge reads at a glance which the chat-app layout does not at
// this density. The rules are the thread page's: the session's own agent in
// the first series hue, a peer in the second, the user in ink, the harness
// muted. A message read mid-turn sits INSIDE the turn at the cursor where
// the turn read it, marked `mid-turn` with its clock — it did not open a
// turn, and showing it where it landed is the point.
//
// Beside the dialogue, the RAIL (`railBody`): the block's spine as a second
// panel — one row per turn, who opened it, when, its first line and its
// weight, and under it a row per voice inside the turn (the user mid-turn,
// a peer, the assistant's reply, a message sent). The dialogue is a column
// of reading-size text and the page is wider than a column; the rail is
// what the rest of the width is for, and it is how a reader who scrolled
// past forty turns finds the one where a peer spoke. Rows are anchors into
// the turn ids the timeline's bands already use; no script.

type H = HtmlEscapedString | Promise<HtmlEscapedString>

// `name` is the job's, for a session that predates the name (a session's
// own `name` is read as of its index; the job's is a property looked up on
// the key, CLAUDE.md) — the speaker is the same agent either way.
export function conversationBody(traces: Trace[], o: { open?: boolean; name?: string | null } = {}) {
  const many = traces.length > 1
  return html`<div class="panel"><div class="scroll">
    <section class="convo">
      ${traces.map((trace) => {
        const turns = conversationOf(trace)
        const self = selfOf(trace, o.name)
        return html`${many ? sessionRule(trace) : ''}${turns.map((turn, i) => turnEl(turn, trace.transactions[i]!, i, self, o))}`
      })}
    </section>
  </div></div>`
}

function selfOf(trace: Trace, name?: string | null): string {
  const n = trace.session.name ?? name
  return n ? `@${n}` : 'assistant'
}

// A job across /clears: each session's rows under a rule naming it. The
// `/clear` that opened it is the first row and reads as what it is.
function sessionRule(trace: Trace) {
  const s = trace.session
  return html`<div class="sess" id="s-${s.sessionId.slice(0, 8)}"><a class="mono" href="/session/${s.sessionId}">${s.sessionId.slice(0, 8)}</a> · ${clockEl(s.first)} → ${clockEl(s.last)} · ${trace.totals.steps} steps · ${usd(trace.totals.listUsd)}</div>`
}

// The turn's anchor; a beat inside it is `<turn>-b<index>` so the rail can
// land on a voice inside a long turn, not only at its top.
function turnId(x: Transaction, i: number): string {
  return x.promptId ? `tx-${x.promptId}` : `tx-${i}`
}

function turnEl(turn: Turn, x: Transaction, i: number, self: string, o: { open?: boolean }) {
  const id = turnId(x, i)
  const n = turn.n != null ? html`<span class="n">${turn.n}</span>` : ''
  // A slash command with nothing after it is one line.
  if (turn.kind === 'command' && !turn.reply && turn.beats.length === 0)
    return html`<div class="turn command" id="${id}"><div class="who">${n}<span class="kind">command</span><span class="cmd mono">${turn.message}</span>${clockEl(turn.ts, { sec: true })}</div></div>`

  // The turn's weight rides the line that opens it — steps, wall, fee — so a
  // scroll reads the heavy turn where it starts, not forty lines later where
  // it ends. The rail carries the same numbers as a column.
  const fee = turn.steps ? html`<span class="fee">${turn.steps} step${turn.steps === 1 ? '' : 's'} · ${ms(turn.ms)} · ${usd(turn.listUsd)}</span>` : ''
  const opener =
    turn.kind === 'relay'
      ? html`<div class="who peer">${n}<span class="kind relay">@${turn.tag ?? 'peer'}</span>${clockEl(turn.ts, { sec: true })}${fee}</div>${peerText(turn.message)}`
      : turn.kind === 'meta'
        ? html`<div class="who meta">${n}<span class="kind meta">${turn.tag ?? 'meta'}</span>${clockEl(turn.ts, { sec: true })}${fee}</div><div class="say meta"><p class="plain">${turn.message}</p></div>`
        : turn.kind === 'command'
          ? html`<div class="who you">${n}<span class="kind">command</span>${clockEl(turn.ts, { sec: true })}${fee}</div><div class="say you"><p class="plain mono">${turn.message}</p></div>`
          : html`<div class="who you">${n}you${clockEl(turn.ts, { sec: true })}${fee}</div><div class="say you md">${raw(mdUser(turn.message))}</div>`

  // Speaker tracking: a name line opens each change of voice, so a run of
  // assistant text broken by two folds reads as one speaker, not three.
  let speaker: string = turn.kind === 'relay' ? `peer:${turn.tag}` : turn.kind
  const parts: H[] = []
  const stepFee = new Map((x.requests ?? []).map((r) => [r.requestId, r]))
  turn.beats.forEach((b, k) => {
    const bid = `${id}-b${k}`
    if (b.kind === 'work') {
      parts.push(workEl(b, x, stepFee, o.open === true))
      return
    }
    if (b.kind === 'said') {
      if (speaker !== 'ai') parts.push(html`<div class="who ai"><span class="self">${self}</span>${clockEl(b.ts, { sec: true })}</div>`)
      speaker = 'ai'
      parts.push(html`<div class="say ai md">${raw(mdBlock(b.text))}</div>`)
      return
    }
    if (b.kind === 'you') {
      parts.push(html`<div class="who you" id="${bid}">you <span class="kind land mid-turn" title="typed while the turn ran; read at the next tool result">mid-turn</span>${clockEl(b.ts, { sec: true })}</div><div class="say you md">${raw(mdUser(b.text))}</div>`)
      speaker = 'you'
      return
    }
    if (b.kind === 'peer') {
      parts.push(html`<div class="who peer" id="${bid}"><span class="kind relay">@${b.tag ?? 'peer'}</span> <span class="kind land mid-turn" title="arrived while the turn ran; read at the next tool result">mid-turn</span>${clockEl(b.ts, { sec: true })}</div>${peerText(b.text)}`)
      speaker = `peer:${b.tag}`
      return
    }
    if (b.kind !== 'sent') return
    const to = b.agent ? html`<span class="kind sent agent" title="${b.to ?? ''}">→ agent</span> <span class="muted">${cut(b.agent, 60)}</span>` : html`<span class="kind sent" title="${b.to ?? ''}">→ @${b.name ?? shortTo(b.to)}</span>`
    parts.push(html`<div class="who ai" id="${bid}"><span class="self">${self}</span>${to}${b.delivered === false ? html`<span class="kind err">lost</span>` : ''}${clockEl(b.ts, { sec: true })}</div>
      <div class="say ai out">${b.summary ? html`<p class="sum">${b.summary}</p>` : ''}${b.message ? html`<div class="md">${raw(mdBlock(b.message))}</div>` : ''}</div>`)
    speaker = 'ai'
  })

  const reply = turn.reply
    ? html`<div class="who ai" id="${id}-r"><span class="self">${self}</span>${modelChip(turn.model)}${clockEl(turn.replyTs, { sec: true })}</div><div class="say ai md reply">${raw(mdBlock(turn.reply))}</div>`
    : turn.steps
      ? html`<div class="who ai end" id="${id}-r"><span class="self">${self}</span>${clockEl(turn.replyTs, { sec: true })}<span class="muted">ended without a reply</span></div>`
      : ''
  return html`<article class="turn ${turn.kind}" id="${id}">${opener}${parts}${reply}</article>`
}

// The work line: what the run of instructions was, in one muted line that
// opens into the block's table for exactly those rows. Notifications read
// inside the run are a count: fourteen of them in one turn would otherwise
// be fourteen rows saying "command finished".
function workEl(b: Work, x: Transaction, stepFee: Map<string, { output: number; listUsd: number | null; thinking: number; model: string | null }>, open: boolean) {
  const mix = html`<span class="mix mono">${b.tools.map((t) => html`<span><i class="sw ${familyOf(t.tool)}"></i>${t.tool}${t.n > 1 ? html` <b>×${t.n}</b>` : ''}</span>`)}</span>`
  const notif = b.notifications ? ` · ${b.notifications} notification${b.notifications === 1 ? '' : 's'}` : ''
  return html`<details class="work" ${open ? 'open' : ''}>
    <summary>${mix}<span class="muted small">${b.steps} step${b.steps === 1 ? '' : 's'} · ${ms(b.ms)} · ${usd(b.listUsd)}${b.errors ? html` · <span class="err">${b.errors} err</span>` : ''}${notif}</span></summary>
    ${ixTable(x, b.from, b.to, stepFee, false)}
  </details>`
}

// A peer's message — a brief from another session, a subagent's report —
// is often a page on its own, and the dialogue is not it. The lead reads in
// place; the whole text is one fold away, never cut (the thread page's rule:
// a page that shows a brief arrived must be able to show what it said).
const PEER_LEAD = 600
function peerText(text: string) {
  if (text.length <= PEER_LEAD && !/\n\s*\n[\s\S]*\n\s*\n/.test(text)) return html`<div class="say peer md">${raw(mdBlock(text))}</div>`
  return html`<details class="say peer long"><summary><div class="md lead">${raw(mdBlock(cutMarkdown(text, PEER_LEAD)))}</div><span class="more">full message · ${text.length.toLocaleString()} chars</span></summary><div class="md">${raw(mdBlock(text))}</div></details>`
}

// ---- the rail -------------------------------------------------------------

// One row per turn and one per voice inside it. The turn row is the spine's:
// number, who opened it, when, the first line, and the weight (steps and
// fee always; errors, output and wall when the panel is wide enough — the
// container query in style.ts). Under it, indented: the user mid-turn, a
// peer mid-turn, each message sent, and the reply's lead — so the column
// reads as who spoke, in order, and every row lands on the voice itself.
// Harness turns (a task finishing) are one muted row per run of them: ten
// rows saying `task` between two human turns was the spine's noise.
export function railBody(traces: Trace[], o: { name?: string | null } = {}) {
  const many = traces.length > 1
  const turns = traces.reduce((n, t) => n + t.totals.transactions, 0)
  return html`<div class="panel rail"><header><h2>turns</h2><span class="sub">${turns} · who spoke, where; a row lands on the voice</span></header><div class="scroll">
    <section class="outline">
      <div class="r head"><span class="n">#</span><span class="who">who</span><span class="at">at</span><span class="lead"></span><span class="num">steps</span><span class="num x">err</span><span class="num x">out</span><span class="num">list $</span><span class="num x">wall</span></div>
      ${traces.map((trace) => {
        const turns = conversationOf(trace)
        const self = selfOf(trace, o.name)
        const rows: H[] = []
        let metaRun: { turn: Turn; x: Transaction; i: number; n: number } | null = null
        const flush = () => {
          if (!metaRun) return
          const { turn, x, i, n } = metaRun
          rows.push(html`<a class="r meta" href="#${turnId(x, i)}" title="${cut(turn.message, 300)}"><span class="n"></span><span class="who">${turn.tag ?? 'meta'}${n > 1 ? html` <b>×${n}</b>` : ''}</span><span class="at">${clockEl(turn.ts)}</span><span class="lead">${cut(turn.message, 140)}</span><span class="num"></span><span class="num x"></span><span class="num x"></span><span class="num"></span><span class="num x"></span></a>`)
          metaRun = null
        }
        turns.forEach((turn, i) => {
          const x = trace.transactions[i]!
          if (turn.kind === 'meta') {
            if (metaRun && metaRun.turn.tag === turn.tag) metaRun.n++
            else {
              flush()
              metaRun = { turn, x, i, n: 1 }
            }
            return
          }
          flush()
          rows.push(...turnRows(turn, x, i, self))
        })
        flush()
        return html`${many ? sessionRailRule(trace) : ''}${rows}`
      })}
    </section>
  </div></div>`
}

function sessionRailRule(trace: Trace) {
  const s = trace.session
  return html`<a class="r sess" href="#s-${s.sessionId.slice(0, 8)}"><span class="mono">${s.sessionId.slice(0, 8)}</span><span>${clockEl(s.first)}</span><span class="muted">${trace.totals.transactions} turns · ${usd(trace.totals.listUsd)}</span></a>`
}

function turnRows(turn: Turn, x: Transaction, i: number, self: string): H[] {
  const id = turnId(x, i)
  const nums = html`<span class="num">${turn.steps || ''}</span><span class="num x ${turn.errors ? 'err' : ''}">${turn.errors || ''}</span><span class="num x">${x.output ? tok(x.output) : ''}</span><span class="num">${turn.listUsd ? usd(turn.listUsd) : ''}</span><span class="num x">${turn.ms ? ms(turn.ms) : ''}</span>`
  const who =
    turn.kind === 'relay'
      ? html`<span class="who"><span class="kind relay">@${turn.tag ?? 'peer'}</span></span>`
      : turn.kind === 'command'
        ? html`<span class="who">cmd</span>`
        : html`<span class="who">you</span>`
  const lead = turn.kind === 'command' ? html`<span class="lead mono">${turn.message}</span>` : html`<span class="lead">${turn.kind === 'relay' ? cut(mdLead(turn.message) || turn.message, 160) : cut(turn.message, 160)}</span>`
  const rows: H[] = [html`<a class="r ${turn.kind}" href="#${id}" title="${cut(turn.message, 300)}"><span class="n">${turn.n ?? ''}</span>${who}<span class="at">${clockEl(turn.ts)}</span>${lead}${nums}</a>`]
  const blank = html`<span class="num"></span><span class="num x"></span><span class="num x"></span><span class="num"></span><span class="num x"></span>`
  turn.beats.forEach((b, k) => {
    const bid = `${id}-b${k}`
    if (b.kind === 'you') rows.push(html`<a class="r sub you" href="#${bid}" title="${cut(b.text, 300)}"><span class="n"></span><span class="who">↳ you</span><span class="at">${clockEl(b.ts)}</span><span class="lead">${cut(b.text, 140)}</span>${blank}</a>`)
    else if (b.kind === 'peer') rows.push(html`<a class="r sub peer" href="#${bid}" title="${cut(b.text, 300)}"><span class="n"></span><span class="who">↳ <span class="kind relay">@${b.tag ?? 'peer'}</span></span><span class="at">${clockEl(b.ts)}</span><span class="lead">${cut(mdLead(b.text) || b.text, 140)}</span>${blank}</a>`)
    else if (b.kind === 'sent') {
      const to = b.agent ? 'agent' : `@${cut(b.name ?? shortTo(b.to), 14)}`
      rows.push(html`<a class="r sub ai sent" href="#${bid}" title="${cut(b.summary ?? b.message ?? '', 300)}"><span class="n"></span><span class="who">→ ${to}${b.delivered === false ? html` <b class="err">lost</b>` : ''}</span><span class="at">${clockEl(b.ts)}</span><span class="lead">${cut(b.summary ?? b.message ?? '', 140)}</span>${blank}</a>`)
    }
  })
  if (turn.reply) rows.push(html`<a class="r sub ai" href="#${id}-r" title="${cut(turn.reply, 300)}"><span class="n"></span><span class="who">↳ ${self}</span><span class="at">${clockEl(turn.replyTs)}</span><span class="lead">${cut(mdLead(turn.reply) || turn.reply, 140)}</span>${blank}</a>`)
  return rows
}

// The lane families, for the swatch (block.ts owns the table; the mix on
// the work line is the same legend).
const FAMILY: Record<string, string> = {
  Read: 'read', Grep: 'read', Glob: 'read', LS: 'read', WebFetch: 'read', WebSearch: 'read', ToolSearch: 'read', LSP: 'read',
  TaskList: 'read', TaskGet: 'read', ListAgents: 'read',
  Edit: 'write', Write: 'write', MultiEdit: 'write', NotebookEdit: 'write',
  Bash: 'run',
  Agent: 'agent', Task: 'agent', Workflow: 'agent', Skill: 'agent', SendMessage: 'agent',
}
function familyOf(tool: string): string {
  return FAMILY[tool] ?? 'other'
}

function shortTo(to: string | null): string {
  if (!to) return '?'
  const tail = to.replace(/^uds:/, '').split('/').filter(Boolean).pop() ?? to
  const name = tail.replace(/\.sock$/, '')
  return name.length > 12 ? `${name.slice(0, 8)}…` : name
}
