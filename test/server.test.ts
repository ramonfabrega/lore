import { describe, expect, test } from 'bun:test'
import { readPlistConfig, renderPlist, urlFor } from '../src/server'
import { allowsFallthrough, composeHandler } from '../src/web'

describe('launchd plist', () => {
  test('renders the serve command with env, KeepAlive, and logs under ~/.lore; reads its config back', () => {
    const xml = renderPlist({ port: 4949, host: '100.100.100.100' }, { bin: '/u/.bun/bin/lore', home: '/u' })
    expect(xml).toContain('<string>com.ramonfabrega.lore</string>')
    expect(xml).toContain('<string>/u/.bun/bin/lore</string>\n    <string>serve</string>\n    <string>--port</string>\n    <string>4949</string>\n    <string>--host</string>\n    <string>100.100.100.100</string>')
    expect(xml).toContain('<key>KeepAlive</key>\n  <true/>')
    expect(xml).toContain('<string>/u/.bun/bin:/u/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>')
    expect(xml).toContain('<string>/u/.lore/serve.log</string>')
    expect(readPlistConfig(xml)).toEqual({ port: 4949, host: '100.100.100.100' })
    expect(readPlistConfig('<plist></plist>')).toBeNull()
  })

  test('urlFor maps the wildcard bind to localhost', () => {
    expect(urlFor({ port: 4949, host: '0.0.0.0' })).toBe('http://localhost:4949/')
    expect(urlFor({ port: 4949, host: '100.100.100.100' })).toBe('http://100.100.100.100:4949/')
  })
})

describe('cli fall-through under /cli/', () => {
  const get = (p: string) => new Request(`http://x${p}`)
  test('read verbs and the spec pass on GET; writers, unknowns, root paths, and POST do not', () => {
    for (const p of ['/cli/usage?by=week', '/cli/trace/abc', '/cli/sessions', '/cli/docs/search/foo', '/cli/openapi.json', '/cli/stats'])
      expect(allowsFallthrough(get(p))).toBe(true)
    for (const p of ['/cli/archive', '/cli/index', '/cli/docs/index', '/cli/wiki/commit', '/cli/serve', '/cli/server/up', '/usage', '/trace/abc', '/cli', '/'])
      expect(allowsFallthrough(get(p))).toBe(false)
    expect(allowsFallthrough(new Request('http://x/cli/usage', { method: 'POST' }))).toBe(false)
  })

  test('composeHandler: pages own the root; /cli/ strips the prefix for allowed verbs and 404s the rest', async () => {
    const pages = (req: Request) => new Response(`page:${new URL(req.url).pathname}`, { status: 200 })
    const cli = (req: Request) => new Response(`cli:${new URL(req.url).pathname}${new URL(req.url).search}`, { status: 200 })
    const h = composeHandler(pages, cli)
    expect(await (await h(get('/'))).text()).toBe('page:/')
    expect(await (await h(get('/usage'))).text()).toBe('page:/usage')
    expect(await (await h(get('/cli/usage?by=week'))).text()).toBe('cli:/usage?by=week')
    expect(await (await h(get('/cli/trace/abc'))).text()).toBe('cli:/trace/abc')
    expect((await h(get('/cli/index'))).status).toBe(404)
    expect((await h(new Request('http://x/cli/usage', { method: 'POST' }))).status).toBe(404)
  })
})
