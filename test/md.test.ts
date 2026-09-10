import { describe, expect, test } from 'bun:test'
import { cutMarkdown, cutProse } from '../src/fmt'
import { mdBlock, mdInline, mdLead } from '../src/md'

describe('mdBlock — assistant text renders as the markdown it was written as', () => {
  test('GFM: headings, emphasis, code, tables, task lists', () => {
    const h = mdBlock('## Where it stands\n\n**Shipped.** Run `lore index`.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done')
    expect(h).toContain('<h2>Where it stands</h2>')
    expect(h).toContain('<strong>Shipped.</strong>')
    expect(h).toContain('<code>lore index</code>')
    expect(h).toContain('<td>1</td>')
    expect(h).toContain('checkbox')
  })

  test('raw HTML in the source is text, never markup', () => {
    const h = mdBlock('<script>alert(1)</script>\n\nand <b>inline</b>')
    expect(h).not.toContain('<script>')
    expect(h).not.toContain('<b>')
    expect(h).toContain('&lt;script&gt;')
  })

  test('a link goes somewhere only over http(s) or mailto; an image is a link to itself', () => {
    const h = mdBlock('[x](javascript:alert(1)) [y](https://ok.example) ![shot](https://cdn.example/a.png)')
    expect(h).not.toContain('javascript:')
    expect(h).toContain('<a href="https://ok.example" rel="noreferrer">y</a>')
    expect(h).not.toContain('<img')
    expect(h).toContain('<a href="https://cdn.example/a.png" rel="noreferrer">shot</a>')
  })

  // golf 97de53c7: md4c's URL autolink took the closing `**` into the href
  // and left <strong> open, and the parser reopened it in every row below.
  test('a bold bare URL stays bold and closes — the bug that unstyled a page', () => {
    const h = mdBlock('App is live: **https://apps.apple.com/us/app/panamar-golf/id6789478154**')
    expect(h).toContain('<strong><a href="https://apps.apple.com/us/app/panamar-golf/id6789478154" rel="noreferrer">')
    expect(h).not.toContain('id6789478154*')
    expect(h.match(/<strong>/g)?.length).toBe(h.match(/<\/strong>/g)?.length)
  })

  test('bare URLs link without their trailing punctuation, and keep a paren they opened', () => {
    expect(mdBlock('see https://a.example/x.')).toContain('<a href="https://a.example/x" rel="noreferrer">https://a.example/x</a>.')
    expect(mdBlock('(see https://a.example/x)')).toContain('https://a.example/x</a>)')
    expect(mdBlock('https://en.wikipedia.org/wiki/Foo_(bar)')).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"')
  })

  test('URLs inside code are not linked', () => {
    const h = mdBlock('`curl https://a.example/x`\n\n```\nhttps://b.example\n```')
    expect(h).not.toContain('<a ')
  })
})

describe('mdInline — one line inside someone else’s layout', () => {
  test('keeps spans, drops the block wrapper', () => {
    expect(mdInline('`SessionData` — **the tap**. Let me look.')).toBe('<code>SessionData</code> — <strong>the tap</strong>. Let me look.')
    expect(mdInline('## Heading')).toBe('Heading')
  })
})

describe('mdLead — the first thing a reply says', () => {
  test('a heading leads into the first prose line', () => {
    expect(mdLead('## Where it stands\n\n**The daemon is shipped and live.** More.')).toBe('Where it stands — The daemon is shipped and live. More.')
  })
  test('fences, tables and markers are skipped or stripped', () => {
    expect(mdLead('```sh\nssh -t golf-rig\n```\n\nThe `*` makes it prompt.')).toBe('The * makes it prompt.')
    expect(mdLead('| a | b |\n|---|---|\n\n- **Leave both ticked.**')).toBe('Leave both ticked.')
    expect(mdLead('Pushed as `31e49f4`. [plan](https://x.example)')).toBe('Pushed as 31e49f4. plan')
  })
})

describe('cutMarkdown — whitespace is syntax', () => {
  const MD = '- parent\n  - child\n\n```\n  indented code\n```\n\n\n\nend'
  test('keeps indentation that cutProse collapses', () => {
    expect(cutMarkdown(MD, 500)).toBe('- parent\n  - child\n\n```\n  indented code\n```\n\nend')
    expect(cutProse(MD, 500)).toContain('\n- child')
  })
  test('cuts to length with a marker', () => {
    expect(cutMarkdown('abcdefghij', 5)).toBe('abcd…')
  })
})
