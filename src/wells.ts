import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

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
      const fst = statSync(p)
      sessions.push({ sessionId: f.slice(0, -'.jsonl'.length), path: p, size: fst.size, mtimeMs: fst.mtimeMs })
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
    wells.push({
      dir: name,
      path,
      realPath: (await resolveRealPath(sessions)) ?? deslugWellDir(name),
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
// it into (every non-alphanumeric becomes '-'). Lossy in the other
// direction, which is what deslugWellDir below exists to undo — so a caller
// that slugs a path must VERIFY the result exists before trusting it.
export function slugWellDir(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

// A memory-only well (a live repo with memory but zero transcripts) has no
// cwd record to resolve, and the dir name is lossy — '-' stands for '/', '.',
// '_', and literal '-' alike (my-app, some_dir, .claude). Reconstruct by
// walking the filesystem: at each boundary try every joiner, and only an
// existing directory disambiguates. A deleted source resolves null, same as
// before — "gone by id ≠ gone by content" stays measurable.
// '/' is a SENTINEL for "component boundary", never concatenated: join()
// supplies the platform's real separator, so the same walk reconstructs
// 'C:\\Users\\x' on Windows and '/Users/x' on POSIX.
const JOINERS = ['/', '-', '.', '_'] as const
const DESLUG_BUDGET = 50_000
// A POSIX well mangles its leading '/' to '-'; a Windows well starts at a
// drive letter, so 'C:\\Users\\x' mangles to 'C--Users-x'. Both shapes are
// recognized on EITHER platform — a root that doesn't exist here just walks
// to null, the same answer a deleted source gives.
const WIN_WELL = /^([A-Za-z])--/

export function deslugWellDir(name: string): string | null {
  const win = WIN_WELL.exec(name)
  if (!win && !name.startsWith('-')) return null
  const root = win ? `${win[1]}:\\` : '/'
  const segs = name.slice(win ? 3 : 1).split('-')
  let budget = DESLUG_BUDGET
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  // base: confirmed-existing parent; comp: the in-progress path component.
  const walk = (base: string, comp: string, i: number): string | null => {
    if (budget-- <= 0) return null
    if (i === segs.length) {
      const full = join(base, comp)
      return comp !== '' && isDir(full) ? full : null
    }
    for (const j of JOINERS) {
      if (j === '/') {
        if (comp === '' || !isDir(join(base, comp))) continue
        const r = walk(join(base, comp), segs[i] ?? '', i + 1)
        if (r) return r
      } else {
        const r = walk(base, `${comp}${j}${segs[i] ?? ''}`, i + 1)
        if (r) return r
      }
    }
    return null
  }
  return walk(root, segs[0] ?? '', 1)
}

// Absolute in EITHER shape, whatever host we're on: a '/'-rooted POSIX path,
// a UNC share, or a drive letter. Deliberately not node:path's isAbsolute,
// which answers only for the running platform — an archive copied from a
// Windows box must still resolve its cwds when read on macOS.
export function isAbsolute(path: string): boolean {
  return /^([/\\]|[A-Za-z]:[/\\])/.test(path)
}

// Peek the head of the newest session files for a record carrying `cwd` — the
// only trustworthy source for the well's real project path.
async function resolveRealPath(sessions: SessionFile[]): Promise<string | null> {
  for (const s of sessions.slice(0, 3)) {
    const head = await Bun.file(s.path).slice(0, 65_536).text()
    for (const line of head.split('\n')) {
      if (!line.includes('"cwd"')) continue
      try {
        const cwd = JSON.parse(line).cwd
        if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd
      } catch {
        // partial last line of the head slice — ignore
      }
    }
  }
  return null
}
