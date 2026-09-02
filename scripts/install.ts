#!/usr/bin/env bun
// Install the blessed `lore` bin: a frozen artifact built from a CLEAN tree at
// the landed ref. Subagents and sessions use this by default; dev runs invoke
// `bun <checkout>/src/main.ts` by explicit absolute path instead. Gates on
// tests — a bad commit reaches nobody, a bad installed bin reaches every well.
//
// Usage: scripts/install.ts [--compile]
//   default:   single-file JS bundle (~KBs) + shim  -> ~/.bun/bin/lore
//   --compile: standalone executable (embeds Bun runtime, bytecode startup)
import { $ } from 'bun'
import { chmodSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json'

// fileURLToPath, not .pathname: on Windows the latter yields '/C:/Users/...',
// which is not a path anything can open.
const root = fileURLToPath(new URL('..', import.meta.url))
const compile = Bun.argv.includes('--compile')
const windows = process.platform === 'win32'
$.cwd(root)

const fail = (msg: string): never => {
  console.error(msg)
  process.exit(1)
}

if ((await $`git status --porcelain`.text()).trim())
  fail('refusing: dirty tree — the installed bin must be a reproducible, landed artifact')

await $`bun install --frozen-lockfile`.quiet()

// TZ pinned: `bun test` forces the JS side to UTC but leaves SQLite's
// `localtime` on the OS zone, and the day-bucket tests hold the two to each
// other (CLAUDE.md, "an instant is UTC, a day is local").
console.error('gate: bun test')
const tests = await $`bun test`.env({ ...process.env, TZ: 'UTC' }).quiet().nothrow()
if (tests.exitCode !== 0) {
  process.stderr.write(tests.stdout)
  process.stderr.write(tests.stderr)
  process.exit(tests.exitCode)
}

const build = (await $`git rev-list --count HEAD`.text()).trim()
const sha = (await $`git rev-parse --short HEAD`.text()).trim()
const info = `v${pkg.version} b${build} @ ${sha}${compile ? ' (compiled)' : ''}`

const dist = join(homedir(), '.lore', 'dist')
// Windows has no shebang and no exec bit: the thing on PATH must be a .cmd
// (~/.bun/bin is already on PATH there, same as POSIX).
const bin = join(homedir(), '.bun', 'bin', windows ? 'lore.cmd' : 'lore')
const exe = join(dist, windows ? 'lore.exe' : 'lore')
mkdirSync(dist, { recursive: true })
mkdirSync(join(homedir(), '.bun', 'bin'), { recursive: true })

const out = await Bun.build({
  entrypoints: [join(root, 'src', 'main.ts')],
  target: 'bun',
  minify: true,
  define: { LORE_BUILD_INFO: JSON.stringify(info) },
  throw: false,
  ...(compile ? { bytecode: true, compile: { outfile: exe } } : {}),
})
if (!out.success) {
  for (const log of out.logs) console.error(String(log))
  fail('build failed')
}

// A .cmd shim rather than a copy of the artifact: `exit /b` propagates the
// exit code, which a bare invocation at the end of a batch file does not
// reliably do. symlinkSync is avoided on Windows — it needs a privilege
// unelevated processes don't have.
const cmdShim = (target: string, viaBun: boolean) => `@echo off\r\n${viaBun ? 'bun ' : ''}"${target}" %*\r\nexit /b %ERRORLEVEL%\r\n`

if (compile) {
  rmSync(bin, { force: true })
  if (windows) await Bun.write(bin, cmdShim(exe, false))
  else symlinkSync(exe, bin)
} else {
  const bundle = out.outputs.find((a) => a.kind === 'entry-point') ?? fail('build produced no entry-point')
  const js = join(dist, 'lore.js')
  await Bun.write(js, bundle)
  if (windows) await Bun.write(bin, cmdShim(js, true))
  else {
    await Bun.write(bin, `#!/bin/sh\nexec bun "${js}" "$@"\n`)
    chmodSync(bin, 0o755)
  }
}
console.error(`installed: lore ${info} -> ${bin}`)
