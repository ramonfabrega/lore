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

// The husk topology: origin/master carries the docs, the local clone sits on the
// empty root commit with a bare working tree — canon exists only in git objects.
function huskRepo(root: string): string {
  const origin = join(root, 'husk-origin')
  initRepo(origin)
  sh(origin, 'git commit -q --allow-empty -m root', '2026-07-01T09:00:00')
  const rootSha = sh(origin, 'git rev-parse HEAD')
  writeFileSync(join(origin, 'README.md'), 'The onboarding coach guide lives only at origin.\n')
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

  test('exclude suffixes are /-bounded — tools/cli does not catch tools/cli-repro', () => {
    const root = tempDir()
    canonRepo(root, join('tools', 'cli'))
    const repro = canonRepo(root, join('tools', 'cli-repro'))
    expect(listRepoPaths(root, { exclude: ['tools/cli'] })).toEqual([repro])
  })

  test('does not descend into a repo (worktrees never scan separately)', () => {
    const root = tempDir()
    const repo = canonRepo(root, 'outer')
    mkdirSync(join(repo, 'sub'))
    initRepo(join(repo, 'sub'))
    expect(listRepoPaths(root)).toEqual([repo])
  })

  // The linked-worktree case: a worktree checkout beside its main repo shares
  // gitdir/remote/canon — listing it double-counts the project.
  test('a top-level linked worktree checkout is not a repo', () => {
    const root = tempDir()
    const repo = canonRepo(root, 'main-repo')
    sh(repo, `git worktree add -q ${join(root, 'side-checkout')} -b spike`)
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

  test('fork with an upstream remote is foreign — canon is not ours, docs skipped', async () => {
    const root = tempDir()
    const repo = canonRepo(root, 'fork')
    sh(repo, 'git remote add upstream https://example.com/them/theirs.git')
    const scan = await scanRepo(repo)
    expect(scan?.ownership).toBe('foreign')
    expect(scan?.files).toEqual([])
  })

  test('zero commits under the user identity means assisted; any commit means mine', async () => {
    const root = tempDir()
    const theirs = join(root, 'theirs')
    initRepo(theirs)
    writeFileSync(join(theirs, 'CLAUDE.md'), 'their doctrine, not ours\n')
    sh(theirs, 'git add -A && git -c user.email=junior@x -c user.name=junior commit -qm theirs')
    expect((await scanRepo(theirs))?.ownership).toBe('assisted')
    // One commit of ours flips it — tiny share, still mine.
    writeFileSync(join(theirs, 'fix.md'), 'our one fix\n')
    sh(theirs, 'git add -A && git commit -qm fix')
    expect((await scanRepo(theirs))?.ownership).toBe('mine')
  })

  test('assisted override forces the flag regardless of authorship', async () => {
    const root = tempDir()
    const repo = canonRepo(root, 'helped')
    const scan = await scanRepo(repo, { assisted: ['helped'] })
    expect(scan?.ownership).toBe('assisted')
    expect(scan?.files.length).toBe(2)
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

  test('foreign repo is listed with its flag but contributes no docs; flag flip reindexes', async () => {
    const root = tempDir()
    const repo = canonRepo(root, 'fork')
    sh(repo, 'git remote add upstream https://example.com/them/theirs.git')
    const db = memDb()

    const first = await indexDocs(db, { codeDir: root })
    expect(first.reposIndexed).toBe(1)
    expect(first.docs).toBe(0)
    const row = listIndexedRepos(db)[0]
    expect(row?.ownership).toBe('foreign')
    expect(row?.docs).toBe(0)
    expect(searchDocs(db, 'frobnicator', { limit: 10 })).toHaveLength(0)

    // Removing the upstream remote flips the flag and indexes docs, even
    // though the commit sha never changed.
    sh(repo, 'git remote remove upstream')
    const second = await indexDocs(db, { codeDir: root })
    expect(second.reposIndexed).toBe(1)
    expect(second.docs).toBe(2)
    expect(listIndexedRepos(db)[0]?.ownership).toBe('mine')
    expect(searchDocs(db, 'frobnicator', { limit: 10 })).toHaveLength(1)
  })

  test('assisted repo docs are indexed and every hit carries the flag', async () => {
    const root = tempDir()
    const theirs = join(root, 'theirs')
    initRepo(theirs)
    writeFileSync(join(theirs, 'CLAUDE.md'), 'the wombat convention is law here\n')
    sh(theirs, 'git add -A && git -c user.email=junior@x -c user.name=junior commit -qm theirs')
    const db = memDb()

    const stats = await indexDocs(db, { codeDir: root })
    expect(stats.docs).toBe(1)
    expect(listIndexedRepos(db)[0]?.ownership).toBe('assisted')
    const hits = searchDocs(db, 'wombat', { limit: 10 })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.ownership).toBe('assisted')
  })

  test('hyphenated and apostrophe queries fall back to literal match instead of erroring', async () => {
    const root = tempDir()
    const repo = join(root, 'r')
    initRepo(repo)
    writeFileSync(join(repo, 'CLAUDE.md'), "the three-tier model; refute-don't-confirm applies\n")
    sh(repo, 'git add -A && git commit -qm canon')
    const db = memDb()
    await indexDocs(db, { codeDir: root })
    expect(searchDocs(db, 'three-tier', { limit: 5 })).toHaveLength(1)
    expect(searchDocs(db, "refute-don't-confirm", { limit: 5 })).toHaveLength(1)
    expect(searchDocs(db, 'absent-term', { limit: 5 })).toHaveLength(0)
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

  // The stale-fetch gap: canon merged upstream after the last local fetch is
  // invisible to every re-index — the ref-diff runs against refs that never
  // moved. fetch: true is the cure; without it the stale result must persist.
  test('upstream canon is invisible until fetch moves the origin refs', async () => {
    const root = tempDir()
    const origin = join(root, 'up-origin')
    initRepo(origin)
    writeFileSync(join(origin, 'README.md'), 'v1 canon\n')
    sh(origin, 'git add -A && git commit -qm v1', '2026-07-01T10:00:00')
    sh(root, 'git clone -q up-origin up')
    writeFileSync(join(origin, 'DOCTRINE.md'), 'The zanzibar doctrine lands upstream.\n')
    sh(origin, 'git add -A && git commit -qm v2', '2026-07-02T10:00:00')

    const db = memDb()
    const stale = await indexDocs(db, { codeDir: root, exclude: ['up-origin'] })
    expect(stale.reposFetched).toBeUndefined()
    expect(searchDocs(db, 'zanzibar', { limit: 5 })).toHaveLength(0)

    const fresh = await indexDocs(db, { codeDir: root, exclude: ['up-origin'], fetch: true })
    expect(fresh.reposFetched).toBe(1)
    expect(fresh.reposIndexed).toBe(1)
    const hits = searchDocs(db, 'zanzibar', { limit: 5 })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.ref).toStartWith('origin/')
  })
})
