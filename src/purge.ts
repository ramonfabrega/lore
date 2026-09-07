import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

// The escape hatch, and only that.
//
// lore's index deliberately OUTLIVES its sources: the archive is additive
// (archive.ts — files removed at the source stay preserved) and `lore index`
// never prunes rows for a transcript that vanished. Deleting the well file is
// therefore not a delete — the session keeps answering `lore trace`, keeps its
// tokens in `lore usage`, keeps its text in the FTS. That is the retention
// property working as designed, which is exactly why the way OUT has to be an
// explicit verb rather than a prune pass over "sources that are gone".
//
// A purge that misses one copy un-purges itself:
//   - the well transcript + <session>/ dir (subagents, workflow runs, title)
//   - the archive mirror of both
//   - the index rows (7 tables, two of them FTS)
//   - ~/.claude/history.jsonl, which `lore index` reloads WHOLESALE every run
//     (indexer.ts) — leave those lines and the prompts are searchable again
//     after the next index, with the session row gone to point at.
// So the default is all of them, and each is a `--keep-*` away.

export type PurgeFile = { path: string; kind: 'source' | 'archive'; bytes: number }

export type PurgeReport = {
  sessionId: string
  dryRun: boolean
  indexed: boolean
  well: string | null
  rows: Record<string, number>
  files: PurgeFile[]
  historyLines: { path: string; lines: number }[]
  bytes: number
}

type PurgeOpts = {
  projectsDir: string
  archiveDir: string
  historyPath: string
  yes?: boolean
  indexOnly?: boolean
  keepSource?: boolean
  keepArchive?: boolean
  keepHistory?: boolean
}

const IdRow = z.object({ session_id: z.string() })
const CountRow = z.object({ n: z.number() })
const WellRow = z.object({ dir: z.string() }).nullish()

// Rows keyed on the transcript's session id. messages_fts/history_fts hang off
// their parent's rowid, so they go first, in the same transaction.
const ROW_TABLES = ['messages', 'requests', 'spawns', 'workflow_runs', 'history', 'jobs'] as const

// A purge takes a prefix like every other id argument, but it cannot lean on
// resolveSessionId: the case that brings people here is a session whose file
// is already deleted, and one whose ROW is already gone (a half-purge) still
// has copies on disk. So the id is resolved against the index AND both trees,
// and an ambiguous prefix is an error rather than a guess — this verb deletes.
async function resolveId(db: Database, prefix: string, opts: PurgeOpts): Promise<string> {
  const ids = new Set<string>()
  for (const r of db.prepare('SELECT session_id FROM sessions WHERE session_id LIKE ? LIMIT 20').all(`${prefix}%`))
    ids.add(IdRow.parse(r).session_id)
  for (const root of [opts.projectsDir, join(opts.archiveDir, 'projects')])
    for (const f of scanWells(root, prefix)) ids.add(f.sessionId)
  // history.jsonl is the copy that survives everything else — a session with
  // no rows and no transcript can still have the user's typed prompts sitting
  // there, waiting for the next index to make them searchable again. Resolving
  // off it is what makes the verb able to finish a half-done purge.
  for (const id of await historyIds(opts.historyPath, prefix)) ids.add(id)
  const found = [...ids]
  if (found.length === 0) throw new Error(`nothing to purge: no indexed session or transcript matches "${prefix}"`)
  if (found.length > 1) throw new Error(`ambiguous prefix "${prefix}": ${found.join(', ')}`)
  return found[0]!
}

async function historyIds(path: string, prefix: string): Promise<string[]> {
  if (!existsSync(path)) return []
  const ids = new Set<string>()
  for (const line of (await Bun.file(path).text()).split('\n')) {
    if (!line.trim()) continue
    try {
      const sid = JSON.parse(line)?.sessionId
      if (typeof sid === 'string' && sid.startsWith(prefix)) ids.add(sid)
    } catch {
      // torn write — history.jsonl is appended live
    }
  }
  return [...ids]
}

type Hit = { sessionId: string; path: string; isDir: boolean }

