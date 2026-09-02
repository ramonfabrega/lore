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
import pkg from '../package.json'

const root = new URL('..', import.meta.url).pathname
const compile = Bun.argv.includes('--compile')
$.cwd(root)

const fail = (msg: string): never => {
  console.error(msg)
  process.exit(1)
}

if ((await $`git status --porcelain`.text()).trim())
  fail('refusing: dirty tree — the installed bin must be a reproducible, landed artifact')

await $`bun install --frozen-lockfile`.quiet()

console.error('gate: bun test')
const tests = await $`bun test`.quiet().nothrow()
if (tests.exitCode !== 0) {
  process.stderr.write(tests.stdout)
  process.stderr.write(tests.stderr)
  process.exit(tests.exitCode)
}

const build = (await $`git rev-list --count HEAD`.text()).trim()
const sha = (await $`git rev-parse --short HEAD`.text()).trim()
const info = `v${pkg.version} b${build} @ ${sha}${compile ? ' (compiled)' : ''}`

const dist = join(homedir(), '.lore', 'dist')
const bin = join(homedir(), '.bun', 'bin', 'lore')
mkdirSync(dist, { recursive: true })
mkdirSync(join(homedir(), '.bun', 'bin'), { recursive: true })

const out = await Bun.build({
  entrypoints: [join(root, 'src', 'main.ts')],
  target: 'bun',
  minify: true,
  define: { LORE_BUILD_INFO: JSON.stringify(info) },
  throw: false,
  ...(compile ? { bytecode: true, compile: { outfile: join(dist, 'lore') } } : {}),
})
if (!out.success) {
  for (const log of out.logs) console.error(String(log))
  fail('build failed')
}

if (compile) {
  rmSync(bin, { force: true })
  symlinkSync(join(dist, 'lore'), bin)
} else {
  const bundle = out.outputs.find((a) => a.kind === 'entry-point') ?? fail('build produced no entry-point')
  const js = join(dist, 'lore.js')
  await Bun.write(js, bundle)
  await Bun.write(bin, `#!/bin/sh\nexec bun "${js}" "$@"\n`)
  chmodSync(bin, 0o755)
}
console.error(`installed: lore ${info} -> ${bin}`)
