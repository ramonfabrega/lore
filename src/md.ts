// Markdown at the display edge. Whether a text is markdown is a question of
// WHO wrote it, and that is a field (CLAUDE.md, authorship): every text block
// the assistant emits is GitHub-flavored markdown by the harness's own
// contract — the terminal renders it as such — and so is a peer session's
// relay, which another assistant wrote. What the user typed into a terminal
// is not, and stays pre-wrapped plain text; tool inputs and results stay
// mono. Nothing here sniffs prose for `**` or `##`.
//
// `Bun.markdown` is md4c inside the runtime: GFM tables, task lists and
// fences, zero dependencies. Raw HTML in the source is escaped, never passed
// through (a transcript quotes pages and tool output), and two things md4c
// leaves alone are closed off after it: a link only goes somewhere over
// http(s) or mailto, and an image is a link to itself — the page fetches
// nothing a transcript names.

// md4c's URL autolink is off: it takes the closing `**` of `**https://…**`
// into the link (`href="…/id6789478154*"`), leaving the `<strong>` open — and
// an open formatting element does not stay in its block, the HTML parser
// reopens it inside every element after it, so one reply in golf 97de53c7
// set the rest of the page in bold and unstyled its rows. Bare URLs are
// linked below instead, with GFM's rule for where one ends.
const OPTS = { noHtmlBlocks: true, noHtmlSpans: true, autolinks: { www: true, email: true } } as const
const SAFE = /^(https?:|mailto:)/i
const VOID = new Set(['br', 'hr', 'img', 'input'])

function tidy(html: string): string {
  return html
    .replace(/<a href="([^"]*)"/g, (_m, href: string) => (SAFE.test(href) ? `<a href="${href}" rel="noreferrer"` : '<a'))
    .replace(/<img src="([^"]*)" alt="([^"]*)"[^>]*>/g, (_m, src: string, alt: string) =>
      SAFE.test(src) ? `<a href="${src}" rel="noreferrer">${alt || src}</a>` : alt,
    )
}

// Bare http(s) URLs in text — never inside a link, a code span or a fence.
// Trailing punctuation is not part of the URL (GFM), and a closing paren is
// only when the URL opened one: `…/Foo_(bar)` keeps it, `(see …/x)` drops it.
function linkify(html: string): string {
  let inside = 0
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        const m = /^<(\/?)(a|code|pre)\b/.exec(part)
        if (m) inside += m[1] ? -1 : 1
        return part
      }
      if (inside > 0) return part
      return part.replace(/https?:\/\/[^\s<]+/g, (u) => {
        let url = u
        let tail = ''
        for (;;) {
          const t = /(?:[.,:;!?*_~'\]]|&quot;|&#39;|&gt;|\))$/.exec(url)
          if (!t) break
          if (t[0] === ')' && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break
          url = url.slice(0, -t[0].length)
          tail = t[0] + tail
        }
        return url.length > 8 ? `<a href="${url}" rel="noreferrer">${url}</a>${tail}` : u
      })
    })
    .join('')
}

// Every element that opens closes, in order. md4c's output should always
// pass; when it does not, the text renders plain rather than risk the page.
function balanced(html: string): boolean {
  const stack: string[] = []
  for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/g)) {
    const tag = m[2]!
    if (VOID.has(tag)) continue
    if (!m[1]) stack.push(tag)
    else if (stack.pop() !== tag) return false
  }
  return stack.length === 0
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A block of markdown: paragraphs, lists, fences, tables.
export function mdBlock(s: string): string {
  const out = linkify(tidy(Bun.markdown.html(s, OPTS)))
  return balanced(out) ? out : `<p class="plain">${esc(s)}</p>`
}

// One line of markdown inside a heading or a row: code spans, emphasis,
// links, and no block wrapper. A line that parses as a heading or a list
// item keeps only its text — it is sitting in someone else's layout.
export function mdInline(s: string): string {
  return mdBlock(s)
    .trim()
    .replace(/^<(p|h[1-6]|ul|ol)\b[^>]*>(?:<li>)?/, '')
    .replace(/(?:<\/li>)?<\/(p|h[1-6]|ul|ol)>$/, '')
}

// The first thing a reply SAYS, as plain text for a one-line preview: the
// heading it opened with, if any, then its first line of prose. A reply that
// opens `## Where it stands` previews as `Where it stands — The daemon is
// shipped…`, not as the heading alone; fences, tables and rules are skipped.
export function mdLead(s: string): string {
  const lines = s.split('\n').map((l) => l.trim())
  let head = ''
  let fenced = false
  for (const l of lines) {
    if (/^(```|~~~)/.test(l)) {
      fenced = !fenced
      continue
    }
    if (fenced || l === '' || l.startsWith('|') || /^([-*_])\1{2,}$/.test(l)) continue
    const h = /^#{1,6}\s+(.*)$/.exec(l)
    if (h) {
      head ||= h[1]!
      continue
    }
    const text = strip(l.replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '').replace(/^>\s?/, ''))
    return head ? `${strip(head)} — ${text}` : text
  }
  return strip(head)
}

function strip(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\W)[*_](\S[^*_]*)[*_](?=\W|$)/g, '$1$2')
    .trim()
}