// Both trees are <root>/<well>/<id>.jsonl plus an optional <root>/<well>/<id>/
// directory (subagents/, workflows/, custom-title.json). A session can appear
// under several wells at once: a mid-session worktree entry MOVES the file
// (CLAUDE.md), and the archive keeps whatever well it was in when it was last
// mirrored — so this collects every hit, never the first.
function scanWells(root: string, prefix: string): Hit[] {
  if (!existsSync(root)) return []
  const hits: Hit[] = []
  for (const well of readdirSync(root)) {
    const wellPath = join(root, well)
    let entries: string[]
    try {
      if (!statSync(wellPath).isDirectory()) continue
      entries = readdirSync(wellPath)
    } catch {
      continue
    }
    for (const entry of entries) {
      const isJsonl = entry.endsWith('.jsonl')
      const id = isJsonl ? entry.slice(0, -'.jsonl'.length) : entry
      if (!id.startsWith(prefix)) continue
      const path = join(wellPath, entry)
      let isDir: boolean
      try {
        isDir = statSync(path).isDirectory()
      } catch {
        continue
      }
      if (isDir === isJsonl) continue // a directory named *.jsonl isn't ours
      hits.push({ sessionId: id, path, isDir })
    }
  }
  return hits
}

function bytesOf(path: string): number {
  try {
    const st = statSync(path)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const entry of readdirSync(path)) total += bytesOf(join(path, entry))
    return total
  } catch {
    return 0
  }
}

// history.jsonl is one JSON object per line carrying `sessionId`; the file is
// APPENDED to by every live session, so it is filtered and renamed into place
// rather than truncated and rewritten — a torn read there would cost other
// agents their ↑-history. The window is still a rename, not a lock: a line
// appended during the rewrite is lost. Cheap enough against the alternative
// (the purged prompts returning at the next index), and `--keep-history`
// opts out.
async function scrubHistory(path: string, sessionId: string, dryRun: boolean): Promise<{ path: string; lines: number } | null> {
  if (!existsSync(path)) return null
  const lines = (await Bun.file(path).text()).split('\n')
  const kept: string[] = []
  let removed = 0
  for (const line of lines) {
    if (!line.trim()) continue
    let sid: unknown
    try {
      sid = JSON.parse(line)?.sessionId
    } catch {
      sid = null // torn write: keep it, this verb removes one session, not junk
    }
    if (sid === sessionId) removed++
    else kept.push(line)
  }
  if (removed === 0) return null
  if (!dryRun) {
    const tmp = `${path}.purge-${process.pid}`
    writeFileSync(tmp, kept.join('\n') + '\n')
    renameSync(tmp, path)
  }
  return { path, lines: removed }
}

export async function purgeSession(db: Database, prefix: string, opts: PurgeOpts): Promise<PurgeReport> {
  const sessionId = await resolveId(db, prefix, opts)
  const dryRun = !opts.yes

  const well = WellRow.parse(
    db.prepare('SELECT w.dir AS dir FROM sessions s JOIN wells w ON w.id = s.well_id WHERE s.session_id = ?').get(sessionId),
  )
  const rows: Record<string, number> = {}
  const count = (sql: string) => CountRow.parse(db.prepare(sql).get(sessionId)).n
  rows.sessions = count('SELECT count(*) AS n FROM sessions WHERE session_id = ?')
  for (const t of ROW_TABLES) rows[t] = count(`SELECT count(*) AS n FROM ${t} WHERE session_id = ?`)

  const files: PurgeFile[] = []
  if (!opts.indexOnly && !opts.keepSource)
    for (const h of scanWells(opts.projectsDir, sessionId))
      if (h.sessionId === sessionId) files.push({ path: h.path, kind: 'source', bytes: bytesOf(h.path) })
  if (!opts.indexOnly && !opts.keepArchive)
    for (const h of scanWells(join(opts.archiveDir, 'projects'), sessionId))
      if (h.sessionId === sessionId) files.push({ path: h.path, kind: 'archive', bytes: bytesOf(h.path) })

  const historyLines: { path: string; lines: number }[] = []
  if (!opts.indexOnly && !opts.keepHistory) {
    for (const p of [opts.historyPath, join(opts.archiveDir, 'history.jsonl')]) {
      const r = await scrubHistory(p, sessionId, dryRun)
      if (r) historyLines.push(r)
    }
  }

  if (!dryRun) {
    // One transaction: a half-deleted session (rows gone, FTS orphaned) would
    // corrupt every search result, not just this session's.
    db.transaction(() => {
      db.prepare('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id = ?)').run(sessionId)
      db.prepare('DELETE FROM history_fts WHERE rowid IN (SELECT id FROM history WHERE session_id = ?)').run(sessionId)
      for (const t of ROW_TABLES) db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(sessionId)
      db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId)
    })()
    for (const f of files) rmSync(f.path, { recursive: true, force: true })
  }

  return {
    sessionId,
    dryRun,
    indexed: rows.sessions! > 0,
    well: well?.dir ?? null,
    rows,
    files,
    historyLines,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
  }
}
