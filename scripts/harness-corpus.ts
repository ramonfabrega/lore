#!/usr/bin/env bun
// Snapshot the harness's UNDOCUMENTED shapes into a per-version fixture
// corpus: `claude agents --json --all` (the daemon's listing), the daemon's
// `roster.json`, and a job's `state.json` for every eligible background job.
// Both lore (zod, agents.ts / jobs.ts) and ccc (lenient Codable decoders)
// read these files, every Claude Code update moves them (launch flags,
// `children[]` being links not spawns, `replPid` vs `pid`), and until now
// the only instrument was a banner on change. test/harness-corpus.test.ts
// parses every version here with every schema lore has and asserts the
// invariants lore leans on — so a version that moves a field fails a test
// on the day it is snapshotted, not a page a week later.
//
// Usage: bun scripts/harness-corpus.ts   → test/fixtures/harness/<cliVersion>/
//
// The repo is public, so the snapshot is SCRUBBED, not copied: only jobs
// whose cwd is under a personal tree (never ~/code/work); $HOME rewritten;
// auth tokens, owner uuids and provider env dropped; the opener (`intent`),
// `detail` and fan labels cut to a fragment; `output` dropped; link hrefs
// replaced. The test re-checks the scrub — a fixture is the one file that
// must never carry what the live record carries.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = homedir()
const HOME_SLUG = HOME.replace(/[^A-Za-z0-9]/g, '-')
const CLAUDE = join(HOME, '.claude')
const root = fileURLToPath(new URL('..', import.meta.url))

const ELIGIBLE = [join(HOME, 'code', 'fun') + '/', join(HOME, 'code', 'personal') + '/', join(HOME, '.claude', 'jobs') + '/']
const eligible = (cwd: unknown) => typeof cwd === 'string' && ELIGIBLE.some((p) => cwd === p.slice(0, -1) || cwd.startsWith(p))

// `tokens` (the live counter) stays: it is a shape the roster parses.
const DROP_KEY = /auth$|^bridgeOwner|^providerEnv$|^output$|^token$|secret|password/i
const cutTo = (s: unknown, n: number) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s)

function scrub(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => scrub(x, key))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      if (DROP_KEY.test(k)) continue
      if (k === 'href') {
        out[k] = 'https://example.invalid/link'
        continue
      }
      // Cut first, then scrub — a fragment still carries a path.
      if (k === 'intent') out[k] = scrub(cutTo(x, 48))
      else if (k === 'detail' || k === 'title') out[k] = scrub(cutTo(x, 80))
      else if (k === 'label') out[k] = scrub(cutTo(x, 60))
      else out[k] = scrub(x, k)
    }
    return out
  }
  // The home dir appears twice: as a path, and SLUGGED inside a well dir
  // (`-Users-rf-…-code-fun-x`, CLAUDE.md `slugWellDir`) in transcript paths.
  if (typeof v === 'string') return v.split(HOME).join('/Users/u').split(HOME_SLUG).join('-Users-u')
  return v
}

const version = (await Bun.$`claude --version`.text()).trim().split(/\s+/)[0] ?? 'unknown'
const dir = join(root, 'test', 'fixtures', 'harness', version)
rmSync(dir, { recursive: true, force: true })
mkdirSync(join(dir, 'jobs'), { recursive: true })
const write = (rel: string, v: unknown) => writeFileSync(join(dir, rel), `${JSON.stringify(v, null, 2)}\n`)

// The listing: rows for eligible cwds only.
const listing = JSON.parse((await Bun.$`claude agents --json --all`.text()) || '[]') as { cwd?: unknown }[]
const rows = listing.filter((r) => eligible(r.cwd))
write('agents.json', scrub(rows))

// Every eligible job's state.json, named by its name and id.
let jobs = 0
for (const id of readdirSync(join(CLAUDE, 'jobs'))) {
  const f = Bun.file(join(CLAUDE, 'jobs', id, 'state.json'))
  if (!(await f.exists())) continue
  let st: Record<string, unknown>
  try {
    st = JSON.parse(await f.text())
  } catch {
    continue
  }
  if (!eligible(st.cwd)) continue
  const name = typeof st.name === 'string' ? st.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'unnamed'
  write(join('jobs', `${name || 'unnamed'}-${id.slice(0, 8)}.json`), scrub(st))
  jobs++
}

// The daemon's roster: eligible workers only.
const rosterFile = Bun.file(join(CLAUDE, 'daemon', 'roster.json'))
let workers = 0
if (await rosterFile.exists()) {
  const roster = JSON.parse(await rosterFile.text()) as { workers?: Record<string, { cwd?: unknown }> }
  const kept = Object.fromEntries(Object.entries(roster.workers ?? {}).filter(([, w]) => eligible(w.cwd)))
  workers = Object.keys(kept).length
  write('roster.json', scrub({ ...roster, workers: kept }))
}

console.error(`harness corpus: claude ${version} → ${dir}: ${rows.length} listing rows, ${jobs} jobs, ${workers} roster workers`)
