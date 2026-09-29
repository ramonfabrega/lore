import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { State as JobState } from './agents'

// The harness itself as a thing lore watches: which Claude Code is
// installed, which one is RUNNING (the daemon and each worker keep the
// binary they started with), what the release channels offer, and what the
// changelog says about the versions in between. Updates are manual here on
// purpose (docs/DESIGN.md, 2026-09-29): an update bounces the daemon under
// every live agent, releases land near-daily, and the daemon's shapes are a
// corpus lore re-snapshots per version — so the decision is made at a rest
// point, with the changelog read, not by a timer. This file is the reading
// half. It installs nothing: `claude install <version>` is typed in a plain
// terminal, because a session that runs it bounces the daemon it lives under.

// Where the native installer looks (the strings are in the binary): one
// line of text per channel. The registry is asked only for release DATES,
// which the channel files and the changelog do not carry.
export const CHANNELS_URL = 'https://downloads.claude.ai/claude-code-releases'
export const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'
export const REGISTRY_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code'

const VERSION = /^\d+\.\d+\.\d+$/

// Numeric per segment — '2.1.99' sorts before '2.1.100', which a string
// compare gets wrong the day the patch number gains a digit.
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export type Kind = 'added' | 'fixed' | 'improved' | 'changed' | 'removed' | 'other'
export type Entry = { version: string; surface: string; kind: Kind; topics: string[]; text: string }
export type Release = { version: string; entries: Entry[] }

// The changelog's grammar, measured over 406 versions (2026-09-29): every
// line is `## <version>` or `- <entry>`, an entry opens with an optional
// `[Surface]` tag and then a verb. 3682 Fixed, 774 Added, 617 Improved,
// 301 Changed; the long tail is older releases written before the verbs
// settled, which is what `other` is for.
const KINDS: Record<string, Kind> = {
  added: 'added', add: 'added', new: 'added',
  fixed: 'fixed', fix: 'fixed', bug: 'fixed',
  improved: 'improved', reduced: 'improved', updated: 'improved',
  changed: 'changed', renamed: 'changed', moved: 'changed', reverted: 'changed',
  removed: 'removed', deprecated: 'removed',
}

// A surface is WHERE an entry applies. `cli` is the terminal binary and its
// daemon — the only surface this fleet runs — and the default reading. The
// bracket form is always a surface; the `Name:` form only for these names,
// because `Hooks:` and `MCP:` open entries about the CLI itself.
const PREFIX_SURFACES = new Set(['windows', 'vscode', 'sdk', 'ide', 'bedrock', 'vertex', 'foundry', 'self-hosted runner', 'jetbrains'])

// What the fleet leans on, as topics an entry can touch. Deterministic tags,
// not a verdict: they say where to read first, and the session reading them
// decides what an entry means for a running commander.
const TOPICS: [string, RegExp][] = [
  // Not `/tasks` and not the agent panel: those are one session's own
  // background shells and subagents, which no update bounces.
  ['daemon', /\bdaemon\b|background (session|agent|job)s?|--bg\b|\/bg\b|`claude agents`|respawn|worker restart/i],
  ['spawn', /subagents?|\bAgent tool\b|teammates?|workflows?/i],
  ['messaging', /SendMessage|other sessions?|another (agent|session)|queued|--channels|\bchannels?\b/i],
  ['worktree', /worktrees?/i],
  ['transcript', /transcripts?|\bresum(e|ed|ing)\b|--continue|compact(ed|ing|ion)?\b/i],
  ['model', /\b(Fable|Opus|Sonnet|Haiku)\b|model id|`\/model`|\[1m\]|fallback model/i],
  ['permissions', /auto mode|classifier|permission|workspace trust|sandbox|--dangerously/i],
  ['config', /\bhooks?\b|settings\.json|CLAUDE\.md|auto-memory|MEMORY\.md|\bskills?\b/i],
  ['macos', /macOS|keychain|\bTCC\b|Screen Recording/i],
  ['usage', /usage limit|rate limit|prompt cach|\bcache\b|`\/usage`/i],
  ['update', /auto-?updat|`claude (update|install)`|release channel/i],
]

function parseEntry(version: string, line: string): Entry {
  let text = line
  let surface = 'cli'
  const tag = /^\[([^\]]+)\]\s+/.exec(text)
  if (tag) {
    surface = tag[1]!.toLowerCase()
    text = text.slice(tag[0].length)
  } else {
    const pre = /^([A-Z][A-Za-z -]{2,24}):\s+/.exec(text)
    if (pre && PREFIX_SURFACES.has(pre[1]!.toLowerCase())) {
      surface = pre[1]!.toLowerCase()
      text = text.slice(pre[0].length)
    } else if (/\bClaude apps gateway\b/.test(text)) surface = 'gateway'
    else if (/\bself-hosted runners?\b/i.test(text)) surface = 'self-hosted runner'
  }
  const verb = (/^[A-Za-z]+/.exec(text)?.[0] ?? '').toLowerCase()
  return {
    version,
    surface,
    kind: KINDS[verb] ?? 'other',
    topics: TOPICS.filter(([, re]) => re.test(text)).map(([t]) => t),
    text,
  }
}

