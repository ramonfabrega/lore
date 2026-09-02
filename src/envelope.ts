import { plain } from './fmt'

// The harness envelopes, unwrapped for display.
//
// A `user` record is often not a person typing, and the wrapper that says so
// is routinely longer than the message it carries: a relay spends ninety-odd
// characters naming a unix socket before its first word, and a task
// notification spends three lines on ids before it says which agent
// finished. lore stores every record WHOLE — the text is evidence, and the
// FTS index searches the envelope with it — so the unwrapping happens here,
// at the display edge, and only the spine and the timeline see the short
// form. Authorship still comes off the fields (`lane`, `peer`); these
// functions read the harness's own structural tags, never prose shape, and
// anything unmatched falls through as itself.
//
// The meta table is a census, not a guess — over the 3,930 meta rows indexed
// on 2026-09-02: task-notification 930, local-command-caveat 797,
// command-name 796, local-command-stdout 216, skill bodies 175, interrupts
// 157, image placeholders ~150, system-reminder 70, /context report 33.

export type Head = {
  // The chip: what opened this transaction. `/clear` for a slash command,
  // `task` for a notification, `image` for a pasted screenshot.
  tag: string | null
  text: string
}

const RELAY = /<cross-session-message\b([^>]*)>([\s\S]*?)(?:<\/cross-session-message>|$)/

// A relay's body, and the peer that sent it. `peer` on the row is the
// authority (origin.name, recorded by the harness); the `from-name`
// attribute is the fallback for rows indexed before that column existed.
export function relayHead(text: string): { from: string | null; text: string } {
  const m = RELAY.exec(text)
  if (!m) return { from: null, text: plain(text) }
  const body = plain(m[2] ?? '').trim()
  return { from: attr('from-name', m[1] ?? ''), text: body || plain(text) }
}

export function metaHead(text: string): Head {
  const t = plain(text).trim()

  const command = /<command-name>\/?([\w:-]+)<\/command-name>/.exec(t)?.[1]
  if (command) {
    const args = tagBody('command-args', t)
    return { tag: 'command', text: `/${command}${args ? ` ${args}` : ''}` }
  }

  const task = tagBody('task-notification', t)
  if (task != null) {
    // The summary is one line and says which agent stopped and how; the
    // result behind it is the agent's whole report, and belongs to the
    // spawn observatory, not to a spine row.
    const summary = tagBody('summary', task)
    const status = tagBody('status', task)
    return { tag: 'task', text: summary ?? (status ? `task ${status}` : task) }
  }

  const stdout = tagBody('local-command-stdout', t)
  if (stdout != null) return { tag: 'stdout', text: stdout === '(no content)' ? '' : stdout }

  // Boilerplate in full: it says the records that follow came from a local
  // command, which the sibling command row already says better.
  if (t.startsWith('<local-command-caveat>')) return { tag: 'caveat', text: '' }

  const reminder = tagBody('system-reminder', t)
  if (reminder != null) return { tag: 'reminder', text: reminder }

  // A skill body arrives headed by its own directory — the last segment is
  // the skill's name, which is the one thing a spine row needs.
  const skill = /^Base directory for this skill: (\S+)/.exec(t)?.[1]
  if (skill) return { tag: 'skill', text: skill.split('/').filter(Boolean).pop() ?? skill }

  // An image placeholder: `[Image: source: <path>]` or `[Image: original
  // WxH, displayed at …]`. The file name is what identifies it.
  const image = /^\[Image: (?:source: )?(.+?)\]/.exec(t)?.[1]
  if (image) return { tag: 'image', text: image.split('/').pop() ?? image }

  if (t.startsWith('[Request interrupted by user')) return { tag: 'interrupted', text: t.slice(1, -1).replace(/^Request interrupted by user\s*/, '') }

  // The /context report: a table whose headline is its first two facts.
  if (t.startsWith('## Context Usage')) {
    const model = /\*\*Model:\*\*\s*(\S+)/.exec(t)?.[1]
    const tokens = /\*\*Tokens:\*\*\s*(.+)/.exec(t)?.[1]?.trim()
    return { tag: 'context', text: [model, tokens].filter(Boolean).join(' · ') }
  }

  return { tag: null, text: t }
}

function attr(name: string, s: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1] || null
}

// Lenient on the close: a long envelope can be cut before its closing tag,
// and a half-read task notification still names its agent.
function tagBody(name: string, s: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)(?:</${name}>|$)`).exec(s)
  return m ? (m[1] ?? '').trim() : null
}
