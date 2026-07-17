import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { indexDocs, listIndexedRepos, listRepoPaths, scanRepo, searchDocs } from '../src/docs'

function sh(cwd: string, cmd: string, date?: string): string {
  const env = date
    ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    : process.env
  return execSync(cmd, { cwd, encoding: 'utf8', env }).trim()
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  sh(dir, 'git init -q && git config user.email t@t && git config user.name t')
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'lore-docs-test-'))
}

function memDb(): Database {
  return openDb(join(tempDir(), 'test.db'))
}

// A normal repo: committed canon plus an uncommitted decoy that must not index.
function canonRepo(root: string, name: string): string {
  const dir = join(root, name)
  initRepo(dir)
  writeFileSync(join(dir, 'CLAUDE.md'), `# ${name}\nAlways use sparkle notarization here.\n`)
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs', 'design.md'), 'The frobnicator pattern lives here.\n')
  writeFileSync(join(dir, 'main.ts'), 'export {}\n')
  sh(dir, 'git add -A && git commit -qm canon', '2026-07-01T10:00:00')
  writeFileSync(join(dir, 'UNCOMMITTED.md'), 'not canon yet\n')
  return dir
}

// gym's topology: origin/master carries the docs, the local clone sits on the
// empty root commit with a bare working tree — canon exists only in git objects.
function huskRepo(root: string): string {
  const origin = join(root, 'husk-origin')
  initRepo(origin)
  sh(origin, 'git commit -q --allow-empty -m root', '2026-07-01T09:00:00')
  const rootSha = sh(origin, 'git rev-parse HEAD')
  writeFileSync(join(origin, 'README.md'), 'The llm coach speaks only real exercise ids.\n')
  sh(origin, 'git add -A && git commit -qm docs', '2026-07-01T22:00:00')
  const dir = join(root, 'husk')
  sh(root, `git clone -q ${origin} husk`)
  sh(dir, `git reset -q --hard ${rootSha}`)
  rmSync(origin, { recursive: true })
  return dir
}

describe('listRepoPaths', () => {
  test('finds nested repos, skips hidden dirs and node_modules, honors exclude', () => {
    const root = tempDir()
    canonRepo(root, join('group', 'alpha'))
    canonRepo(root, 'beta')
    const excluded = canonRepo(root, 'wiki')
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    initRepo(join(root, 'node_modules', 'pkg'))
    mkdirSync(join(root, '.hidden'))
    initRepo(join(root, '.hidden'))
    const paths = listRepoPaths(root, { exclude: [excluded] })
    expect(paths).toEqual([join(root, 'beta'), join(root, 'group', 'alpha')])
  })

  test('does not descend into a repo (worktrees never scan separately)', () => {
    const root = tempDir()
    const repo = canonRepo(root, 'outer')
    mkdirSync(join(repo, 'sub'))
    initRepo(join(repo, 'sub'))
    expect(listRepoPaths(root)).toEqual([repo])
  })
})

describe('scanRepo', () => {
  test('reads committed .md from HEAD, ignores uncommitted and non-md', async () => {
    const root = tempDir()
    const repo = canonRepo(root, 'a')
    const scan = await scanRepo(repo)
    expect(scan).not.toBeNull()
    expect(scan?.ref).toBe('HEAD')
    expect(scan?.isHusk).toBe(false)
    expect(scan?.files.map((f) => f.path).sort()).toEqual(['CLAUDE.md', 'docs/design.md'])
  })

  test('husk repo: picks the newer remote ref and flags it', async () => {
    const root = tempDir()
    const repo = huskRepo(root)
    const scan = await scanRepo(repo)
    expect(scan).not.toBeNull()
    expect(scan?.ref).toStartWith('origin/')
    expect(scan?.isHusk).toBe(true)
    expect(scan?.files.map((f) => f.path)).toEqual(['README.md'])
  })

  test('repo with no commits returns null', async () => {
    const root = tempDir()
    const dir = join(root, 'empty')
    initRepo(dir)
    expect(await scanRepo(dir)).toBeNull()
  })
})

describe('indexDocs', () => {
  test('indexes, searches, skips incrementally, reindexes on new commit, prunes gone repos', async () => {
    const root = tempDir()
    const repo = canonRepo(root, 'a')
    huskRepo(root)
    const db = memDb()

    const first = await indexDocs(db, { codeDir: root })
    expect(first.reposIndexed).toBe(2)
    expect(first.docs).toBe(3)

    // Canon from both species is searchable; the husk hit carries its flag.
    const sparkle = searchDocs(db, 'sparkle', { limit: 10 })
    expect(sparkle).toHaveLength(1)
    expect(sparkle[0]?.path).toBe('CLAUDE.md')
    const coach = searchDocs(db, 'coach', { limit: 10 })
    expect(coach).toHaveLength(1)
    expect(coach[0]?.isHusk).toBe(true)
    expect(searchDocs(db, 'UNCOMMITTED', { limit: 10 })).toHaveLength(0)

    // Unchanged shas skip; a new commit reindexes just that repo.
    const second = await indexDocs(db, { codeDir: root })
    expect(second.reposIndexed).toBe(0)
    expect(second.reposSkipped).toBe(2)
    writeFileSync(join(repo, 'docs', 'new.md'), 'A fresh canon page about zorbs.\n')
    sh(repo, 'git add docs/new.md && git commit -qm more', '2026-07-02T10:00:00')
    const third = await indexDocs(db, { codeDir: root })
    expect(third.reposIndexed).toBe(1)
    expect(searchDocs(db, 'zorbs', { limit: 10 })).toHaveLength(1)

    const repos = listIndexedRepos(db)
    expect(repos).toHaveLength(2)
    expect(repos.find((r) => r.path === repo)?.docs).toBe(3)
    expect(repos.find((r) => r.path !== repo)?.isHusk).toBe(true)

    // A deleted repo is pruned — canon lives in git, not in the index.
    rmSync(repo, { recursive: true })
    const fourth = await indexDocs(db, { codeDir: root })
    expect(fourth.reposPruned).toBe(1)
    expect(searchDocs(db, 'zorbs', { limit: 10 })).toHaveLength(0)
    expect(listIndexedRepos(db)).toHaveLength(1)
  })

  test('repo filter narrows search', async () => {
    const root = tempDir()
    canonRepo(root, 'one')
    canonRepo(root, 'two')
    const db = memDb()
    await indexDocs(db, { codeDir: root })
    expect(searchDocs(db, 'frobnicator', { limit: 10 })).toHaveLength(2)
    expect(searchDocs(db, 'frobnicator', { repo: 'two', limit: 10 })).toHaveLength(1)
  })
})
