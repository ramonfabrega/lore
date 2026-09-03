import { html } from 'hono/html'
import { cut, day, dayName, ms, stamp } from './fmt'
import type { Thread, ThreadPair, ThreadRow } from './thread'
import { tile } from './block'
import { clockEl, spanEl, timeEl } from './viz'

// The thread page: two agents, one ledger. Neither side is nested inside
// the other — the design decision the session page could not make, because
// a session page necessarily shows a peer's message inside one agent's
// turn. Here a message is a ROW: the sender's column carries what was said
// and the turn it was said from; the receiver's column carries what became
// of it — the turn it opened, the turn that read it mid-flight, or the ack
// that refused it — and both halves link into the session pages, where the
// work around each message lives. Time runs down; the gutter arrow says
// which way the message went. Sides wear the first two series hues; the
// landing chips wear the status colours, since "lost" is a state, not an
// identity.

const PREVIEW = 220

// An id is shown by its first eight characters; a name — however long — is
// shown whole. Only a uuid is an id.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/
function short(id: string) {
  return UUID.test(id) ? id.slice(0, 8) : id
}
function label(side: Thread['a']) {
  return side.name ?? short(side.query)
}
// A side is a job: its chip is the way to the job page, when it has one.
function sideChip(side: Thread['a'], which: 'a' | 'b') {
  const chip = html`<span class="kind side-${which}">@${label(side)}</span>`
  return side.key ? html`<a href="/job/${encodeURIComponent(side.key)}" title="the job">${chip}</a>` : chip
}

export function threadBody(t: Thread) {
  const rows = t.rows
  const first = rows[0]?.ts ?? null
  const last = rows[rows.length - 1]?.ts ?? null
  const span = first && last ? Date.parse(last) - Date.parse(first) : null
  const A = label(t.a)
  const B = label(t.b)
  const dirs = Object.entries(t.totals)
  const lost = dirs.reduce((n, [, d]) => n + d.lost, 0)
  const messages = rows.filter((r) => r.kind === 'message').length
  const yours = rows.length - messages
  return html`
    <div class="page-head">
    <p class="crumbs"><a href="/">lore</a> / <a href="/thread">threads</a></p>
    <h1 class="mono">${sideChip(t.a, 'a')} <span class="muted">↔</span> ${sideChip(t.b, 'b')}</h1>
    <p class="muted">${first ? html`${spanEl(first, last, { sec: true })} · ${ms(span)}` : 'no messages'}
      · ${messages} messages${yours ? html` · <a href="?you=0" title="the agents' traffic alone">${yours} of yours</a>` : ''} · ${A}: ${t.a.sessions.length} session${t.a.sessions.length === 1 ? '' : 's'} · ${B}: ${t.b.sessions.length} session${t.b.sessions.length === 1 ? '' : 's'}</p>
    <div class="tiles">
      ${dirs.map(([dir, d]) => tile(html`${dir} · <span title="opened a turn">${d.turn} turn</span> · <span title="read inside a running turn">${d.midTurn} mid-turn</span>${d.lost ? html` · <span class="err">${d.lost} lost</span>` : ''}${d.unseen ? html` · ${d.unseen} unseen` : ''}`, String(d.sent)))}
      ${lost ? tile('lost', String(lost), 'warn') : ''}
    </div>
    </div>
    <div class="panel"><div class="scroll">
    <section class="thread">
      <div class="row head"><span>at</span><span class="a">@${A}</span><span></span><span class="b">@${B}</span></div>
      ${rows.map((r, i) => threadRow(r, t, rows[i - 1]))}
    </section>
    </div></div>`
}

function threadRow(r: ThreadRow, t: Thread, prev: ThreadRow | undefined) {
  const newDay = !prev || day(prev.ts) !== day(r.ts)
  const at = html`<span class="at">${newDay ? html`<span class="d">${dayName(day(r.ts))}</span>` : ''}${clockEl(r.ts, { sec: true })}</span>`
  // The user's words sit in the column of the agent they were typed to, in
  // plain ink, with no arrow: they did not cross between the agents.
  if (r.kind === 'you') {
    const toA = r.to === label(t.a) || (t.a.name != null && r.to === t.a.name)
    const cell = youCell(r)
    return html`<div class="row you ${toA ? 'to-a' : 'to-b'} ${r.landed}">${at}${toA ? cell : html`<span></span>`}<span></span>${toA ? html`<span></span>` : cell}</div>`
  }
  const fromA = r.from === label(t.a) || (t.a.name != null && r.from === t.a.name)
  const side = fromA ? 'from-a' : 'from-b'
  const gutter = html`<span class="g">${fromA ? '→' : '←'}</span>`
  const message = messageCell(r)
  const landing = landingCell(r)
  return html`<div class="row ${side} ${r.landed}" id="${r.msgId ? `m-${r.msgId}` : ''}">
    ${at}
    ${fromA ? message : landing}
    ${gutter}
    ${fromA ? landing : message}
  </div>`
}

