import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { between, CHANGELOG_URL, CHANNELS_URL, compareVersions, harnessChangelog, harnessStatus, parseChangelog, readHere, readThere, REGISTRY_URL } from '../src/harness'

// The changelog's own grammar, cut from the real file: bracket surfaces, a
// `Name:` surface, a `Name:` that is NOT a surface, the gateway (named only
// in its prose), and an old-style entry with no verb.
const MD = `# Changelog

## 2.1.284

- Added Claude Sonnet 5.5 (\`claude-sonnet-5-5\`), now the default Sonnet model on the Anthropic API
- Fixed sessions launched without the \`SendMessage\` tool still being told to message other sessions with it
- Changed interactive terminal sessions to start in auto mode when no permission mode is configured
- Added dollar amounts to the Claude apps gateway spend limit in \`/usage\`
- [VSCode] Fixed typing \`/model\` and Enter printing usage text into the chat
- Self-hosted runner: Changed lifecycle hooks' git to skip a repository's Git LFS \`pre-push\` hook

## 2.1.281

- Fixed \`claude --bg\` starting a background session in a directory that had not passed the workspace trust prompt
- Hooks: Fixed a failed hook's stderr being dropped
- Deprecated the old thing
- The agent panel now scrolls

## 2.1.280

- Added Claude Opus 5.5 (\`claude-opus-5-5\`)

## 2.1.99

- Fixed something older
`

describe('versions', () => {
  test('compare numerically per segment, not as strings', () => {
    expect(compareVersions('2.1.99', '2.1.100')).toBeLessThan(0)
    expect(compareVersions('2.1.280', '2.1.280')).toBe(0)
    expect(compareVersions('2.2.0', '2.1.999')).toBeGreaterThan(0)
    expect(['2.1.280', '2.1.99', '2.1.100'].sort(compareVersions)).toEqual(['2.1.99', '2.1.100', '2.1.280'])
  })
})

describe('changelog', () => {
  const releases = parseChangelog(MD)
  const entry = (needle: string) => releases.flatMap((r) => r.entries).find((e) => e.text.includes(needle))!

  test('one release per heading, newest first, entries under their version', () => {
    expect(releases.map((r) => [r.version, r.entries.length])).toEqual([['2.1.284', 6], ['2.1.281', 4], ['2.1.280', 1], ['2.1.99', 1]])
  })

  test('surface: the bracket tag, a known `Name:` prefix, the gateway by its prose — and `Hooks:` stays the CLI', () => {
    // The tag comes off the text; a prefix that is not a surface stays on it.
    expect(entry('printing usage text')).toMatchObject({ surface: 'vscode', kind: 'fixed' })
    expect(entry('printing usage text').text).toStartWith('Fixed typing')
    expect(entry('Git LFS')).toMatchObject({ surface: 'self-hosted runner', kind: 'changed' })
    expect(entry('Git LFS').text).toStartWith('Changed lifecycle')
    expect(entry('spend limit').surface).toBe('gateway')
    expect(entry('stderr')).toMatchObject({ surface: 'cli', kind: 'other' })
    expect(entry('stderr').text).toStartWith('Hooks: ')
  })

  test('kind is the leading verb; a line with none is `other`', () => {
    expect(entry('Sonnet 5.5').kind).toBe('added')
    expect(entry('SendMessage').kind).toBe('fixed')
    expect(entry('auto mode').kind).toBe('changed')
    expect(entry('old thing').kind).toBe('removed')
    expect(entry('agent panel').kind).toBe('other')
  })

  test('topics tag what the fleet leans on; the agent panel is not the daemon', () => {
    expect(entry('Sonnet 5.5').topics).toEqual(['model'])
    expect(entry('SendMessage').topics).toEqual(['messaging'])
    expect(entry('claude --bg').topics).toEqual(['daemon', 'permissions'])
    expect(entry('agent panel').topics).toEqual([])
  })

  test('between is (from, to] and holds across a digit change', () => {
    expect(between(releases, '2.1.280', '2.1.284').map((r) => r.version)).toEqual(['2.1.284', '2.1.281'])
    expect(between(releases, '2.1.99', '2.1.280').map((r) => r.version)).toEqual(['2.1.280'])
    expect(between(releases, '2.1.284', '2.1.284')).toEqual([])
  })
})

