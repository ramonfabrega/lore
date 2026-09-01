import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

// Background jobs (lore#8 explorer, v14): `~/.claude/jobs/<id>/state.json`
// is the only place that ties a transcript uuid to the claude.ai session id
// the harness writes into commit trailers (`Claude-Session: …/session_<X>`
// ↔ state.json `bridgeSessionId: cse_<X>` — same suffix, measured
// 2026-09-01 on 13 of 16 jobs). Indexed, a commit's trailer resolves to
// its transcript: `/s/session_<X>` → `/session/<uuid>`, and `lore trace
// session_<X>` works. Interactive (non-job) sessions carry no such file;
// their trailers stay unresolved and the page says so.

const State = z
  .object({
    sessionId: z.string().nullish(),
    bridgeSessionId: z.string().nullish(),
    name: z.string().nullish(),
    cwd: z.string().nullish(),
    state: z.string().nullish(),
    createdAt: z.union([z.string(), z.number()]).nullish(),
    updatedAt: z.union([z.string(), z.number()]).nullish(),
  })
  .loose()

export type JobIndexStats = { jobs: number; withBridge: number; durationMs: number }

function iso(v: string | number | null | undefined): string | null {
  if (v == null) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// `session_<X>` (trailer), `cse_<X>` (state.json), or bare `<X>` all name
// the same bridge session; store and compare the bare suffix.
export function bridgeKey(id: string): string {
  return id.replace(/^.*\/(?=session_)/, '').replace(/^(session|cse)_/, '')
}

export async function indexJobs(db: Database, opts: { claudeDir: string }): Promise<JobIndexStats> {
  const started = performance.now()
  const dir = join(opts.claudeDir, 'jobs')
  const upsert = db.prepare(
    `INSERT INTO jobs(job_id, session_id, bridge_key, name, cwd, state, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET session_id=excluded.session_id, bridge_key=excluded.bridge_key,
       name=excluded.name, cwd=excluded.cwd, state=excluded.state, created_at=excluded.created_at, updated_at=excluded.updated_at`,
  )
  let jobs = 0
  let withBridge = 0
  if (existsSync(dir)) {
    for (const id of readdirSync(dir)) {
      const p = join(dir, id, 'state.json')
      if (!existsSync(p)) continue
      let s: z.infer<typeof State>
      try {
        s = State.parse(JSON.parse(await Bun.file(p).text()))
      } catch {
        continue
      }
      const key = s.bridgeSessionId ? bridgeKey(s.bridgeSessionId) : null
      upsert.run(id, s.sessionId ?? null, key, s.name ?? null, s.cwd ?? null, s.state ?? null, iso(s.createdAt), iso(s.updatedAt))
      jobs++
      if (key) withBridge++
    }
  }
  return { jobs, withBridge, durationMs: Math.round(performance.now() - started) }
}

const Resolved = z.object({ session_id: z.string() })

// A bridge id (any spelling) → the transcript uuid, when a job recorded it.
export function resolveBridge(db: Database, id: string): string | null {
  const key = bridgeKey(id)
  if (!key) return null
  const row = Resolved.nullish().parse(
    db.prepare('SELECT session_id FROM jobs WHERE bridge_key = ? AND session_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1').get(key),
  )
  return row?.session_id ?? null
}
