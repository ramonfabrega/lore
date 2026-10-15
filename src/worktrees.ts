import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { $ } from 'bun'

// The worktree inventory: every checkout the harness (or Codex) minted under
// a repo's `.claude/worktrees/` (or `~/.codex/worktrees/<id>/<repo>`), with
// what a prune decision needs — is git still tracking it, is its branch
// landed, is the tree clean, is anything still RUNNING in it — and the other
// half of the same mess: processes whose working directory no longer exists,
// because a worktree was closed under them.
//
// Born 2026-10-15 from a cleanup by hand: 137 worktrees across 12 repos held
// 94 GB, 29 were orphans git had already forgotten, three month-old Expo dev
// servers (two in a worktree that was already deleted) pinned 3.7 GB of swap,
// and five processes sat in directories that were gone. Model-free: every
// field is a `git`, `du`, `lsof` or `gh` answer. It changes nothing — the
// removals stay a human's, with this as the reading.

export type WorktreeRow = {
  /** the owning repo relative to the code dir (`fun/attrition`), or the common-dir path when outside it */
  repo: string
  name: string
  path: string
  /** `claude` for `<repo>/.claude/worktrees/*`, `codex` for `~/.codex/worktrees/<id>/<repo>` */
  minter: 'claude' | 'codex'
  bytes: number
  /** git still lists it; false is an ORPHAN dir a prune or a hand delete left behind */
  registered: boolean
  /** null when detached, or when git cannot read the dir at all */
  branch: string | null
  head: string | null
  /** ISO UTC of HEAD's commit */
  lastCommit: string | null
  /** `git status --porcelain` lines: 0 is a clean tree */
  dirty: number | null
  /** the repo's default branch the two flags below are read against (`origin/main`) */
  base: string | null
  /** HEAD is reachable from `base` — a plain merge or fast-forward */
  ancestor: boolean | null
  /** every commit HEAD has beyond `base` has an EQUIVALENT PATCH there (`git cherry`): a squash or cherry-pick landed it. True whenever `ancestor` is. */
  landed: boolean | null
  /** GitHub PR states for the branch (`MERGED#5195`), `none`, or null when --pr was not asked */
  pr: string | null
  /** processes whose working directory is inside this worktree */
  pids: number[]
}

export type OrphanProcess = {
  pid: number
  /** the working directory, which no longer exists */
  cwd: string
  command: string
  /** elapsed time as ps prints it (`19-13:28:03`) */
  elapsed: string
}

export type WorktreesReport = {
  count: number
  bytes: number
  orphans: number
  byRepo: { repo: string; count: number; bytes: number }[]
  worktrees: WorktreeRow[]
  /** processes whose cwd is gone — a worktree (or a job's tmp dir) closed under them */
  orphanProcesses: OrphanProcess[]
}

// ─── pure parsers (tested without git) ──────────────────────────────────────

/** `lsof -d cwd -Fpn`: `p<pid>` lines each followed by `n<path>`. */
export function parseLsofCwd(out: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid: number | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== null) cwds.set(pid, line.slice(1))
  }
  return cwds
}

/** `git worktree list --porcelain`: the `worktree <path>` lines. */
export function parseWorktreeList(out: string): string[] {
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
}

/** `git cherry <base> <head>`: `+` a commit with no equivalent upstream, `-` one that has. Landed = none are `+`. */
export function parseCherry(out: string): { commits: number; landed: boolean } {
  const marks = out
    .split('\n')
    .map((l) => l[0])
    .filter((c): c is string => c === '+' || c === '-')
  return { commits: marks.length, landed: marks.length > 0 && marks.every((m) => m === '-') }
}

/** `du -sk <paths...>`: KiB per path. */
export function parseDu(out: string): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const line of out.split('\n')) {
    const m = /^(\d+)\s+(.+)$/.exec(line)
    if (m) sizes.set(m[2]!, Number(m[1]) * 1024)
  }
  return sizes
}

