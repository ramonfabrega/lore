import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import type { Lane } from './parse'
import { parseLine } from './parse'
import { listWells } from './wells'

// What counts as the session doing work, for last_activity_ts. Deliberately
// excludes `event` (system records, bridge_status heartbeats, pr-links, titles,
// summaries) and `meta` (slash commands, context dumps) — those keep ticking
// long after the work stops, which is the whole bug.
const ACTIVITY_LANES = new Set<Lane>(['prompt', 'text', 'thinking', 'tool'])

const WellId = z.object({ id: z.number() })
const ExistingSession = z.object({ id: z.number(), size: z.number(), mtime_ms: z.number() }).nullish()

export type IndexStats = {
  wells: number
  sessionsIndexed: number
  sessionsSkipped: number
  messages: number
  historyRows: number
  durationMs: number
}

export async function buildIndex(
  db: Database,
  opts: { projectsDir: string; historyPath: string; full?: boolean },
): Promise<IndexStats> {
  const started = performance.now()
  const wells = await listWells(opts.projectsDir)

  const upsertWell = db.prepare(
    `INSERT INTO wells(dir, real_path, is_worktree, has_memory) VALUES(?, ?, ?, ?)
     ON CONFLICT(dir) DO UPDATE SET real_path=excluded.real_path,
       is_worktree=excluded.is_worktree, has_memory=excluded.has_memory
     RETURNING id`,
  )
  const findSession = db.prepare('SELECT id, size, mtime_ms FROM sessions WHERE session_id = ?')
  const upsertSession = db.prepare(
    `INSERT INTO sessions(well_id, session_id, size, mtime_ms, lines, first_ts, last_ts, last_activity_ts)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET well_id=excluded.well_id, size=excluded.size,
       mtime_ms=excluded.mtime_ms, lines=excluded.lines, first_ts=excluded.first_ts, last_ts=excluded.last_ts,
       last_activity_ts=excluded.last_activity_ts`,
  )
  const deleteMsgs = db.prepare('DELETE FROM messages WHERE session_id = ?')
  const deleteFts = db.prepare(
    'DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id = ?)',
  )
  const insertMsg = db.prepare(
    'INSERT INTO messages(session_id, uuid, ts, lane, type, git_branch, cwd, tool_name) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const insertFts = db.prepare('INSERT INTO messages_fts(rowid, text) VALUES(?, ?)')

  let sessionsIndexed = 0
  let sessionsSkipped = 0
  let messages = 0

  for (const well of wells) {
    const wellId = WellId.parse(
      upsertWell.get(well.dir, well.realPath, well.isWorktree ? 1 : 0, well.hasMemory ? 1 : 0),
    ).id

    for (const s of well.sessions) {
      const existing = ExistingSession.parse(findSession.get(s.sessionId))
      if (!opts.full && existing && existing.size === s.size && existing.mtime_ms === s.mtimeMs) {
        sessionsSkipped++
        continue
      }

      const text = await Bun.file(s.path).text()
      const lines = text.split('\n')

      const indexSession = db.transaction(() => {
        deleteFts.run(s.sessionId)
        deleteMsgs.run(s.sessionId)
        let firstTs: string | null = null
        let lastTs: string | null = null
        // last_ts moves on every timestamped line. last_activity_ts only moves
        // on WORK lanes — a `system`/bridge_status heartbeat is a real indexed
        // entry (it lands in the event lane), so "produced an entry" is not a
        // strong enough test; it has to be "produced work". See db.ts v11.
        let lastActivityTs: string | null = null
        let count = 0
        for (const line of lines) {
          const p = parseLine(line)
          if (!p) continue
          count++
          if (p.timestamp) {
            firstTs ??= p.timestamp
            lastTs = p.timestamp
            if (p.entries.some((e) => ACTIVITY_LANES.has(e.lane))) lastActivityTs = p.timestamp
          }
          for (const e of p.entries) {
            const row = insertMsg.run(s.sessionId, p.uuid ?? null, p.timestamp ?? null, e.lane, p.type, p.gitBranch ?? null, p.cwd ?? null, e.toolName ?? null)
            insertFts.run(row.lastInsertRowid, e.text)
            messages++
          }
        }
        upsertSession.run(wellId, s.sessionId, s.size, s.mtimeMs, count, firstTs, lastTs, lastActivityTs)
      })
      indexSession()
      sessionsIndexed++
    }
  }

  // history.jsonl is small (~12k rows) — rebuild wholesale every run.
  let historyRows = 0
  if (existsSync(opts.historyPath)) {
    const reloadHistory = db.transaction((rows: { ts: string | null; project: string | null; sessionId: string | null; display: string }[]) => {
      db.exec('DELETE FROM history_fts')
      db.exec('DELETE FROM history')
      const ins = db.prepare('INSERT INTO history(ts, project, session_id) VALUES(?, ?, ?)')
      const insFts = db.prepare('INSERT INTO history_fts(rowid, display) VALUES(?, ?)')
      for (const r of rows) {
        const row = ins.run(r.ts, r.project, r.sessionId)
        insFts.run(row.lastInsertRowid, r.display)
      }
    })
    const rows: { ts: string | null; project: string | null; sessionId: string | null; display: string }[] = []
    for (const line of (await Bun.file(opts.historyPath).text()).split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        rows.push({
          ts: r.timestamp != null ? String(r.timestamp) : null,
          project: r.project ?? null,
          sessionId: r.sessionId ?? null,
          display: r.display ?? '',
        })
      } catch {
        // tolerate torn writes — history.jsonl is appended live
      }
    }
    reloadHistory(rows)
    historyRows = rows.length
  }

  return {
    wells: wells.length,
    sessionsIndexed,
    sessionsSkipped,
    messages,
    historyRows,
    durationMs: Math.round(performance.now() - started),
  }
}
