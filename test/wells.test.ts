import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { deslugWellDir, isAbsolute, listWells, slugWellDir } from '../src/wells'

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

  // The well name is mangled from the cwd the harness RECORDED, and that
  // arrives NFC even when the directory on disk is decomposed. The walk reads
  // names off the filesystem, which on macOS hands back what was written —
  // NFD here — so the two sides only meet if the mangle normalizes first.
  // Measured 2026-09-02: /Users/rf-studio/cc-test/café-nfd (NFD on disk) is
  // filed as -Users-rf-studio-cc-test-caf--nfd, and before the normalize this
  // walk answered null for a directory that was sitting right there.
  test('reconstructs a source dir whose name is NFD on disk', () => {
    const root = tempDir()
    const real = join(root, 'cafe\u0301-nfd') // 'cafe' + combining acute + '-nfd'
    mkdirSync(real, { recursive: true })
    const onDisk = readdirSync(root)[0] ?? ''
    // Some filesystems compose on create; there is nothing to test if this
    // one did, and asserting anyway would pass for the wrong reason.
    if (onDisk === onDisk.normalize('NFC')) return
    expect(deslugWellDir(mangle(real.normalize('NFC')))).toBe(real)
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

// The forward map measured against wells the harness actually created, rather
// than against this file's own copy of the rule — `mangle` above and
// `slugWellDir` agreeing proves only that they were written by the same hand.
//
// Each row's cwd comes from a transcript RECORD, never reverse-derived from
// the well name, and never selected by whether it encodes correctly (both
// would guarantee a green test over an untested rule). `strict` rows come
// from a session whose every record carries one cwd — it never moved, so that
// cwd is unambiguously the shard key. The rest only promise that SOME cwd
// they saw encodes to the well: a per-record cwd is the session's current
// directory, so sessions that cd into a subdirectory, and worktree entry
// dragging pre-entry records along, both put foreign cwds in a well.
//
// The committed fixture is a curated subset — the full corpus names every
// repo this machine has worked in. It keeps the three probe wells minted to
// settle the character rule (2026-09-02, CLI 2.1.258): '_', ' ', '~', '+',
// '@' collapse like '/' and '.'; non-ASCII collapses at one dash per NFC
// character (日本語 -> ---, not nine dashes).
const CorpusRow = z.object({
  well: z.string(),
  cwd: z.string(),
  strict: z.boolean(),
  cwds: z.array(z.string()),
})
const CorpusHeader = z.object({ wells: z.number(), strictWells: z.number() })

function readCorpus(path: string) {
  const [head, ...rest] = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
  return {
    header: CorpusHeader.parse(JSON.parse(head ?? '')),
    rows: rest.map((line) => CorpusRow.parse(JSON.parse(line))),
  }
}

function checkCorpus(rows: z.infer<typeof CorpusRow>[]) {
  let strict = 0
  for (const row of rows) {
    if (row.strict) {
      expect(slugWellDir(row.cwd)).toBe(row.well)
      strict++
    } else {
      expect(row.cwds.some((cwd) => slugWellDir(cwd) === row.well)).toBe(true)
    }
  }
  return strict
}

describe('slugWellDir against real wells', () => {
  const fixture = join(import.meta.dir, 'fixtures', 'wells-corpus.jsonl')

  test('every well in the committed corpus encodes to its own directory name', () => {
    const { header, rows } = readCorpus(fixture)
    expect(rows).toHaveLength(header.wells)
    expect(checkCorpus(rows)).toBe(header.strictWells)
  })

  test('the probe wells pin the character rule directly', () => {
    // Minted for this: ~/cc-test/probe_a b/c~d+e@f and the two Unicode ones.
    expect(slugWellDir('/Users/rf-studio/cc-test/probe_a b/c~d+e@f')).toBe(
      '-Users-rf-studio-cc-test-probe-a-b-c-d-e-f',
    )
    expect(slugWellDir('/x/日本語dir')).toBe('-x----dir')
    // NFD and NFC of the same name are one well: the rule is per NFC
    // character, and only the harness's own record settles which. Before the
    // normalize, the decomposed form kept its ASCII 'e' and answered
    // '-x-cafe--nfd' — a different well for the same directory.
    expect(slugWellDir('/x/cafe\u0301-nfd')).toBe('-x-caf--nfd')
    expect(slugWellDir('/x/caf\u00e9-nfd')).toBe('-x-caf--nfd')
  })

  // Breadth when the machine has it: 90 wells at the time of writing, against
  // 8 committed. Asserts the rule only — never a count — so regenerating the
  // corpus can never break this, and its absence is not a failure.
  const local = join(homedir(), '.lore', 'wells-corpus.jsonl')
  test.if(existsSync(local))('the full local corpus agrees', () => {
    const { rows } = readCorpus(local)
    expect(rows.length).toBeGreaterThan(0)
    checkCorpus(rows)
  })
})
