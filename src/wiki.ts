import { $ } from 'bun'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
// The wiki template ships inside the bin: text imports are inlined by the
// bundler, so `docs/wiki-template/` is the single source and the installed
// `lore` needs no checkout to lay it down.
import templateClaudeMd from '../docs/wiki-template/CLAUDE.md' with { type: 'text' }
import templateIndex from '../docs/wiki-template/index.md' with { type: 'text' }
import templateLog from '../docs/wiki-template/log.md' with { type: 'text' }

export type WikiCommitResult = {
  committed: boolean
  sha: string | null
  files: string[]
}

export type WikiInitResult = {
  dir: string
  files: string[]
  sha: string
}

async function git(wikiDir: string, ...args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await $`git -C ${wikiDir} ${args}`.quiet().nothrow()
  return { ok: r.exitCode === 0, out: r.text().trim() }
}

// The passage model: a wiki mutation isn't durable until committed, and the
// commit is the tool's job — not the harness's, so it holds under any driver
// (interactive session, subagent, `claude -p`). No-op when the tree is clean.
export async function wikiCommit(wikiDir: string, message?: string): Promise<WikiCommitResult> {
  const status = await git(wikiDir, 'status', '--porcelain')
  if (!status.ok) throw new Error(`not a git repo: ${wikiDir} (run \`lore wiki init\` to create one)`)
  if (!status.out) return { committed: false, sha: null, files: [] }
  await git(wikiDir, 'add', '-A')
  const files = (await git(wikiDir, 'diff', '--cached', '--name-only')).out.split('\n').filter(Boolean)
  const msg = message ?? `auto: ${files.slice(0, 5).join(' ')}`
  const commit = await git(wikiDir, 'commit', '-q', '-m', msg)
  if (!commit.ok) throw new Error(`git commit failed in ${wikiDir}`)
  return { committed: true, sha: (await git(wikiDir, 'rev-parse', '--short', 'HEAD')).out, files }
}

export const WIKI_TEMPLATE: Record<string, string> = {
  'CLAUDE.md': templateClaudeMd,
  'index.md': templateIndex,
  'log.md': templateLog,
  'projects/.gitkeep': '',
  'patterns/.gitkeep': '',
}

// Lay down a fresh wiki from the template and make its first commit. Refuses
// a non-empty directory: the template is a starting point, never an overwrite
// of a wiki that has begun to compound.
export async function wikiInit(wikiDir: string): Promise<WikiInitResult> {
  if (existsSync(wikiDir) && readdirSync(wikiDir).length > 0) {
    throw new Error(`refusing to init a non-empty directory: ${wikiDir}`)
  }
  mkdirSync(wikiDir, { recursive: true })
  const files = Object.keys(WIKI_TEMPLATE)
  for (const rel of files) {
    const p = join(wikiDir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    await Bun.write(p, WIKI_TEMPLATE[rel]!)
  }
  const init = await git(wikiDir, 'init', '-q')
  if (!init.ok) throw new Error(`git init failed in ${wikiDir}`)
  await git(wikiDir, 'add', '-A')
  // Identity from the user's git config when present; a fallback so init
  // works on a machine that has never committed (the first thing a stranger
  // runs), without writing config anywhere.
  const commit = await git(
    wikiDir,
    '-c',
    'user.name=lore',
    '-c',
    'user.email=lore@localhost',
    'commit',
    '-q',
    '-m',
    'lore wiki init: the schema, the map, the log',
  )
  if (!commit.ok) throw new Error(`initial commit failed in ${wikiDir}`)
  return { dir: wikiDir, files, sha: (await git(wikiDir, 'rev-parse', '--short', 'HEAD')).out }
}
