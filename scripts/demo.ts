#!/usr/bin/env bun
// A synthetic ~/.claude, so lore can be shown without showing anyone's work.
//
// Screenshots of the explorer are the only honest way to describe it, and every
// real one is full of the operator's project names, prompts and spend. The
// obvious fix — capture a real view and redact it — leaves you asserting you
// caught everything. This is the other fix: there was never anything to catch.
// The corpus is invented; the explorer rendering it is the real one.
//
// It works because lore already reads its inputs from three seams, so none of
// this needs a demo mode, a redaction flag, or any other defensiveness in the
// product:
//
//   LORE_CLAUDE_DIR  where transcripts and job state are read from
//   LORE_HOME        where the archive and the SQLite index live
//   PATH             the live agent roster shells out to `claude agents --json`
//
// The third one matters more than it looks. The dashboard's agents panel does
// NOT read the index — it asks the running daemon — so it renders the real
// fleet no matter how synthetic the corpus is. That is a property of the page,
// not a gap here: it leaks in a screenshare or a recorded demo just as much as
// in a screenshot. Putting the stub written below first on PATH is what makes
// the dashboard capturable at all.
//
// Deterministic: same seed, same corpus, so a recapture months from now differs
// only where the explorer itself changed. Counts are tuned so every view FILLS
// a 1440x900 frame — a screenshot with dead space under the content reads as a
// bad crop, and a session with two prompts does not look like a session.
//
// Usage:
//   bun scripts/demo.ts [--out <dir>]
//
// It prints the serve and capture commands when it is done. It deliberately
// does NOT drive a browser: a headless Chrome is not a dependency of lore and
// is not worth becoming one to take pictures.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------- the corpus

// Counts fill a 1440x900 frame: the well arc wants enough sessions to run past
// the fold, the session block enough transactions to look like real work.
const WELLS = [
  { dir: '-Users-you-code-app', cwd: '/Users/you/code/app', n: 16 },
  { dir: '-Users-you-code-api', cwd: '/Users/you/code/api', n: 11 },
  { dir: '-Users-you-code-app-worktrees-search-spike', cwd: '/Users/you/code/app', n: 8 },
  { dir: '-Users-you-code-notes', cwd: '/Users/you/code/notes', n: 6 },
  { dir: '-Users-you-code', cwd: '/Users/you/code', n: 9 },
]

// Ordinary engineering, deliberately dull: the screenshots should show the
// SHAPE of a session, not amuse anyone with its content.
const PROMPTS = [
  'why does the build fail only on CI and not locally',
  'add pagination to the results endpoint',
  'the migration is slow on large tables, profile it',
  'refactor the parser to stream instead of buffering',
  'write tests for the retry path',
  'the cache key collides across tenants, find where',
  'why is the first request after deploy always slow',
  'split the config module, it does three things',
  'drop the dead feature flag and everything behind it',
  'make the error message say which field failed',
  'the worker leaks a connection per retry, find it',
  'why did the p99 double after the last deploy',
  'move the rate limiter in front of auth, not behind',
  'this test is flaky, is it the clock or the fixture',
  'add a --json flag to the export command',
  'the changelog missed two commits, check the range',
  'inline the helper, it has one caller',
  'audit which env vars are actually read at runtime',
]
const REPLIES = [
  'Reading the failing job first.',
  'Found it — the boundary is not where the comment claims.',
  'Two call sites, both wrong in the same way.',
  'Reproduced locally with the CI env vars.',
  'Narrowing to the retry wrapper.',
]
const CLOSERS = [
  'Fixed: the key was missing the tenant prefix. Tests pass.',
  'Done — streaming now, peak memory down from 1.2G to 40M.',
  'Root cause was a cold cache on first request, not the query.',
  'Split into three modules; the public surface is unchanged.',
  'Removed the flag and both dead branches. 14 tests still green.',
]
const TOOLS = [
  { name: 'Bash', input: { command: 'bun test' }, out: '113 pass, 0 fail' },
  { name: 'Bash', input: { command: 'git log --oneline -20' }, out: '20 commits' },
  { name: 'Read', input: { file_path: '/Users/you/code/app/src/parse.ts' }, out: '240 lines' },
  { name: 'Grep', input: { pattern: 'cacheKey' }, out: '7 matches in 3 files' },
  { name: 'Edit', input: { file_path: '/Users/you/code/app/src/cache.ts' }, out: 'ok' },
  { name: 'Write', input: { file_path: '/Users/you/code/app/test/retry.test.ts' }, out: 'ok' },
]
const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1']

