import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { ixTable } from './block'
import { type Beat, type Turn, type Work, conversationOf } from './conversation'
import { cut, cutMarkdown, ms, usd } from './fmt'
import { mdBlock } from './md'
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

type H = HtmlEscapedString | Promise<HtmlEscapedString>

export function conversationBody(traces: Trace[], o: { open?: boolean } = {}) {
  const many = traces.length > 1
  return html`<div class="panel"><div class="scroll">
    <section class="convo">
      ${traces.map((trace) => {
        const turns = conversationOf(trace)
        const self = trace.session.name ? `@${trace.session.name}` : 'assistant'
        return html`${many ? sessionRule(trace) : ''}${turns.map((turn, i) => turnEl(turn, trace.transactions[i]!, i, self, o))}`
      })}
    </section>
  </div></div>`
}

// A job across /clears: each session's rows under a rule naming it. The
// `/clear` that opened it is the first row and reads as what it is.
function sessionRule(trace: Trace) {
  const s = trace.session
  return html`<div class="sess"><a class="mono" href="/session/${s.sessionId}">${s.sessionId.slice(0, 8)}</a> · ${clockEl(s.first)} → ${clockEl(s.last)} · ${trace.totals.steps} steps · ${usd(trace.totals.listUsd)}</div>`
}

function turnEl(turn: Turn, x: Transaction, i: number, self: string, o: { open?: boolean }) {
  const id = x.promptId ? `tx-${x.promptId}` : `tx-${i}`
  const n = turn.n != null ? html`<span class="n">${turn.n}</span>` : ''
  // A slash command with nothing after it is one line.
  if (turn.kind === 'command' && !turn.reply && turn.beats.length === 0)
    return html`<div class="turn command" id="${id}"><div class="who">${n}<span class="kind">command</span><span class="cmd mono">${turn.message}</span>${clockEl(turn.ts, { sec: true })}</div></div>`

  const opener =
    turn.kind === 'relay'
      ? html`<div class="who peer">${n}<span class="kind relay">@${turn.tag ?? 'peer'}</span>${clockEl(turn.ts, { sec: true })}</div>${peerText(turn.message)}`
      : turn.kind === 'meta'
        ? html`<div class="who meta">${n}<span class="kind meta">${turn.tag ?? 'meta'}</span>${clockEl(turn.ts, { sec: true })}</div><div class="say meta"><p class="plain">${turn.message}</p></div>`
        : turn.kind === 'command'
          ? html`<div class="who you">${n}<span class="kind">command</span>${clockEl(turn.ts, { sec: true })}</div><div class="say you"><p class="plain mono">${turn.message}</p></div>`
          : html`<div class="who you">${n}you${clockEl(turn.ts, { sec: true })}</div><div class="say you"><p class="plain">${turn.message}</p></div>`

  // Speaker tracking: a name line opens each change of voice, so a run of
  // assistant text broken by two folds reads as one speaker, not three.
  let speaker: string = turn.kind === 'relay' ? `peer:${turn.tag}` : turn.kind
  const parts: H[] = []
  const stepFee = new Map((x.requests ?? []).map((r) => [r.requestId, r]))
  for (const b of turn.beats) {
    if (b.kind === 'work') {
      parts.push(workEl(b, x, stepFee, o.open === true))
      continue
    }
    if (b.kind === 'said') {
      if (speaker !== 'ai') parts.push(html`<div class="who ai"><span class="self">${self}</span>${clockEl(b.ts, { sec: true })}</div>`)
      speaker = 'ai'
      parts.push(html`<div class="say ai md">${raw(mdBlock(b.text))}</div>`)
      continue
    }
    if (b.kind === 'you') {
      parts.push(html`<div class="who you">you <span class="kind land mid-turn" title="typed while the turn ran; read at the next tool result">mid-turn</span>${clockEl(b.ts, { sec: true })}</div><div class="say you"><p class="plain">${b.text}</p></div>`)
      speaker = 'you'
      continue
    }
    if (b.kind === 'peer') {
      parts.push(html`<div class="who peer"><span class="kind relay">@${b.tag ?? 'peer'}</span> <span class="kind land mid-turn" title="arrived while the turn ran; read at the next tool result">mid-turn</span>${clockEl(b.ts, { sec: true })}</div>${peerText(b.text)}`)
      speaker = `peer:${b.tag}`
      continue
    }
    if (b.kind !== 'sent') continue
    const to = b.agent ? html`<span class="kind sent agent" title="${b.to ?? ''}">→ agent</span> <span class="muted">${cut(b.agent, 60)}</span>` : html`<span class="kind sent" title="${b.to ?? ''}">→ @${b.name ?? shortTo(b.to)}</span>`
    parts.push(html`<div class="who ai"><span class="self">${self}</span>${to}${b.delivered === false ? html`<span class="kind err">lost</span>` : ''}${clockEl(b.ts, { sec: true })}</div>
      <div class="say ai out">${b.summary ? html`<p class="sum">${b.summary}</p>` : ''}${b.message ? html`<div class="md">${raw(mdBlock(b.message))}</div>` : ''}</div>`)
    speaker = 'ai'
  }

  const fee = html`<span class="fee">${turn.steps} step${turn.steps === 1 ? '' : 's'} · ${ms(turn.ms)} · ${usd(turn.listUsd)}</span>`
  const reply = turn.reply
    ? html`<div class="who ai"><span class="self">${self}</span>${modelChip(turn.model)}${clockEl(turn.replyTs, { sec: true })}${fee}</div><div class="say ai md reply">${raw(mdBlock(turn.reply))}</div>`
    : turn.steps
      ? html`<div class="who ai end"><span class="self">${self}</span>${clockEl(turn.replyTs, { sec: true })}<span class="muted">ended without a reply</span>${fee}</div>`
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

