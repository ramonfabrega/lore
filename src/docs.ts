import type { Database } from 'bun:sqlite'
import { $ } from 'bun'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

// The canon corpus: git-committed .md files across the repos under ~/code.
// Canon may exist only in git objects — a husk checkout (gym) has README,
// CLAUDE.md, docs/ on origin/master with no working tree anywhere on disk —
// so everything here reads via git plumbing, never the working tree.

// Whose doctrine is this repo's canon?
// - mine: the user commits here — index normally.
// - assisted: helped on someone else's project (zero commits under the user's
//   repo-local git identity) — index for context, but every hit carries the
//   flag: this canon must never read as the user's, feed pattern-page
//   provenance, or count in graduation dedup as "we already say this".
// - foreign: fork-for-upstreaming (`upstream` remote) — docs not indexed.
export type Ownership = 'mine' | 'assisted' | 'foreign'

export type RepoScan = {
  path: string
  ref: string // the ref canon was read from — 'HEAD', or a remote ref when origin is newer
  sha: string
  commitTs: number
  isHusk: boolean // local HEAD carries zero canon while the chosen remote ref has some
  ownership: Ownership
  files: DocFile[]
}

export type DocFile = { path: string; blobSha: string; size: number }

const MAX_DOC_BYTES = 2_000_000
const REMOTE_REFS = ['origin/HEAD', 'origin/main', 'origin/master']

// Excludes match on the whole path or a `/`-bounded suffix — "sandbox/expo"
// hits ~/code/sandbox/expo but not ~/code/sandbox/expo-sdk-54-repro.
function isExcluded(dir: string, exclude: string[]): boolean {
  return exclude.some((e) => dir === e || dir.endsWith(`/${e}`))
}

// Walk codeDir for git repos: prune at each .git (dir or file — worktrees and
// submodules never scan as their own repos), skip hidden dirs and node_modules.
export function listRepoPaths(root: string, opts?: { exclude?: string[]; maxDepth?: number }): string[] {
  const exclude = opts?.exclude ?? []
  const maxDepth = opts?.maxDepth ?? 4
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    if (isExcluded(dir, exclude)) return
    if (existsSync(join(dir, '.git'))) {
      found.push(dir)
      return
    }
    if (depth >= maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      walk(join(dir, e.name), depth + 1)
    }
  }
  walk(root, 0)
  return found.sort()
}

async function git(repo: string, ...args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await $`git -C ${repo} ${args}`.quiet().nothrow()
  return { ok: r.exitCode === 0, out: r.text() }
}

type RefInfo = { ref: string; sha: string; commitTs: number }

async function refInfo(repo: string, ref: string): Promise<RefInfo | null> {
  const r = await git(repo, 'log', '-1', '--format=%H %ct', ref, '--')
  if (!r.ok) return null
  const [sha, ct] = r.out.trim().split(' ')
  if (!sha || !ct) return null
  return { ref, sha, commitTs: Number(ct) }
}

// One line per blob: `<mode> <type> <sha> <size>\t<path>` (-l for size, -z so
// paths arrive unquoted). Vendored trees that slipped past .gitignore stay out.
async function listMdFiles(repo: string, ref: string): Promise<DocFile[] | null> {
  const r = await git(repo, 'ls-tree', '-r', '-l', '-z', ref)
  if (!r.ok) return null
  const files: DocFile[] = []
  for (const entry of r.out.split('\0')) {
    const m = entry.match(/^\d+ blob ([0-9a-f]+) +(\d+)\t(.+)$/s)
    if (!m) continue
    const [, blobSha, size, path] = m
    if (!blobSha || !size || !path) continue
    if (!path.endsWith('.md') || path.includes('node_modules/')) continue
    files.push({ path, blobSha, size: Number(size) })
  }
  return files
}

