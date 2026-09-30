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
//        bun scripts/harness-corpus.ts --probe <jobId> [--note "…"] -- <the argv as typed>
//          → jobs/probe-<name>-<id>.json (the state.json, scrubbed) beside
//            jobs/probe-<name>-<id>.launch.json ({ typed, note }): a PROBE is a
//            job launched to measure how the harness records a launch, and the
//            sidecar keeps what was typed so the test can hold the recorded
//            array against it. Probes survive a re-snapshot; the jobs they
//            came from are removed once written (they were throwaways).
//
// The repo is public, so the snapshot is SCRUBBED, not copied: only jobs
// whose cwd is under a personal tree (never ~/code/work); $HOME rewritten;
// auth tokens, owner uuids and provider env dropped; the opener (`intent`),
// `detail`, `needs` and fan labels replaced by their own key name; `output`
// dropped; link hrefs replaced. The test re-checks the scrub — a fixture is the one file that
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
const FRAME_ID = 'frame.html'
const FRAME_TITLE = 'frame'
const ARG_MAX = 200
const PROSE = new Set(['intent', 'detail', 'needs', 'label', 'question', 'header', 'description'])
const cutTo = (s: unknown, n: number) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s)

function scrub(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => scrub(x, key))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    // A frame is an artifact the session published. Its title and its id
    // (the file name — the title, slugged) name what the work was ABOUT,
    // and the eligible-cwd rule cannot vouch for that: a session in a
    // personal well publishes a plan for a work project. The shape is the
    // fixture; the name never is.
    const frame = 'kind' in v && v.kind === 'frame'
    for (const [k, x] of Object.entries(v)) {
      if (DROP_KEY.test(k)) continue
      if (k === 'href') {
        out[k] = 'https://example.invalid/link'
        continue
      }
      if (frame && (k === 'title' || k === 'id')) {
        out[k] = k === 'id' ? FRAME_ID : FRAME_TITLE
        continue
      }
      // Prose a session wrote about its work names the work, and a
      // fragment of it still does: lore's own job sat in a personal well
      // with ten fan labels reading "Mine <a work repo> …", cut to 60
      // characters and whole. Same rule as the frame — the shape is the
      // fixture (a string, and whether it is EMPTY, which the pages read),
      // the words never are. A job blocked on a question carries the whole
      // question (`block.questions[]`: question, header, and each option's
      // label and description), which is the same prose at four times the
      // length.
      if (PROSE.has(k) && typeof x === 'string') out[k] = x === '' ? '' : k
      // Cut first, then scrub — a fragment still carries a path.
      else if (k === 'title') out[k] = scrub(cutTo(x, 80))
      else out[k] = scrub(x, k)
    }
    return out
  }
  // The home dir appears twice: as a path, and SLUGGED inside a well dir
  // (`-Users-rf-…-code-fun-x`, CLAUDE.md `slugWellDir`) in transcript paths.
  if (typeof v === 'string') {
    // The opener is also an ARGUMENT: the roster records the launch argv
    // (`dispatch.launch.args`, `respawnFlags`) and the positional prompt
    // rides in it whole — a commander's 4 KB brief to a lane, three lanes
    // deep, under a key named for flags. No flag or path is this long.
    const s = (key === 'args' || key === 'respawnFlags') && v.length > ARG_MAX ? `${v.slice(0, 48)}…` : v
    return s.split(HOME).join('/Users/u').split(HOME_SLUG).join('-Users-u')
  }
  return v
}

const version = (await Bun.$`claude --version`.text()).trim().split(/\s+/)[0] ?? 'unknown'
const dir = join(root, 'test', 'fixtures', 'harness', version)
mkdirSync(join(dir, 'jobs'), { recursive: true })
const write = (rel: string, v: unknown) => writeFileSync(join(dir, rel), `${JSON.stringify(v, null, 2)}\n`)
const slug = (name: unknown) => (typeof name === 'string' ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '') || 'unnamed'

// --probe: one job, snapshotted with the line that launched it.
const argv = process.argv.slice(2)
const probeAt = argv.indexOf('--probe')
if (probeAt >= 0) {
  const id = argv[probeAt + 1]
  const dash = argv.indexOf('--')
  const typed = dash >= 0 ? argv.slice(dash + 1) : []
  const noteAt = argv.indexOf('--note')
  const note = noteAt >= 0 ? argv[noteAt + 1] : undefined
  if (!id || typed.length === 0) {
    console.error('usage: harness-corpus.ts --probe <jobId> [--note "…"] -- <argv as typed>')
    process.exit(2)
  }
  const st = JSON.parse(await Bun.file(join(CLAUDE, 'jobs', id, 'state.json')).text()) as Record<string, unknown>
  if (!eligible(st.cwd)) {
    console.error(`probe ${id}: cwd ${String(st.cwd)} is not under a personal tree — refusing`)
    process.exit(2)
  }
  const base = join('jobs', `probe-${slug(st.name)}-${id.slice(0, 8)}`)
  write(`${base}.json`, scrub(st))
  write(`${base}.launch.json`, { typed, ...(note ? { note } : {}) })
  console.error(`harness corpus: claude ${version} probe ${id} → ${base}.json (+ .launch.json)`)
  process.exit(0)
}

// A full snapshot replaces everything it produces and keeps the probes.
for (const f of readdirSync(dir)) if (f.endsWith('.json')) rmSync(join(dir, f))
for (const f of readdirSync(join(dir, 'jobs'))) if (!f.startsWith('probe-')) rmSync(join(dir, 'jobs', f))

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
  write(join('jobs', `${slug(st.name)}-${id.slice(0, 8)}.json`), scrub(st))
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
