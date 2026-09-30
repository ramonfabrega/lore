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
//          (the daemon files, plus the newest finished subagent transcript
//          of that version when the dir holds none yet)
//        bun scripts/harness-corpus.ts --subagent <agent-*.jsonl>
//          → subagent-<agentId>.jsonl (+ .meta.json) under the version the FILE
//            records, as a skeleton: every record keeps its type, timestamp
//            and ids, an assistant record its message id, model, stop_reason
//            and usage, every content block its type, tool name, tool-call id
//            and length in chars, and a tool's ack its `success` — never the
//            text, the input or the result. The spawn observatory (spawns.ts)
//            reads exactly these fields, and the harness has moved them
//            twice: 2.1.280 → 2.1.285 stopped writing the completion record
//            of a tool_use-ended request (the one with the real usage), and
//            2.1.307 started again. Nothing but a page read wrong said so
//            either time.
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
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

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

const argv = process.argv.slice(2)

// One subagent transcript, as a skeleton, under the version it records. A
// record's shape is the fixture; its words never are.
const SubRec = z.object({ type: z.string(), timestamp: z.string().optional(), version: z.string().optional(), cwd: z.string().optional() }).loose()
type SubRec = z.infer<typeof SubRec>

// Read a transcript and say whether it may be snapshotted: it must name a
// version, and every cwd it worked in must sit under a personal tree.
async function readSubagent(path: string): Promise<{ records: SubRec[]; version: string; cwds: Set<string> } | { refused: string }> {
  const records: SubRec[] = []
  for (const line of (await Bun.file(path).text()).split('\n')) {
    if (!line.trim()) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue // a torn tail: the file is appended live
    }
    const parsed = SubRec.safeParse(raw)
    if (parsed.success) records.push(parsed.data)
  }
  const version = records.find((r) => r.version)?.version
  if (!version) return { refused: 'no record carries a version' }
  const cwds = new Set(records.map((r) => r.cwd).filter((c): c is string => typeof c === 'string'))
  for (const c of cwds) if (!eligible(c)) return { refused: `cwd ${c} is not under a personal tree` }
  return { records, version, cwds }
}

function writeSubagent(path: string, records: SubRec[], fileVersion: string, meta: Record<string, unknown> | null): string {
  const chars = (b: Record<string, unknown>): number => {
    if (typeof b.text === 'string') return b.text.length
    if (typeof b.thinking === 'string') return b.thinking.length
    if ('input' in b) return JSON.stringify(b.input).length
    if (typeof b.content === 'string') return b.content.length
    if (Array.isArray(b.content)) return JSON.stringify(b.content).length
    return 0
  }
  const block = (b: unknown): unknown => {
    if (!b || typeof b !== 'object') return { type: typeof b, chars: typeof b === 'string' ? b.length : 0 }
    const o = b as Record<string, unknown>
    // A tool call keeps its id and a tool result the id it answers (and its
    // error flag): the pairing is how spawns.ts knows a handback was
    // DELIVERED, and an id is not a word.
    return {
      type: o.type,
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
      ...(o.type === 'tool_use' && typeof o.id === 'string' ? { id: o.id } : {}),
      ...(o.type === 'tool_result' && typeof o.tool_use_id === 'string' ? { tool_use_id: o.tool_use_id } : {}),
      ...(o.type === 'tool_result' && typeof o.is_error === 'boolean' ? { is_error: o.is_error } : {}),
      chars: chars(o),
    }
  }
  const skeleton = (r: SubRec): unknown => {
    const out: Record<string, unknown> = { type: r.type }
    for (const k of ['timestamp', 'version', 'agentId', 'sessionId', 'isSidechain', 'cwd', 'gitBranch', 'sessionKind', 'entrypoint'] as const)
      if (k in r) out[k] = scrub(r[k])
    // 2.1.300 records every API request beside the conversation
    // (`api-request`, `api-request-shape`, `api-request-blob`: the system
    // prompt, the tool list, the parameters). The fixture keeps the fact
    // that they are there and nothing of what they hold.
    if (r.type.startsWith('api-request')) return out
    // A tool's ack, as one boolean: `SubagentHandback` answers
    // `{success, message}` and the observatory reads the first.
    const ack = z.object({ success: z.boolean() }).loose().safeParse(r.toolUseResult)
    if (ack.success) out.toolUseResult = { success: ack.data.success }
    const m = r.message
    if (m && typeof m === 'object') {
      const msg = m as Record<string, unknown>
      const content = Array.isArray(msg.content) ? msg.content.map(block) : typeof msg.content === 'string' ? [block({ type: 'text', text: msg.content })] : undefined
      out.message =
        r.type === 'assistant'
          ? { id: msg.id, model: msg.model, role: msg.role, stop_reason: msg.stop_reason ?? null, usage: msg.usage ?? null, content }
          : { role: msg.role, content }
    }
    if (r.type === 'attachment') {
      const a = r.attachment
      out.attachment = { type: a && typeof a === 'object' && 'type' in a ? (a as { type: unknown }).type : null }
    }
    return out
  }
  const agentId = path.replace(/^.*agent-/, '').replace(/\.jsonl$/, '')
  const vdir = join(root, 'test', 'fixtures', 'harness', fileVersion)
  mkdirSync(vdir, { recursive: true })
  writeFileSync(join(vdir, `subagent-${agentId}.jsonl`), `${records.map((r) => JSON.stringify(skeleton(r))).join('\n')}\n`)
  // `description` is the opener of the spawn: a fragment, like `intent`.
  if (meta) writeFileSync(join(vdir, `subagent-${agentId}.meta.json`), `${JSON.stringify(scrub({ ...meta, description: cutTo(meta.description, 48) }), null, 2)}\n`)
  return agentId
}