// Canon is read from the newest commit among local HEAD and origin's default
// branch — a husk repo's real state lives only at origin. Ties prefer HEAD.
export async function scanRepo(repoPath: string, opts?: { assisted?: string[] }): Promise<RepoScan | null> {
  const local = await refInfo(repoPath, 'HEAD')
  let remote: RefInfo | null = null
  for (const ref of REMOTE_REFS) {
    remote = await refInfo(repoPath, ref)
    if (remote) break
  }
  const chosen = !local ? remote : remote && remote.commitTs > local.commitTs ? remote : local
  if (!chosen) return null

  const ownership = isExcluded(repoPath, opts?.assisted ?? [])
    ? 'assisted'
    : await detectOwnership(repoPath, chosen.ref)

  const files = ownership === 'foreign' ? [] : ((await listMdFiles(repoPath, chosen.ref)) ?? [])
  let isHusk = false
  if (chosen !== local && files.length > 0) {
    const localFiles = local ? await listMdFiles(repoPath, local.ref) : []
    isHusk = (localFiles ?? []).length === 0
  }
  return { path: repoPath, ref: chosen.ref, sha: chosen.sha, commitTs: chosen.commitTs, isHusk, ownership, files }
}

// An `upstream` remote marks a fork kept around to send PRs — foreign, skip.
// Otherwise ownership hangs on whether the user has ever committed here under
// the repo-local git identity: zero authored commits on the canon ref means
// they were assisting on someone else's project. A share threshold was probed
// and rejected — cuanto is 34/5157 under the personal email yet unmistakably
// the user's; the zero/nonzero line is the one the fleet actually draws.
async function detectOwnership(repoPath: string, ref: string): Promise<Ownership> {
  const remotes = await git(repoPath, 'remote')
  if (remotes.ok && remotes.out.split('\n').includes('upstream')) return 'foreign'
  const email = (await git(repoPath, 'config', 'user.email')).out.trim()
  if (!email) return 'assisted'
  const authored = await git(repoPath, 'rev-list', '--count', `--author=${email}`, ref, '--')
  return authored.ok && Number(authored.out.trim()) > 0 ? 'mine' : 'assisted'
}

export async function readBlob(repoPath: string, blobSha: string): Promise<string | null> {
  const r = await git(repoPath, 'cat-file', 'blob', blobSha)
  return r.ok ? r.out : null
}

export type DocsIndexStats = {
  repos: number
  reposIndexed: number
  reposSkipped: number
  reposPruned: number
  docs: number
  durationMs: number
}

const ExistingRepo = z.object({ ref: z.string(), commit_sha: z.string(), ownership: z.string() }).nullish()

