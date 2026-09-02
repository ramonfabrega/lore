import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deslugWellDir, isAbsolute, listWells } from '../src/wells'

// Canonicalize the root before mangling it, or the fixture describes a path
// that isn't what readdir reports. Two hosts need it: macOS symlinks
// /var -> /private/var, and Windows CI runners hand out 8.3 short names
// (C:\Users\RUNNER~1\... for \runneradmin\).
//
// It must be realpathSync.NATIVE — plain realpathSync resolves the symlink
// but leaves the 8.3 alias intact, and the walk matches against the long
// name readdir actually returns.
function tempDir(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'lore-wells-test-')))
}

// Claude Code's project-dir mangling: every non-alphanumeric becomes '-'.
function mangle(path: string): string {
  return path.replaceAll(/[^a-zA-Z0-9]/g, '-')
}

describe('deslugWellDir', () => {
  test('reconstructs a path whose components contain literal hyphens', () => {
    const root = tempDir()
    const real = join(root, 'code', 'fun', 'my-app')
    mkdirSync(real, { recursive: true })
    expect(deslugWellDir(mangle(real))).toBe(real)
  })

  test('reconstructs dot-dirs (worktree wells: /.claude/ mangles to --claude-)', () => {
    const root = tempDir()
    const real = join(root, 'lore', '.claude', 'worktrees', 'scaffold')
    mkdirSync(real, { recursive: true })
    expect(deslugWellDir(mangle(real))).toBe(real)
  })

  test('a deleted source still resolves null', () => {
    const root = tempDir()
    expect(deslugWellDir(mangle(join(root, 'gone', 'repo')))).toBeNull()
  })

  test('non-mangled names resolve null', () => {
    expect(deslugWellDir('not-a-well-name')).toBeNull()
  })

  // A Windows well starts at a drive letter: 'C:\\Users\\x' -> 'C--Users-x'.
  // The reconstruct case only has teeth on a Windows runner (that is what the
  // CI matrix is for); everywhere else it asserts the same null a deleted
  // source gives, never a false positive from a bogus root.
  test('a drive-letter well reconstructs on Windows, resolves null elsewhere', () => {
    const root = tempDir()
    const real = join(root, 'code', 'my-app')
    mkdirSync(real, { recursive: true })
    const slug = mangle(real)
    if (process.platform === 'win32') {
      expect(slug).toMatch(/^[A-Za-z]--/)
      expect(deslugWellDir(slug)).toBe(real)
    } else {
      expect(deslugWellDir('C--Users-nobody-code-my-app')).toBeNull()
    }
  })

  test('a drive-letter root that does not exist resolves null, not a partial path', () => {
    expect(deslugWellDir('Q--definitely-not-here-at-all')).toBeNull()
  })
})

describe('isAbsolute', () => {
  // Host-independent by design: an archive copied off a Windows box must
  // still resolve its recorded cwds when read on macOS, and vice versa.
  test('accepts both shapes regardless of platform', () => {
    for (const p of ['/Users/x/code', 'C:\\Users\\x\\code', 'c:/Users/x', '\\\\server\\share'])
      expect(isAbsolute(p)).toBe(true)
    for (const p of ['code/lore', './rel', '', 'C:', 'CC:\\x']) expect(isAbsolute(p)).toBe(false)
  })
})

describe('listWells realPath fallback', () => {
  test('memory-only well resolves realPath from its dir name; cwd still wins when present', async () => {
    const projects = tempDir()
    const src = tempDir()

    // The memory-only case: live source dir, memory dir, zero transcripts.
    const zineSrc = join(src, 'fun', 'zine')
    mkdirSync(zineSrc, { recursive: true })
    const zineWell = join(projects, mangle(zineSrc))
    mkdirSync(join(zineWell, 'memory'), { recursive: true })

    // A well with a transcript: cwd is ground truth even if it disagrees
    // with the dir name (mid-session worktree entry, respawns).
    const cwdSrc = join(src, 'fun', 'other')
    mkdirSync(cwdSrc, { recursive: true })
    const cwdWell = join(projects, mangle(join(src, 'fun', 'stale-name')))
    mkdirSync(cwdWell, { recursive: true })
    writeFileSync(join(cwdWell, 'a.jsonl'), `${JSON.stringify({ cwd: cwdSrc })}\n`)

    // A deleted source: no fallback, stays null.
    const goneWell = join(projects, mangle(join(src, 'fun', 'gone')))
    mkdirSync(join(goneWell, 'memory'), { recursive: true })

    const wells = await listWells(projects)
    const byDir = new Map(wells.map((w) => [w.dir, w]))
    expect(byDir.get(mangle(zineSrc))?.realPath).toBe(zineSrc)
    expect(byDir.get(mangle(zineSrc))?.hasMemory).toBe(true)
    expect(byDir.get(mangle(join(src, 'fun', 'stale-name')))?.realPath).toBe(cwdSrc)
    expect(byDir.get(mangle(join(src, 'fun', 'gone')))?.realPath).toBeNull()
  })
})
