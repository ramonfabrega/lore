#!/usr/bin/env bun
// Does the explorer actually bind a socket and answer, on this platform?
//
// The unit tests exercise the request handler directly (composeHandler), which
// proves the pages render but never opens a port. This boots `lore serve` as a
// real child process, fetches the pages a person would open, and checks the
// JSON lane too. It is the difference between "the dashboard should work on
// Windows" and knowing it does.
//
// Port 0: the OS picks a free one and the server prints where it landed, so
// this never collides with a lore already serving on 4949.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not .pathname — the latter yields '/C:/Users/...' on Windows.
const entry = join(fileURLToPath(new URL('..', import.meta.url)), 'src', 'main.ts')

// A throwaway LORE_HOME: a fresh machine has no index, and the explorer must
// come up against an empty database rather than needing one seeded first.
const home = mkdtempSync(join(tmpdir(), 'lore-smoke-'))

const proc = Bun.spawn([process.execPath, entry, 'serve', '--port', '0', '--host', '127.0.0.1', '--refresh', '0'], {
  env: { ...process.env, LORE_HOME: home },
  stdout: 'pipe',
  stderr: 'pipe',
})

// The annotation is on the const, not just the arrow: TS narrows a call to
// `never` only when the variable itself is typed that way.
const fail: (msg: string) => never = (msg: string) => {
  proc.kill()
  console.error(`smoke-serve: ${msg}`)
  process.exit(1)
}

// The server announces its URL on stderr as soon as it is listening.
async function waitForUrl(timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  const reader = proc.stderr.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const m = /(http:\/\/[\d.]+:\d+)\//.exec(buf)
    if (m?.[1]) return m[1]
  }
  fail(`server never announced a URL in ${timeoutMs}ms. stderr:\n${buf}`)
}

const base = await waitForUrl(30_000)
console.error(`smoke-serve: listening on ${base}`)

// One representative of each kind: an HTML page, the same page as JSON, and
// the /cli/ agent surface.
const checks: { path: string; expect: (body: string, res: Response) => boolean; what: string }[] = [
  { path: '/', what: 'the wells page renders HTML', expect: (b) => b.includes('<html') || b.includes('<!doctype') || b.includes('<body') },
  { path: '/?json=1', what: 'the same page answers JSON', expect: (b, r) => (r.headers.get('content-type') ?? '').includes('json') && b.trimStart().startsWith('{') },
  { path: '/usage', what: '/usage renders', expect: (b) => b.length > 0 },
  { path: '/cli/openapi.json', what: 'the /cli/ spec is served', expect: (b) => b.includes('openapi') || b.includes('paths') },
]

let failed = 0
for (const c of checks) {
  let res: Response
  try {
    res = await fetch(`${base}${c.path}`)
  } catch (e) {
    console.error(`  FAIL ${c.path} — ${e instanceof Error ? e.message : String(e)}`)
    failed++
    continue
  }
  const body = await res.text()
  const ok = res.status === 200 && c.expect(body, res)
  console.error(`  ${ok ? 'ok  ' : 'FAIL'} ${c.path} [${res.status}] — ${c.what}`)
  if (!ok) failed++
}

proc.kill()
await proc.exited
rmSync(home, { recursive: true, force: true })

if (failed > 0) {
  console.error(`smoke-serve: ${failed} check(s) failed`)
  process.exit(1)
}
console.error('smoke-serve: the explorer serves here')