// Six invented agents for the roster: states chosen so the panel shows its
// whole vocabulary (working / blocked / done) rather than one happy row.
const AGENTS = [
  { job: 'a1c4e2', name: 'app', state: 'working', detail: 'streaming parser, 3 files touched', tempo: 'steady', tokens: 184_000, waitingFor: null },
  { job: 'b7d9f1', name: 'api pagination', state: 'working', detail: 'writing tests for the retry path', tempo: 'fast', tokens: 96_400, waitingFor: null },
  { job: 'c2a8b3', name: 'search spike', state: 'blocked', detail: 'needs a decision on the index shape', tempo: null, tokens: 41_200, waitingFor: 'input' },
  { job: 'd5e1a7', name: 'notes sweep', state: 'done', detail: 'changelog drafted', tempo: null, tokens: 22_800, waitingFor: null },
  { job: 'e8f2c4', name: 'config split', state: 'done', detail: 'three modules, surface unchanged', tempo: null, tokens: 65_100, waitingFor: null },
  { job: 'f1b6d9', name: 'cache key audit', state: 'working', detail: 'grepping call sites', tempo: 'steady', tokens: 12_500, waitingFor: null },
]

export type DemoCorpus = {
  root: string
  projectsDir: string
  binDir: string
  claudeStub: string
  wells: number
  sessions: number
  agents: number
  /** The longest session, i.e. the one worth capturing for the block view. */
  showcaseSessionId: string
  showcaseWellDir: string
}

/**
 * The default anchor: the corpus ends here and runs three weeks back. Pinned,
 * not `new Date()`, so the corpus is byte-identical run to run and a screenshot
 * diff means the UI changed rather than the fixture rolling different numbers.
 * Pass a new anchor when the dates start reading as abandoned — on purpose,
 * and once, rather than silently on every run.
 */
export const DEFAULT_ANCHOR = '2026-08-29'

/**
 * Write a synthetic ~/.claude tree at `root`. Returns what was made, including
 * which session to point `/session/<id>` at.
 */
