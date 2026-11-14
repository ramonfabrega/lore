import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export type SessionFile = { sessionId: string; path: string; size: number; mtimeMs: number }

export type Well = {
  dir: string // dash-mangled well name (may start with '-': always join to absolute paths)
  path: string
  realPath: string | null // resolved from record cwd — dir names are lossy ('-' is both separator and hyphen)
  isWorktree: boolean
  hasMemory: boolean
  sessions: SessionFile[]
}

export async function listWells(projectsDir: string): Promise<Well[]> {
  if (!existsSync(projectsDir)) return []
  const wells: Well[] = []
  for (const name of readdirSync(projectsDir)) {
    const path = join(projectsDir, name)
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const sessions: SessionFile[] = []
    for (const f of readdirSync(path)) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(path, f)
      // A transcript can vanish between the readdir and the stat: worktree
      // entry MOVES the file to another well (CLAUDE.md), and that races a
      // running index. Unguarded, one ENOENT aborted the whole scan
      // (2026-11-14 review); the next index finds the file where it landed.
      let fst
      try {
        fst = statSync(p)
      } catch {
        continue
      }
      sessions.push({ sessionId: f.slice(0, -'.jsonl'.length), path: p, size: fst.size, mtimeMs: fst.mtimeMs })
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
    wells.push({
      dir: name,
      path,
      realPath: (await resolveRealPath(name, sessions)) ?? deslugWellDir(name),
      // Detects wells born in Claude Code's own worktree home
      // (<repo>/.claude/worktrees/, where EnterWorktree puts them) — worktrees
      // added elsewhere by hand read as regular wells.
      isWorktree: name.includes('--claude-worktrees-'),
      hasMemory: existsSync(join(path, 'memory')),
      sessions,
    })
  }
  wells.sort((a, b) => a.dir.localeCompare(b.dir))
  return wells
}

// The forward map: an absolute path to the well dir the harness would shard
// it into. Every non-alphanumeric becomes '-', one dash per NFC character —
// measured 2026-09-02 against three wells minted for the question (CLI
// 2.1.258): '_', ' ', '~', '+' and '@' collapse exactly like '/' and '.', and
// so do non-ASCII letters, at one dash each ('日本語' -> '---', not one per
// UTF-8 byte). Lossy in the other direction, which is what deslugWellDir
// below exists to undo — so a caller that slugs a path must VERIFY the result
// exists before trusting it.
//
// The normalize is load-bearing, not hygiene. The harness mangles the cwd it
// RECORDED, and that arrives NFC; but names read off a filesystem come back
// however they were written, and macOS writes NFD freely. Without this,
// slugging a readdir entry for 'café' yielded '-caf' + 'e' + '--' while the
// well was '-caf--', so deslugWellDir walked past the directory it was
// standing in and answered null — a live well reported as a deleted source.
export function slugWellDir(path: string): string {
  return path.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-')
}

// A memory-only well (a live repo with memory but zero transcripts) has no
// cwd record to resolve, and the dir name is lossy — '-' stands for every
// non-alphanumeric and for a literal '-' alike (my-app, some_dir, .claude,
// 'My Project', café). Reconstruct by matching the slug against what is
// actually on disk: at each level read the directory, and descend into the
// entries whose own mangled name prefixes what is left. A deleted source
// resolves null, same as before — "gone by id ≠ gone by content" stays
// measurable.
//
// This used to enumerate joiners ('/', '-', '.', '_') at every boundary
// instead. Only the '/' branch pruned (it checked the directory existed); the
// other three just accumulated string, so one wrong turn cost 3^remaining
// with nothing verified until the very end. It exhausted its 50k budget — and
// so answered null — on paths barely deeper than a home directory: a macOS
// temp dir (/private/var/folders/<hash>/T/...) was already past it.
//
// A POSIX well mangles its leading '/' to '-'; a Windows well starts at a
// drive letter, so 'C:\Users\x' mangles to 'C--Users-x'. Both shapes are
// recognized on EITHER host — a root that doesn't exist here walks to null,
// the same answer a deleted source gives.
const WIN_WELL = /^([A-Za-z])--/
// A runaway guard, not a search bound: it counts directories actually read,
// and a real tree never approaches it.
const DESLUG_BUDGET = 20_000

export function deslugWellDir(name: string): string | null {
  const win = WIN_WELL.exec(name)
  if (!win && !name.startsWith('-')) return null
  return walkSlug(win ? `${win[1]}:\\` : '/', name.slice(win ? 3 : 1), { left: DESLUG_BUDGET })
}

function walkSlug(base: string, rest: string, budget: { left: number }): string | null {
  if (rest === '' || budget.left-- <= 0) return null
  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return null // unreadable (permissions) or gone
  }
  for (const e of entries) {
    // isDirectory() is false for a symlink pointing at one, and the walk has
    // to follow those: /var -> /private/var on macOS is one.
    if (!e.isDirectory() && !(e.isSymbolicLink() && isDir(join(base, e.name)))) continue
    const slug = slugWellDir(e.name)
    if (slug === rest) return join(base, e.name)
    // The separator between this component and the next mangled to '-' too.
    if (rest.startsWith(`${slug}-`)) {
      const found = walkSlug(join(base, e.name), rest.slice(slug.length + 1), budget)
      if (found) return found
    }
  }
  return null
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// Absolute in EITHER shape, whatever host we're on: a '/'-rooted POSIX path,
// a UNC share, or a drive letter. Deliberately not node:path's isAbsolute,
// which answers only for the running platform — an archive copied from a
// Windows box must still resolve its cwds when read on macOS.
export function isAbsolute(path: string): boolean {
  return /^([/\\]|[A-Za-z]:[/\\])/.test(path)
}

// The well's real project path, off the records' own `cwd` — but a cwd is
// only a CANDIDATE until it slugs back to the well's dir (CLAUDE.md: a slug
// is verified, never trusted). Records do not all carry the well's path: a
// mid-session worktree entry moves the whole transcript into the worktree's
// well, pre-entry records included, so a moved file OPENS with the parent's
// cwd. Taking the first cwd in the newest file's head gave 117 of 1,780 real
// wells a path that did not slug to their dir (2026-11-14 review): ~90 cuanto
// worktrees read as ~/code/work/cuanto, so `--well <path> --exact` summed
// them all as one, and two root wells read as one of their worktrees.
//
// Newest session first; in each, the tail before the head — the tail is
// where the session is NOW, which is the well its file sits in. The first
// cwd that verifies wins. None verifying leaves the path to deslugWellDir
// (which walks the disk) or unknown, never wrong.
const SLICE = 65_536
const CwdLine = z.object({ cwd: z.string() })

async function resolveRealPath(dir: string, sessions: SessionFile[]): Promise<string | null> {
  for (const s of sessions) {
    let tail: string
    let head: string
    try {
      const file = Bun.file(s.path)
      head = await file.slice(0, SLICE).text()
      tail = s.size > SLICE ? await file.slice(s.size - SLICE).text() : ''
    } catch {
      continue // moved or deleted mid-scan, as above
    }
    for (const line of [...tail.split('\n').reverse(), ...head.split('\n')]) {
      if (!line.includes('"cwd"')) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue // a slice cuts its first and last lines
      }
      const r = CwdLine.safeParse(parsed)
      if (r.success && isAbsolute(r.data.cwd) && slugWellDir(r.data.cwd) === dir) return r.data.cwd
    }
  }
  return null
}
