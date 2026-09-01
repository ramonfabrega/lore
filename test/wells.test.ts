import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deslugWellDir, listWells } from '../src/wells'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'lore-wells-test-'))
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