/** `gh pr list --json state,number` → `MERGED#5195,OPEN#5242`, or `none`. */
export function prLabel(json: string): string {
  try {
    const v: unknown = JSON.parse(json)
    if (!Array.isArray(v)) return 'none'
    const parts = v
      .map((x) => (typeof x === 'object' && x !== null ? (x as { state?: unknown; number?: unknown }) : null))
      .filter((x): x is { state?: unknown; number?: unknown } => x !== null)
      .map((x) => `${typeof x.state === 'string' ? x.state : '?'}#${typeof x.number === 'number' ? x.number : '?'}`)
    return parts.length ? parts.join(',') : 'none'
  } catch {
    return 'none'
  }
}

/** `/Users/x/code/fun/attrition` under `/Users/x/code` → `fun/attrition`; outside it, the path itself. */
export function repoKey(repoPath: string, codeDir: string): string {
  const prefix = codeDir.endsWith('/') ? codeDir : `${codeDir}/`
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath
}

/** The repo root from `git rev-parse --git-common-dir`: `<repo>/.git` → `<repo>`. */
export function repoFromCommonDir(commonDir: string): string | null {
  const dir = commonDir.trim()
  if (!dir) return null
  return basename(dir) === '.git' ? dirname(dir) : dir
}

// ─── discovery ──────────────────────────────────────────────────────────────

function dirs(path: string): string[] {
  if (!existsSync(path)) return []
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(path, e.name))
  } catch {
    return []
  }
}

/** Every `<codeDir>/<group>/<repo>/.claude/worktrees/<name>` plus `<codexDir>/worktrees/<id>/<repo>`. */
export function discoverWorktreeDirs(codeDir: string, codexDir: string): { path: string; minter: 'claude' | 'codex' }[] {
  const found: { path: string; minter: 'claude' | 'codex' }[] = []
  for (const group of dirs(codeDir)) {
    for (const repo of dirs(group)) {
      for (const wt of dirs(join(repo, '.claude', 'worktrees'))) found.push({ path: wt, minter: 'claude' })
    }
  }
  for (const id of dirs(join(codexDir, 'worktrees'))) {
    for (const wt of dirs(id)) found.push({ path: wt, minter: 'codex' })
  }
  return found
}

// ─── the reading ────────────────────────────────────────────────────────────

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  const r = await $`git -C ${cwd} ${args}`.quiet().nothrow()
  return r.exitCode === 0 ? r.text() : null
}

async function pmap<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const baseCache = new Map<string, Promise<string | null>>()

/** The repo's default branch as a ref: origin/HEAD's target, else origin/main, origin/master, main, master. */
function defaultBase(repo: string): Promise<string | null> {
  let p = baseCache.get(repo)
  if (!p) {
    p = (async () => {
      const head = await git(repo, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD')
      if (head?.trim()) return head.trim()
      for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
        if ((await git(repo, 'rev-parse', '-q', '--verify', ref)) !== null) return ref
      }
      return null
    })()
    baseCache.set(repo, p)
  }
  return p
}

const registeredCache = new Map<string, Promise<Set<string>>>()

function registeredIn(repo: string): Promise<Set<string>> {
  let p = registeredCache.get(repo)
  if (!p) {
    p = git(repo, 'worktree', 'list', '--porcelain').then((out) => new Set(parseWorktreeList(out ?? '')))
    registeredCache.set(repo, p)
  }
  return p
}