export async function indexDocs(
  db: Database,
  opts: { codeDir: string; exclude?: string[]; assisted?: string[]; full?: boolean },
): Promise<DocsIndexStats> {
  const started = performance.now()
  const repoPaths = listRepoPaths(opts.codeDir, { exclude: opts.exclude })

  const findRepo = db.prepare('SELECT ref, commit_sha, ownership FROM repos WHERE path = ?')
  const upsertRepo = db.prepare(
    `INSERT INTO repos(path, ref, commit_sha, commit_ts, is_husk, ownership) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET ref=excluded.ref, commit_sha=excluded.commit_sha,
       commit_ts=excluded.commit_ts, is_husk=excluded.is_husk, ownership=excluded.ownership
     RETURNING id`,
  )
  const deleteDocsFts = db.prepare('DELETE FROM docs_fts WHERE rowid IN (SELECT id FROM docs WHERE repo_id = ?)')
  const deleteDocs = db.prepare('DELETE FROM docs WHERE repo_id = ?')
  const insertDoc = db.prepare('INSERT INTO docs(repo_id, path, blob_sha, size) VALUES(?, ?, ?, ?)')
  const insertFts = db.prepare('INSERT INTO docs_fts(rowid, text) VALUES(?, ?)')

  let reposIndexed = 0
  let reposSkipped = 0
  let docs = 0

  for (const repoPath of repoPaths) {
    const scan = await scanRepo(repoPath, { assisted: opts.assisted })
    if (!scan) {
      reposSkipped++
      continue
    }
    const existing = ExistingRepo.parse(findRepo.get(repoPath))
    if (
      !opts.full &&
      existing &&
      existing.ref === scan.ref &&
      existing.commit_sha === scan.sha &&
      existing.ownership === scan.ownership
    ) {
      reposSkipped++
      continue
    }

    const contents: { file: DocFile; text: string }[] = []
    for (const file of scan.files) {
      if (file.size > MAX_DOC_BYTES) continue
      const text = await readBlob(repoPath, file.blobSha)
      if (text !== null) contents.push({ file, text })
    }

    db.transaction(() => {
      const repoId = z.object({ id: z.number() }).parse(
        upsertRepo.get(scan.path, scan.ref, scan.sha, scan.commitTs, scan.isHusk ? 1 : 0, scan.ownership),
      ).id
      deleteDocsFts.run(repoId)
      deleteDocs.run(repoId)
      for (const { file, text } of contents) {
        const row = insertDoc.run(repoId, file.path, file.blobSha, file.size)
        insertFts.run(row.lastInsertRowid, text)
        docs++
      }
    })()
    reposIndexed++
  }

  // A repo gone from disk means its canon moved or died with it — unlike
  // transcripts, there is no evaporation to guard against; prune.
  const known = z.array(z.object({ id: z.number(), path: z.string() })).parse(db.prepare('SELECT id, path FROM repos').all())
  const live = new Set(repoPaths)
  let reposPruned = 0
  const pruneRepo = db.transaction((id: number) => {
    deleteDocsFts.run(id)
    deleteDocs.run(id)
    db.prepare('DELETE FROM repos WHERE id = ?').run(id)
  })
  for (const r of known) {
    if (live.has(r.path)) continue
    pruneRepo(r.id)
    reposPruned++
  }

  return {
    repos: repoPaths.length,
    reposIndexed,
    reposSkipped,
    reposPruned,
    docs,
    durationMs: Math.round(performance.now() - started),
  }
}

const DocHit = z.object({
  repo: z.string(),
  path: z.string(),
  ref: z.string(),
  isHusk: z.number().transform(Boolean),
  ownership: z.enum(['mine', 'assisted', 'foreign']),
  snippet: z.string(),
})
export type DocHit = z.infer<typeof DocHit>

export function searchDocs(db: Database, query: string, opts: { repo?: string; limit: number }): DocHit[] {
  const repoClause = opts.repo ? 'AND r.path LIKE ?' : ''
  const sql = `
    SELECT r.path AS repo, d.path AS path, r.ref AS ref, r.is_husk AS isHusk, r.ownership AS ownership,
           snippet(docs_fts, 0, '«', '»', ' … ', 24) AS snippet
    FROM docs_fts f
    JOIN docs d ON d.id = f.rowid
    JOIN repos r ON r.id = d.repo_id
    WHERE docs_fts MATCH ? ${repoClause}
    ORDER BY rank LIMIT ?`
  const params: (string | number)[] = [query]
  if (opts.repo) params.push(`%${opts.repo}%`)
  params.push(opts.limit)
  return z.array(DocHit).parse(db.prepare(sql).all(...params))
}

const RepoRow = z.object({
  path: z.string(),
  ref: z.string(),
  sha: z.string(),
  commitTs: z.number(),
  isHusk: z.number().transform(Boolean),
  ownership: z.enum(['mine', 'assisted', 'foreign']),
  docs: z.number(),
  bytes: z.number(),
})
export type RepoRow = z.infer<typeof RepoRow>

export function listIndexedRepos(db: Database): RepoRow[] {
  return z.array(RepoRow).parse(
    db
      .prepare(
        `SELECT r.path, r.ref, substr(r.commit_sha, 1, 8) AS sha, r.commit_ts AS commitTs, r.is_husk AS isHusk,
                r.ownership, COUNT(d.id) AS docs, COALESCE(SUM(d.size), 0) AS bytes
         FROM repos r LEFT JOIN docs d ON d.repo_id = r.id
         GROUP BY r.id ORDER BY r.path`,
      )
      .all(),
  )
}