// What was said, and the turn it was said from. The summary is the sender's
// own one-line gloss; the preview is the message; the full text unfolds when
// the preview cut it. A row with no sender half (only the receiver's copy is
// indexed) says so instead of linking.
function messageCell(r: ThreadRow) {
  const text = r.message
  const preview = cut(text, PREVIEW)
  const long = preview.endsWith('…') || text.includes('\n')
  return html`<div class="cell">
    ${r.summary ? html`<div class="sum">${r.summary}</div>` : ''}
    <div class="prev">${preview}</div>
    ${long ? html`<details><summary>full message · ${text.length.toLocaleString()} chars</summary><p class="msg">${text}</p></details>` : ''}
    <p class="from muted">${
      r.sent
        ? html`from <a href="/session/${r.sent.session}${r.sent.promptId ? `#tx-${r.sent.promptId}` : ''}">${short(r.sent.session)}</a>`
        : html`sender not indexed`
    }</p>
  </div>`
}

// What the user typed to this side, and the turn it landed in — the one it
// opened, or the running one that read it mid-flight.
function youCell(r: ThreadRow) {
  const text = r.message
  const preview = cut(text, PREVIEW)
  const long = preview.endsWith('…') || text.includes('\n')
  const href = r.received ? `/session/${r.received.session}${r.received.promptId ? `#tx-${r.received.promptId}` : ''}` : null
  return html`<div class="cell you">
    <div class="who">you${r.landed === 'mid-turn' ? html` <span class="kind land mid-turn" title="typed while the agent was working; read at the next tool result">mid-turn</span>` : ''}</div>
    <div class="prev">${preview}</div>
    ${long ? html`<details><summary>full · ${text.length.toLocaleString()} chars</summary><p class="msg">${text}</p></details>` : ''}
    ${href && r.received ? html`<p class="from muted">in <a href="${href}">${short(r.received.session)}</a></p>` : ''}
  </div>`
}

// What became of it on the other side.
function landingCell(r: ThreadRow) {
  if (r.landed === 'lost') return html`<div class="land"><span class="kind err">lost</span> <span class="small muted">${cut(r.error ?? 'the ack refused it', 160)}</span></div>`
  if (!r.received) return html`<div class="land"><span class="kind land unseen">unseen</span> <span class="small muted">acked, no copy indexed</span></div>`
  const href = `/session/${r.received.session}${r.received.promptId ? `#tx-${r.received.promptId}` : ''}`
  return html`<div class="land"><a class="kind land ${r.landed}" href="${href}" title="${r.landed === 'turn' ? 'opened a turn' : 'read inside a running turn'} in ${r.received.session} at ${stamp(r.received.ts)}">${r.landed}</a> <a class="mono small" href="${href}">${short(r.received.session)}</a></div>`
}

// The index: every pair that has talked, most recent first.
export function threadsBody(pairs: ThreadPair[]) {
  return html`
    <div class="page-head">
    <p class="crumbs"><a href="/">lore</a> / threads</p>
    <h1 class="mono">threads</h1>
    <p class="muted">every pair of agents that has sent the other a message · both halves, in order, from the raw transcripts</p>
    </div>
    <div class="panel"><div class="scroll list threads">
      <div class="row head"><span>pair</span><span class="num">messages</span><span>first</span><span>last</span></div>
      ${pairs.map(
        (p) => html`<div class="row">
          <span class="mono"><a href="/thread/${encodeURIComponent(p.a)}/${encodeURIComponent(p.b)}">@${short(p.a)} ↔ @${short(p.b)}</a></span>
          <span class="num">${p.messages}</span>
          <span class="mono muted">${timeEl(p.first, { full: true })}</span>
          <span class="mono">${timeEl(p.last, { full: true })}</span>
        </div>`,
      )}
      ${pairs.length === 0 ? html`<p class="muted" style="padding:10px">no cross-session messages indexed yet</p>` : ''}
    </div></div>`
}