async function readMeta(path: string): Promise<Record<string, unknown> | null> {
  const f = Bun.file(path.replace(/\.jsonl$/, '.meta.json'))
  if (!(await f.exists())) return null
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(await f.text()))
  } catch {
    return null
  }
}

// --subagent: the file named, whatever version it records.
const subAt = argv.indexOf('--subagent')
if (subAt >= 0) {
  const path = argv[subAt + 1]
  if (!path) {
    console.error('usage: harness-corpus.ts --subagent <agent-*.jsonl>')
    process.exit(2)
  }
  const sub = await readSubagent(path)
  if ('refused' in sub) {
    console.error(`${path}: ${sub.refused} — refusing`)
    process.exit(2)
  }
  const agentId = writeSubagent(path, sub.records, sub.version, await readMeta(path))
  console.error(`harness corpus: claude ${sub.version} subagent ${agentId} → ${sub.records.length} records, ${sub.cwds.size} cwd`)
  process.exit(0)
}

const version = (await Bun.$`claude --version`.text()).trim().split(/\s+/)[0] ?? 'unknown'
const dir = join(root, 'test', 'fixtures', 'harness', version)
mkdirSync(join(dir, 'jobs'), { recursive: true })
const write = (rel: string, v: unknown) => writeFileSync(join(dir, rel), `${JSON.stringify(v, null, 2)}\n`)
const slug = (name: unknown) => (typeof name === 'string' ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '') || 'unnamed'

// --probe: one job, snapshotted with the line that launched it.
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
for (const f of readdirSync(dir)) if (f.endsWith('.json') && !f.startsWith('subagent-')) rmSync(join(dir, f))
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

// A subagent transcript of THIS version, picked without being asked. The
// 2.1.299 and 2.1.321 snapshots were taken without one — `--subagent` was a
// second command, and the day it mattered nobody typed it: 2.1.307 moved the
// stop_reason of every tool_use-ended request and every finished spawn read
// as in flight for four days, with the corpus green. The newest finished
// spawn under a personal tree is the one taken; a version dir that already
// holds one is left alone, and none found is said out loud (the test fails a
// version without one).
let subagent = readdirSync(dir).some((f) => f.startsWith('subagent-') && f.endsWith('.jsonl')) ? 'kept' : 'none'
if (subagent === 'none') {
  const candidates: { path: string; mtimeMs: number }[] = []
  const projects = join(CLAUDE, 'projects')
  for (const well of existsSync(projects) ? readdirSync(projects) : []) {
    let sessions: string[]
    try {
      sessions = readdirSync(join(projects, well))
    } catch {
      continue // a transcript file, not a well dir
    }
    for (const session of sessions) {
      const sub = join(projects, well, session, 'subagents')
      if (!existsSync(sub)) continue
      for (const f of readdirSync(sub)) {
        if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue
        const path = join(sub, f)
        candidates.push({ path, mtimeMs: statSync(path).mtimeMs })
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  // Newest first, and a bounded look: a version's spawns are its newest files.
  for (const { path } of candidates.slice(0, 200)) {
    const meta = await readMeta(path)
    // `finished` is the harness's own word since 2.1.321 (absent while the
    // spawn runs). A file still being written is not a fixture.
    if (meta?.finished !== true) continue
    const sub = await readSubagent(path)
    if ('refused' in sub || sub.version !== version) continue
    subagent = writeSubagent(path, sub.records, sub.version, meta)
    break
  }
}
if (subagent === 'none')
  console.error(
    `harness corpus: NO subagent transcript of claude ${version} under a personal tree — spawn one (any subagent, from a session in ~/code/fun or ~/code/personal) and run: bun scripts/harness-corpus.ts --subagent <its agent-*.jsonl>`,
  )

console.error(`harness corpus: claude ${version} → ${dir}: ${rows.length} listing rows, ${jobs} jobs, ${workers} roster workers, subagent ${subagent}`)