// Newest first, as the file is written.
export function parseChangelog(md: string): Release[] {
  const out: Release[] = []
  let cur: Release | null = null
  for (const raw of md.split('\n')) {
    const head = /^##\s+(\d+\.\d+\.\d+)\s*$/.exec(raw)
    if (head) {
      cur = { version: head[1]!, entries: [] }
      out.push(cur)
    } else if (cur && raw.startsWith('- ')) cur.entries.push(parseEntry(cur.version, raw.slice(2).trim()))
  }
  return out
}

// (from, to] — what an update from `from` to `to` brings. Newest first.
export function between(releases: Release[], from: string, to: string): Release[] {
  return releases
    .filter((r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
}

// --- what is on this machine ---

const DaemonLock = z.object({ version: z.string(), pid: z.number(), startedAt: z.number() }).loose()
const Roster = z.object({ workers: z.record(z.string(), z.object({ cliVersion: z.string(), cwd: z.string() }).loose()) }).loose()
const Settings = z.object({ env: z.record(z.string(), z.unknown()).optional() }).loose()

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  if (!existsSync(path)) return null
  try {
    return schema.parse(JSON.parse(await Bun.file(path).text()))
  } catch {
    return null
  }
}

export type Worker = { id: string; name: string | null; state: string | null; tempo: string | null; version: string; cwd: string }
export type Here = {
  installed: string | null
  installedAt: string | null
  // Versions still on disk beside the installed one — what `claude install
  // <version>` can return to without a download.
  onDisk: string[]
  autoUpdate: 'on' | 'off'
  daemon: { version: string; pid: number; startedAt: string } | null
  workers: Worker[]
}

// The native install is a symlink to `…/versions/<version>`, so the link IS
// the version and no process is spawned to read it. Anything else (an npm
// install, a wrapper) is asked.
async function installedVersion(bin: string | null): Promise<{ version: string | null; path: string | null }> {
  if (!bin) return { version: null, path: null }
  let real: string
  try {
    real = realpathSync(bin)
  } catch {
    return { version: null, path: null }
  }
  if (VERSION.test(basename(real))) return { version: basename(real), path: real }
  const r = await Bun.$`${bin} --version`.quiet().nothrow()
  const v = r.stdout.toString().trim().split(/\s+/)[0] ?? ''
  return { version: VERSION.test(v) ? v : null, path: null }
}

export async function readHere(opts: { claudeDir: string; bin: string | null; env?: Record<string, string | undefined> }): Promise<Here> {
  const { version, path } = await installedVersion(opts.bin)
  const onDisk = path
    ? readdirSync(dirname(path))
        .filter((f) => VERSION.test(f))
        .sort(compareVersions)
    : []
  const settings = await readJson(join(opts.claudeDir, 'settings.json'), Settings)
  const off = (v: unknown) => v != null && v !== '' && v !== '0' && v !== 'false' && v !== false
  const lock = await readJson(join(opts.claudeDir, 'daemon.lock'), DaemonLock)
  const roster = await readJson(join(opts.claudeDir, 'daemon', 'roster.json'), Roster)
  const workers = await Promise.all(
    Object.entries(roster?.workers ?? {}).map(async ([id, w]): Promise<Worker> => {
      const st = await readJson(join(opts.claudeDir, 'jobs', id, 'state.json'), JobState)
      return { id, name: st?.name ?? null, state: st?.state ?? null, tempo: st?.tempo ?? null, version: w.cliVersion, cwd: w.cwd }
    }),
  )
  return {
    installed: version,
    installedAt: path ? statSync(path).mtime.toISOString() : null,
    onDisk,
    autoUpdate: off(settings?.env?.DISABLE_AUTOUPDATER) || off((opts.env ?? process.env).DISABLE_AUTOUPDATER) ? 'off' : 'on',
    daemon: lock ? { version: lock.version, pid: lock.pid, startedAt: new Date(lock.startedAt).toISOString() } : null,
    workers,
  }
}

// --- what is out there ---

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
const Packument = z.object({ time: z.record(z.string(), z.string()) }).loose()

async function text(fetcher: Fetch, url: string): Promise<string> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return res.text()
}

export type There = {
  latest: string | null
  stable: string | null
  releases: Release[]
  dates: Record<string, string>
  // One line per source that did not answer. Every source fails alone: a
  // dead registry costs the dates, not the changelog.
  errors: string[]
}