const there = (over: Partial<Awaited<ReturnType<typeof readThere>>> = {}) => ({
  latest: '2.1.284',
  stable: '2.1.277',
  releases: parseChangelog(MD),
  dates: { '2.1.284': '2026-09-28T17:11:59.750Z', '2.1.281': '2026-09-23T17:01:17.780Z' },
  errors: [],
  ...over,
})
const here = (over: Partial<Awaited<ReturnType<typeof readHere>>> = {}) => ({
  installed: '2.1.280',
  installedAt: '2026-09-22T20:10:03.955Z',
  onDisk: ['2.1.260', '2.1.280'],
  autoUpdate: 'off' as const,
  daemon: { version: '2.1.280', pid: 1, startedAt: '2026-09-22T20:10:19.988Z' },
  workers: [{ id: 'a', name: 'attrition', state: 'working', tempo: 'idle', version: '2.1.280', cwd: '/u/code/fun/attrition' }],
  ...over,
})

describe('harness status', () => {
  test('behind counts the releases in between; pending rolls up the CLI entries only', () => {
    const s = harnessStatus(here(), there())
    expect(s.behind).toBe(2)
    expect(s.channels.latest).toEqual({ version: '2.1.284', released: '2026-09-28T17:11:59.750Z' })
    expect(s.channels.stable).toEqual({ version: '2.1.277', released: null })
    expect(s.pending[0]).toMatchObject({ version: '2.1.284', entries: 6, cli: 3, kinds: { added: 1, fixed: 1, changed: 1 }, topics: { model: 1, messaging: 1, permissions: 1 } })
    expect(s.warnings).toEqual(['installed 2.1.280 is past stable (2.1.277) — the only way forward is the latest channel'])
  })

  test('up to date: nothing pending, nothing to warn about', () => {
    const s = harnessStatus(here({ installed: '2.1.284' }), there({ stable: '2.1.284' }))
    expect(s.behind).toBe(0)
    expect(s.pending).toEqual([])
    expect(s.warnings).toEqual(['the daemon runs 2.1.280, installed is 2.1.284 — new agents start on the daemon\'s version until it restarts', '1 worker(s) still run an older binary: attrition 2.1.280'])
    const settled = here({ installed: '2.1.284', daemon: { version: '2.1.284', pid: 2, startedAt: 'x' }, workers: [] })
    expect(harnessStatus(settled, there({ stable: '2.1.284' })).warnings).toBeUndefined()
  })

  test('auto-update on is a warning, and a dead source is one line, not a throw', () => {
    const s = harnessStatus(here({ autoUpdate: 'on' }), there({ latest: null, errors: ['channel latest: offline'] }))
    expect(s.behind).toBe(0)
    expect(s.channels.latest).toBeNull()
    expect(s.warnings).toContain('channel latest: offline')
    expect(s.warnings?.join('\n')).toContain('auto-update is ON')
  })
})

describe('harness changelog', () => {
  test('defaults to installed → latest on the CLI surface, and says what the filter hides', () => {
    const c = harnessChangelog(here(), there(), {})
    expect(c).toMatchObject({ from: '2.1.280', to: '2.1.284', surface: 'cli', total: 10, count: 7 })
    expect(c.surfaces).toEqual({ cli: 7, gateway: 1, vscode: 1, 'self-hosted runner': 1 })
    expect(c.entries[0]).toMatchObject({ version: '2.1.284', surface: 'cli', kind: 'added', topics: 'model' })
    expect(c.entries[0]?.text).toContain('Sonnet 5.5')
  })

  test('filters compose: surface, kind, topic, grep', () => {
    expect(harnessChangelog(here(), there(), { surface: 'all' }).count).toBe(10)
    expect(harnessChangelog(here(), there(), { surface: 'vscode' }).count).toBe(1)
    expect(harnessChangelog(here(), there(), { kind: 'changed' }).entries.map((e) => e.version)).toEqual(['2.1.284'])
    expect(harnessChangelog(here(), there(), { topic: 'daemon' }).entries.map((e) => e.topics)).toEqual(['daemon permissions'])
    expect(harnessChangelog(here(), there(), { grep: 'sendmessage|trust' }).count).toBe(2)
  })

  test('any range can be read, e.g. what a past update brought', () => {
    expect(harnessChangelog(here(), there(), { from: '2.1.99', to: '2.1.280' }).entries.map((e) => e.text)).toEqual(['Added Claude Opus 5.5 (`claude-opus-5-5`)'])
  })

  test('a missing end of the range is an error that names the flag', () => {
    expect(() => harnessChangelog(here({ installed: null }), there(), {})).toThrow('--from')
    expect(() => harnessChangelog(here(), there({ latest: null, errors: ['channel latest: offline'] }), {})).toThrow('--to')
    expect(() => harnessChangelog(here(), there({ releases: [], errors: ['changelog: offline'] }), {})).toThrow('changelog: offline')
  })
})