async function readOne(
  wt: { path: string; minter: 'claude' | 'codex' },
  codeDir: string,
  cwds: Map<number, string>,
  askPr: boolean,
): Promise<WorktreeRow> {
  const name = basename(wt.path)
  const pids = [...cwds.entries()].filter(([, cwd]) => cwd === wt.path || cwd.startsWith(`${wt.path}/`)).map(([pid]) => pid)
  const row: WorktreeRow = {
    repo: wt.minter === 'codex' ? `codex/${name}` : repoKey(dirname(dirname(dirname(wt.path))), codeDir),
    name,
    path: wt.path,
    minter: wt.minter,
    bytes: 0,
    registered: false,
    branch: null,
    head: null,
    lastCommit: null,
    dirty: null,
    base: null,
    ancestor: null,
    landed: null,
    pr: null,
    pids,
  }
  const common = repoFromCommonDir((await git(wt.path, 'rev-parse', '--git-common-dir')) ?? '')
  if (!common) return row
  const repo = common.startsWith('/') ? common : join(wt.path, common)
  row.repo = repoKey(repo, codeDir)
  row.registered = (await registeredIn(repo)).has(wt.path)
  row.head = (await git(wt.path, 'rev-parse', '-q', '--verify', 'HEAD'))?.trim() ?? null
  if (!row.head) return row
  row.branch = (await git(wt.path, 'symbolic-ref', '-q', '--short', 'HEAD'))?.trim() || null
  const ct = (await git(wt.path, 'log', '-1', '--format=%ct', 'HEAD'))?.trim()
  row.lastCommit = ct ? new Date(Number(ct) * 1000).toISOString() : null
  const status = await git(wt.path, 'status', '--porcelain')
  row.dirty = status === null ? null : status.split('\n').filter(Boolean).length
  row.base = await defaultBase(repo)
  if (row.base) {
    const anc = await $`git -C ${repo} merge-base --is-ancestor ${row.head} ${row.base}`.quiet().nothrow()
    row.ancestor = anc.exitCode === 0
    if (row.ancestor) row.landed = true
    else {
      const cherry = await git(repo, 'cherry', row.base, row.head)
      row.landed = cherry === null ? null : parseCherry(cherry).landed
    }
  }
  if (askPr && row.branch) {
    const r = await $`gh pr list --head ${row.branch} --state all --json state,number`.cwd(repo).quiet().nothrow()
    row.pr = r.exitCode === 0 ? prLabel(r.text()) : 'none'
  }
  return row
}

async function readCwds(): Promise<Map<number, string>> {
  const r = await $`lsof -d cwd -Fpn`.quiet().nothrow()
  return parseLsofCwd(r.text())
}

async function orphanProcesses(cwds: Map<number, string>): Promise<OrphanProcess[]> {
  const gone = [...cwds.entries()].filter(([, cwd]) => cwd.startsWith('/') && !existsSync(cwd))
  if (gone.length === 0) return []
  const ps = await $`ps -o pid=,etime=,command= -p ${gone.map(([pid]) => pid).join(',')}`.quiet().nothrow()
  const info = new Map<number, { elapsed: string; command: string }>()
  for (const line of ps.text().split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (m) info.set(Number(m[1]), { elapsed: m[2]!, command: m[3]!.slice(0, 160) })
  }
  return gone
    .map(([pid, cwd]) => ({ pid, cwd, command: info.get(pid)?.command ?? '', elapsed: info.get(pid)?.elapsed ?? '' }))
    .sort((a, b) => a.cwd.localeCompare(b.cwd))
}

export async function listWorktrees(opts: {
  codeDir: string
  codexDir: string
  repo?: string
  pr?: boolean
}): Promise<WorktreesReport> {
  const found = discoverWorktreeDirs(opts.codeDir, opts.codexDir)
  const cwds = await readCwds()
  const sizes = found.length ? parseDu((await $`du -sk ${found.map((f) => f.path)}`.quiet().nothrow()).text()) : new Map()
  let rows = await pmap(found, 8, (wt) => readOne(wt, opts.codeDir, cwds, opts.pr === true))
  for (const row of rows) row.bytes = sizes.get(row.path) ?? 0
  if (opts.repo) rows = rows.filter((r) => r.repo.includes(opts.repo!) || r.path.includes(opts.repo!))
  rows.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
  const byRepo = new Map<string, { repo: string; count: number; bytes: number }>()
  for (const r of rows) {
    const agg = byRepo.get(r.repo) ?? { repo: r.repo, count: 0, bytes: 0 }
    agg.count += 1
    agg.bytes += r.bytes
    byRepo.set(r.repo, agg)
  }
  return {
    count: rows.length,
    bytes: rows.reduce((n, r) => n + r.bytes, 0),
    orphans: rows.filter((r) => !r.registered).length,
    byRepo: [...byRepo.values()].sort((a, b) => b.bytes - a.bytes),
    worktrees: rows,
    orphanProcesses: await orphanProcesses(cwds),
  }
}

/** Where a worktree dir's size comes from when the report is read cold: a stat guard for tests. */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