export async function seedDemo(root: string, opts: { anchor?: string } = {}): Promise<DemoCorpus> {
  const anchorMs = Date.parse(`${opts.anchor ?? DEFAULT_ANCHOR}T00:00:00Z`)
  if (Number.isNaN(anchorMs)) throw new Error(`demo: --anchor must be YYYY-MM-DD, got ${opts.anchor}`)
  rmSync(root, { recursive: true, force: true })
  const projectsDir = join(root, 'projects')
  const jobsDir = join(root, 'jobs')
  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })

  // A tiny LCG rather than Math.random: the corpus must be reproducible, so a
  // recapture differs only where the explorer changed.
  let state = 11
  const rnd = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648)
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))
  const pad = (n: number) => String(n).padStart(2, '0')

  const writes: Promise<unknown>[] = []
  let sessions = 0
  let showcase = { id: '', well: '', txns: -1 }
  const sessionIds: { id: string; cwd: string }[] = []

  for (const w of WELLS) {
    const dir = join(projectsDir, w.dir)
    mkdirSync(dir, { recursive: true })
    for (let s = 0; s < w.n; s++) {
      const id = `${pad(s + 1)}f3a9c${w.dir.length}-demo-${w.dir.slice(-5)}`
      // Days back from the anchor, not a fixed month: moving the anchor moves
      // the whole corpus and nothing else about it.
      const date = new Date(anchorMs - int(0, 21) * 86_400_000).toISOString().slice(0, 10)
      const model = pick(MODELS)
      const lines: string[] = []
      let clock = 9 * 3600 + int(0, 1800)
      const at = () => `${date}T${pad(Math.floor(clock / 3600))}:${pad(Math.floor((clock % 3600) / 60))}:${pad(clock % 60)}.000Z`
      const usage = (out: number) => ({
        input_tokens: 3,
        cache_creation_input_tokens: int(200, 9000),
        cache_read_input_tokens: int(8000, 90000),
        output_tokens: out,
        output_tokens_details: { thinking_tokens: Math.floor(out / 4) },
      })

      const txns = int(6, 15)
      // Sample prompts WITHOUT replacement: a session repeating the same prompt
      // verbatim two transactions apart reads as a rendering bug, not as data.
      const bag = [...PROMPTS]
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1))
        ;[bag[i], bag[j]] = [bag[j] as string, bag[i] as string]
      }

      let req = 0
      for (let t = 0; t < txns; t++) {
        const pid = `p${t + 1}`
        lines.push(JSON.stringify({ type: 'user', timestamp: at(), promptId: pid, sessionId: id, cwd: w.cwd, message: { role: 'user', content: bag[t] as string } }))
        clock += int(3, 12)

        // One request per content block, sharing message.id — the real shape.
        req++
        lines.push(JSON.stringify({
          type: 'assistant', timestamp: at(), effort: 'high', sessionId: id,
          message: { id: `msg_${s}_${t}_${req}`, model, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: pick(REPLIES) }], usage: usage(int(40, 220)) },
        }))

        for (let c = 0, calls = int(1, 3); c < calls; c++) {
          const tool = pick(TOOLS)
          const tu = `tu_${s}_${t}_${c}`
          clock += 1
          req++
          lines.push(JSON.stringify({
            type: 'assistant', timestamp: at(), effort: 'high', sessionId: id,
            message: { id: `msg_${s}_${t}_${req}`, model, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: tu, name: tool.name, input: tool.input }], usage: usage(int(60, 400)) },
          }))
          clock += int(1, 40)
          // A few failures: a session with a zero error count looks staged.
          const isError = rnd() < 0.12
          lines.push(JSON.stringify({
            type: 'user', timestamp: at(), promptId: pid, sessionId: id, sourceToolAssistantUUID: 'x',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: isError ? 'exit 1: command failed' : tool.out, is_error: isError }] },
          }))
          clock += int(2, 15)
        }

        req++
        lines.push(JSON.stringify({
          type: 'assistant', timestamp: at(), effort: 'high', sessionId: id,
          message: { id: `msg_${s}_${t}_${req}`, model, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: pick(CLOSERS) }], usage: usage(int(150, 900)) },
        }))
        clock += int(120, 2400)
      }

      writes.push(Bun.write(join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`))
      sessionIds.push({ id, cwd: w.cwd })
      if (txns > showcase.txns) showcase = { id, well: w.dir, txns }
      sessions++
    }
  }

  // The roster's two halves: per-job state.json (read from LORE_CLAUDE_DIR) and
  // the daemon listing (shelled out to, hence the stub).
  const listing = AGENTS.map((a, i) => {
    const sess = sessionIds[(i * 7) % sessionIds.length] as { id: string; cwd: string }
    const startedAt = anchorMs + (9 + i) * 3_600_000 + 12 * 60_000
    mkdirSync(join(jobsDir, a.job), { recursive: true })
    writes.push(Bun.write(join(jobsDir, a.job, 'state.json'), `${JSON.stringify({
      state: a.state, detail: a.detail, tempo: a.tempo, tokens: a.tokens, name: a.name,
      createdAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(startedAt + 3_600_000).toISOString(),
      sessionId: sess.id,
    }, null, 2)}\n`))
    return { id: a.job, cwd: sess.cwd, kind: 'bg', startedAt, sessionId: sess.id, name: a.name, state: a.state, pid: 40000 + i, status: a.state, waitingFor: a.waitingFor }
  })

  // A stub `claude` that answers only the roster call. It lives INSIDE the
  // throwaway corpus directory and is reached only by an explicit PATH prefix
  // on a single command — it never touches the caller's environment, and
  // nothing here installs or persists it. POSIX only: on Windows the other
  // three views still capture, the dashboard's roster does not.
  const claudeStub = join(binDir, 'claude')
  await Bun.write(claudeStub, `#!/bin/sh\n# Synthetic roster for demo captures (scripts/demo.ts). Not a real claude.\ncat <<'JSON'\n${JSON.stringify(listing, null, 2)}\nJSON\n`)
  chmodSync(claudeStub, 0o755)

  await Promise.all(writes)
  return {
    root, projectsDir, binDir, claudeStub,
    wells: WELLS.length, sessions, agents: AGENTS.length,
    showcaseSessionId: showcase.id, showcaseWellDir: showcase.well,
  }
}

// ------------------------------------------------------------------- the CLI

/**
 * Boot the explorer over the seeded corpus and PROVE nothing real reaches the
 * page: no real well name anywhere, and a roster made only of invented agents.
 *
 * The second half is the one that matters. The agents panel asks the live
 * daemon, not the index, so without the stub first on PATH it renders the real
 * fleet — and the corpus around it still looks perfectly synthetic. That is
 * invisible in the output unless you happen to recognise the names, which is
 * exactly the kind of thing someone regenerating in a hurry will not do. So it
 * is asserted, and a failure is fatal rather than a warning.
 */
export async function verifyNothingRealLeaks(c: DemoCorpus, home: string): Promise<string[]> {
  const entry = join(fileURLToPath(new URL('..', import.meta.url)), 'src', 'main.ts')
  const env = { ...process.env, LORE_CLAUDE_DIR: c.root, LORE_HOME: home, PATH: `${c.binDir}${delimiter}${process.env.PATH ?? ''}` }

  const idx = Bun.spawn([process.execPath, entry, 'index'], { env, stdout: 'pipe', stderr: 'pipe' })
  if ((await idx.exited) !== 0) throw new Error(`demo: index failed\n${await new Response(idx.stderr).text()}`)

  const proc = Bun.spawn([process.execPath, entry, 'serve', '--port', '0', '--host', '127.0.0.1', '--refresh', '0'], { env, stdout: 'pipe', stderr: 'pipe' })
  try {
    // The server announces its URL on stderr once it is listening.
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let base = ''
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !base) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      base = /(http:\/\/[\d.]+:\d+)\//.exec(buf)?.[1] ?? ''
    }
    if (!base) throw new Error(`demo: server never announced a URL\n${buf}`)

    const pages = await Promise.all(
      ['/', '/usage', `/well/${c.showcaseWellDir}`, `/session/${c.showcaseSessionId}`].map(async (p) => (await fetch(base + p)).text()),
    )
    const html = pages.join('\n')
    const problems: string[] = []

    // Real well names, read from the REAL projects dir rather than from env —
    // which this process has already redirected.
    const realProjects = join(homedir(), '.claude', 'projects')
    if (existsSync(realProjects)) {
      for (const real of readdirSync(realProjects)) {
        if (real.startsWith('-') && real.length > 12 && html.includes(real)) problems.push(`real well name in output: ${real}`)
      }
    }
    // And the roster must be the invented one. Absent names mean the stub was
    // not consulted, which means the panel is showing whatever is really running.
    for (const a of AGENTS) {
      if (!pages[0]?.includes(a.name)) problems.push(`agent "${a.name}" missing — the PATH stub was not used, so the roster is REAL`)
    }
    return problems
  } finally {
    proc.kill()
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (name: string) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const root = flag('--out') ?? join(tmpdir(), 'lore-demo')
  const anchor = flag('--anchor')
  const home = `${root}-home`

  rmSync(home, { recursive: true, force: true })
  const c = await seedDemo(root, { anchor })

  console.log(`seeded ${c.wells} wells, ${c.sessions} sessions, ${c.agents} agents (anchor ${anchor ?? DEFAULT_ANCHOR})`)
  console.log(`corpus: ${c.projectsDir}`)

  if (!argv.includes('--no-verify')) {
    const problems = await verifyNothingRealLeaks(c, home)
    if (problems.length) {
      console.error(`\ndemo: REFUSING — real data reached the page:\n  ${problems.join('\n  ')}`)
      process.exit(1)
    }
    console.log('verified: no real well name in any view, roster is synthetic')
  }

  const env = `LORE_CLAUDE_DIR=${c.root} LORE_HOME=${home}`
  console.log('')
  console.log('serve it (the PATH prefix is NOT optional — without it the dashboard shows your real agents):')
  console.log(`  PATH=${c.binDir}${delimiter}$PATH ${env} lore serve --port 4983 --host 127.0.0.1 --refresh 0`)
  console.log('')
  console.log('capture at 1440x900 @2x, ?theme=light and ?theme=dark for the pair:')
  console.log('  /usage')
  console.log(`  /well/${c.showcaseWellDir}`)
  console.log(`  /session/${c.showcaseSessionId}`)
  console.log('  /')
}
