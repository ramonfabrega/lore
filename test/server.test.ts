import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selfArgv } from '../src/config'
import { launchdUnsupported, readPlistConfig, removeServerFile, renderPlist, ServerFile, urlFor, writeServerFile } from '../src/server'
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

  // The file a GUI client reads for the url (ccc, v0.1.40). Removal is
  // pid-guarded: a process that is not the writer leaves the file alone.
  test('server.json is written whole and removed only by the pid that wrote it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lore-server-')), 'server.json')
    const f = { url: 'http://100.100.100.100:4949/', build: 'v0.1.0 b1 @ abc', pid: 4242, startedAt: '2026-10-20T21:00:00.000Z' }
    await writeServerFile(f, path)
    expect(ServerFile.parse(await Bun.file(path).json())).toEqual(f)
    expect(await removeServerFile(1, path)).toBe(false)
    expect(await Bun.file(path).exists()).toBe(true)
    expect(await removeServerFile(4242, path)).toBe(true)
    expect(await Bun.file(path).exists()).toBe(false)
    expect(await removeServerFile(4242, path)).toBe(false)
  })

  test('urlFor maps the wildcard bind to localhost', () => {
    expect(urlFor({ port: 4949, host: '0.0.0.0' })).toBe('http://localhost:4949/')
    expect(urlFor({ port: 4949, host: '100.100.100.100' })).toBe('http://100.100.100.100:4949/')
  })

  // Off macOS the verb used to die on `launchctl: command not found`. It now
  // names the portable path instead — and points at the right supervisor.
  test('launchd is refused off macOS, pointing at `lore serve`', () => {
    expect(launchdUnsupported('darwin')).toBeNull()
    expect(launchdUnsupported('linux')).toContain('lore serve')
    expect(launchdUnsupported('linux')).toContain('systemd')
    expect(launchdUnsupported('win32')).toContain('Scheduled Task')
    expect(launchdUnsupported('win32')).toContain('macOS-only')
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

describe('selfArgv', () => {
  // The refresh child must be THIS build (config.ts): under `bun test` the
  // program is bun running this test file, so that is what comes back.
  test('re-invokes the running program by absolute path', () => {
    const argv = selfArgv()
    expect(argv[0]).toBe(process.execPath)
    expect(argv).toHaveLength(2)
    expect(argv[1]).toBe(Bun.main)
    expect(argv[1]!.startsWith('/') || /^[A-Za-z]:/.test(argv[1]!)).toBe(true)
  })
})
