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

// A memory-only well (a live repo with memory but zero transcripts) has no
// cwd record to resolve, and the dir name is lossy — '-' stands for '/', '.',
// '_', and literal '-' alike (my-app, some_dir, .claude). Reconstruct by
// walking the filesystem: at each boundary try every joiner, and only an
// existing directory disambiguates. A deleted source resolves null, same as
// before — "gone by id ≠ gone by content" stays measurable.
const JOINERS = ['/', '-', '.', '_'] as const
const DESLUG_BUDGET = 50_000

export function deslugWellDir(name: string): string | null {
  if (!name.startsWith('-')) return null
  const segs = name.slice(1).split('-')
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
  return walk('/', segs[0] ?? '', 1)
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
        if (typeof cwd === 'string' && cwd.startsWith('/')) return cwd
      } catch {
        // partial last line of the head slice — ignore
      }
    }
  }
  return null
}