export async function readThere(fetcher: Fetch = fetch): Promise<There> {
  const errors: string[] = []
  const attempt = async <T>(what: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run()
    } catch (e) {
      errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }
  const channel = (name: string) =>
    attempt(`channel ${name}`, async () => {
      const v = (await text(fetcher, `${CHANNELS_URL}/${name}`)).trim()
      if (!VERSION.test(v)) throw new Error(`not a version: ${v.slice(0, 40)}`)
      return v
    })
  const [latest, stable, md, packument] = await Promise.all([
    channel('latest'),
    channel('stable'),
    attempt('changelog', () => text(fetcher, CHANGELOG_URL)),
    attempt('registry', async () => Packument.parse(JSON.parse(await text(fetcher, REGISTRY_URL)))),
  ])
  return { latest, stable, releases: md ? parseChangelog(md) : [], dates: packument?.time ?? {}, errors }
}

// --- the two readings ---

const count = <T extends string>(xs: T[]) => {
  const out: Partial<Record<T, number>> = {}
  for (const x of xs) out[x] = (out[x] ?? 0) + 1
  return out
}

export function harnessStatus(here: Here, there: There) {
  const { installed } = here
  const target = there.latest
  const pending = installed && target ? between(there.releases, installed, target) : []
  const warnings: string[] = [...there.errors]
  if (!installed) warnings.push('no `claude` on PATH, or its version could not be read')
  // The daemon and every worker keep the binary they started with: after an
  // install, anything listed here at another version is still the OLD one
  // until it restarts.
  const stale = here.workers.filter((w) => installed != null && w.version !== installed)
  if (installed && here.daemon && here.daemon.version !== installed)
    warnings.push(`the daemon runs ${here.daemon.version}, installed is ${installed} — new agents start on the daemon's version until it restarts`)
  if (stale.length) warnings.push(`${stale.length} worker(s) still run an older binary: ${stale.map((w) => `${w.name ?? w.id} ${w.version}`).join(', ')}`)
  if (here.autoUpdate === 'on') warnings.push('auto-update is ON — the next release installs itself and bounces the daemon under whatever is running')
  if (installed && there.stable && compareVersions(installed, there.stable) > 0 && target && compareVersions(installed, target) < 0)
    warnings.push(`installed ${installed} is past stable (${there.stable}) — the only way forward is the latest channel`)
  return {
    installed,
    installedAt: here.installedAt,
    autoUpdate: here.autoUpdate,
    channels: {
      latest: target ? { version: target, released: there.dates[target] ?? null } : null,
      stable: there.stable ? { version: there.stable, released: there.dates[there.stable] ?? null } : null,
    },
    behind: pending.length,
    daemon: here.daemon,
    workers: here.workers,
    onDisk: here.onDisk,
    pending: pending.map((r) => {
      const cli = r.entries.filter((e) => e.surface === 'cli')
      return {
        version: r.version,
        released: there.dates[r.version] ?? null,
        entries: r.entries.length,
        cli: cli.length,
        kinds: count(cli.map((e) => e.kind)),
        topics: count(cli.flatMap((e) => e.topics)),
      }
    }),
    ...(warnings.length ? { warnings } : {}),
  }
}

export type ChangelogQuery = {
  from?: string
  to?: string
  // `cli` unless named; `all` lifts the filter.
  surface?: string
  kind?: Kind
  topic?: string
  grep?: string
}

export function harnessChangelog(here: Pick<Here, 'installed'>, there: There, q: ChangelogQuery) {
  const from = q.from ?? here.installed
  const to = q.to ?? there.latest
  if (!from) throw new Error('no installed version to read from — pass --from <version>')
  if (!to) throw new Error(`the latest channel did not answer (${there.errors.join('; ') || 'no error recorded'}) — pass --to <version>`)
  if (there.releases.length === 0) throw new Error(`no changelog to read: ${there.errors.join('; ') || 'it parsed to zero releases'}`)
  const surface = q.surface ?? 'cli'
  const re = q.grep ? new RegExp(q.grep, 'i') : null
  const range = between(there.releases, from, to)
  const all = range.flatMap((r) => r.entries)
  const entries = all.filter(
    (e) =>
      (surface === 'all' || e.surface === surface) &&
      (!q.kind || e.kind === q.kind) &&
      (!q.topic || e.topics.includes(q.topic)) &&
      (!re || re.test(e.text)),
  )
  return {
    from,
    to,
    releases: range.map((r) => ({ version: r.version, released: there.dates[r.version] ?? null })),
    surface,
    total: all.length,
    // What the surface filter is hiding, so a reader knows what `--surface
    // all` would add before asking for it.
    surfaces: count(all.map((e) => e.surface)),
    count: entries.length,
    // Flat rows, topics space-joined: a nested array per entry costs the
    // table form, and this listing is read whole.
    entries: entries.map((e) => ({ version: e.version, surface: e.surface, kind: e.kind, topics: e.topics.join(' '), text: e.text })),
    ...(there.errors.length ? { warnings: there.errors } : {}),
  }
}

export const TOPIC_NAMES = TOPICS.map(([t]) => t)