describe('readThere', () => {
  const serve = (routes: Record<string, string | null>) => async (url: string) => {
    const body = routes[url]
    return body == null ? new Response('no', { status: 503 }) : new Response(body)
  }

  test('reads both channels, the changelog and the dates', async () => {
    const t = await readThere(
      serve({
        [`${CHANNELS_URL}/latest`]: '2.1.284\n',
        [`${CHANNELS_URL}/stable`]: '2.1.277',
        [CHANGELOG_URL]: MD,
        [REGISTRY_URL]: JSON.stringify({ name: 'x', time: { '2.1.284': '2026-09-28T17:11:59.750Z' } }),
      }),
    )
    expect(t).toMatchObject({ latest: '2.1.284', stable: '2.1.277', dates: { '2.1.284': '2026-09-28T17:11:59.750Z' }, errors: [] })
    expect(t.releases).toHaveLength(4)
  })

  test('every source fails alone: a dead registry costs the dates, a channel that is not a version is refused', async () => {
    const t = await readThere(serve({ [`${CHANNELS_URL}/latest`]: '<html>moved</html>', [`${CHANNELS_URL}/stable`]: '2.1.277', [CHANGELOG_URL]: MD, [REGISTRY_URL]: null }))
    expect(t.latest).toBeNull()
    expect(t.stable).toBe('2.1.277')
    expect(t.releases).toHaveLength(4)
    expect(t.dates).toEqual({})
    expect(t.errors).toHaveLength(2)
    expect(t.errors.join('\n')).toContain('channel latest: not a version')
    expect(t.errors.join('\n')).toMatch(/registry: .* answered 503/)
  })
})

describe('readHere', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-harness-'))
  const claudeDir = join(root, '.claude')
  const versions = join(root, 'share', 'versions')
  mkdirSync(join(claudeDir, 'daemon'), { recursive: true })
  mkdirSync(join(claudeDir, 'jobs', 'aaaa1111'), { recursive: true })
  mkdirSync(versions, { recursive: true })
  for (const v of ['2.1.99', '2.1.280', '2.1.100']) writeFileSync(join(versions, v), '')
  writeFileSync(join(versions, '.DS_Store'), '')
  const bin = join(root, 'claude')
  symlinkSync(join(versions, '2.1.280'), bin)
  writeFileSync(join(claudeDir, 'daemon.lock'), JSON.stringify({ pid: 17682, version: '2.1.260', startedAt: 1790107819988, launchTarget: 'x' }))
  writeFileSync(
    join(claudeDir, 'daemon', 'roster.json'),
    JSON.stringify({ proto: 1, workers: { aaaa1111: { cliVersion: '2.1.260', cwd: '/u/a', pid: 1 }, bbbb2222: { cliVersion: '2.1.280', cwd: '/u/b', pid: 2 } } }),
  )
  writeFileSync(join(claudeDir, 'jobs', 'aaaa1111', 'state.json'), JSON.stringify({ name: 'attrition', state: 'working', tempo: 'idle' }))

  test('the symlink is the version; the daemon and each worker say what they run', async () => {
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ env: { DISABLE_AUTOUPDATER: '1' } }))
    const h = await readHere({ claudeDir, bin, env: {} })
    expect(h.installed).toBe('2.1.280')
    expect(h.onDisk).toEqual(['2.1.99', '2.1.100', '2.1.280'])
    expect(h.autoUpdate).toBe('off')
    expect(h.daemon).toEqual({ version: '2.1.260', pid: 17682, startedAt: new Date(1790107819988).toISOString() })
    expect(h.workers).toEqual([
      { id: 'aaaa1111', name: 'attrition', state: 'working', tempo: 'idle', version: '2.1.260', cwd: '/u/a' },
      { id: 'bbbb2222', name: null, state: null, tempo: null, version: '2.1.280', cwd: '/u/b' },
    ])
  })

  test('auto-update is on unless the variable is set, in settings.json or the environment', async () => {
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ env: {} }))
    expect((await readHere({ claudeDir, bin, env: {} })).autoUpdate).toBe('on')
    expect((await readHere({ claudeDir, bin, env: { DISABLE_AUTOUPDATER: '0' } })).autoUpdate).toBe('on')
    expect((await readHere({ claudeDir, bin, env: { DISABLE_AUTOUPDATER: '1' } })).autoUpdate).toBe('off')
  })

  test('no binary and no daemon files: nulls, not a throw', async () => {
    const h = await readHere({ claudeDir: join(root, 'nowhere'), bin: null, env: {} })
    expect(h).toEqual({ installed: null, installedAt: null, onDisk: [], autoUpdate: 'on', daemon: null, workers: [] })
  })
})
