import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { CLAUDE_DIR } from './config'
import { listUsage } from './usage'

// The live roster (docs/EXPLORER.md, the agents page): what `claude agents`
// shows, joined to what lore knows. Two sources, both files the harness
// already writes — `claude agents --json --all` (the daemon's listing, ~140 ms)
// and each job's `~/.claude/jobs/<id>/state.json` (state, detail, tempo, the
// LIVE token counter, links) — plus lore's own index for the well, the fee
// so far, and the last indexed activity. The index lags the live transcript
// by however long since `lore index`; the row says so with `indexed`.
// Attach stays in the terminal: the row carries the command, not a button.

const Listed = z
  .object({
    id: z.string().nullish(),
    cwd: z.string(),
    kind: z.string(),
    startedAt: z.number(),
    sessionId: z.string().nullish(),
    name: z.string().nullish(),
    state: z.string().nullish(),
    pid: z.number().nullish(),
    status: z.string().nullish(),
    waitingFor: z.string().nullish(),
  })
  .loose()
export type ListedAgent = z.infer<typeof Listed>

const Child = z.object({ id: z.string(), href: z.string(), kind: z.string() }).loose()
const State = z
  .object({
    state: z.string().nullish(),
    detail: z.string().nullish(),
    tempo: z.string().nullish(),
    tokens: z.number().nullish(),
    name: z.string().nullish(),
    intent: z.string().nullish(),
    worktreeBranch: z.string().nullish(),
    children: z.array(Child).nullish(),
    // ISO strings in state.json; the daemon listing uses epoch ms. Both land
    // as ISO on the row.
    createdAt: z.union([z.string(), z.number()]).nullish(),
    updatedAt: z.union([z.string(), z.number()]).nullish(),
    sessionId: z.string().nullish(),
  })
  .loose()

function iso(v: string | number | null | undefined): string | null {
  if (v == null) return null
  const d = typeof v === 'number' ? new Date(v) : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
export type JobState = z.infer<typeof State>

export type AgentRow = {
  id: string | null
  name: string | null
  state: string
  waitingFor: string | null
  detail: string | null
  tempo: string | null
  cwd: string
  branch: string | null
  sessionId: string | null
  startedAt: string
  updatedAt: string | null
  liveTokens: number | null
  children: { id: string; href: string; kind: string }[]
  attach: string | null
  // lore's side — null when the session is not indexed yet
  indexed: { well: string; requests: number; output: number; listUsd: number | null; last: string | null } | null
}

export async function listAgentsRaw(): Promise<ListedAgent[]> {
  const r = await Bun.$`claude agents --json --all`.quiet().nothrow()
  if (r.exitCode !== 0) throw new Error(`claude agents --json failed (${r.exitCode}): ${r.stderr.toString().trim()}`)
  return z.array(Listed).parse(JSON.parse(r.stdout.toString() || '[]'))
}

export async function readJobState(id: string): Promise<JobState | null> {
  const p = join(CLAUDE_DIR, 'jobs', id, 'state.json')
  if (!existsSync(p)) return null
  try {
    return State.parse(JSON.parse(await Bun.file(p).text()))
  } catch {
    return null
  }
}

const ACTIVE = new Set(['working', 'blocked'])

export function joinAgents(
  listed: ListedAgent[],
  states: Map<string, JobState | null>,
  lookup: (sessionId: string) => AgentRow['indexed'],
): AgentRow[] {
  const rows = listed.map((a): AgentRow => {
    const st = a.id ? (states.get(a.id) ?? null) : null
    const sessionId = a.sessionId ?? st?.sessionId ?? null
    return {
      id: a.id ?? null,
      name: a.name ?? st?.name ?? null,
      state: a.state ?? st?.state ?? 'unknown',
      waitingFor: a.waitingFor ?? null,
      detail: st?.detail ?? st?.intent ?? null,
      tempo: st?.tempo ?? null,
      cwd: a.cwd,
      branch: st?.worktreeBranch ?? null,
      sessionId,
      startedAt: new Date(a.startedAt).toISOString(),
      updatedAt: iso(st?.updatedAt),
      liveTokens: st?.tokens ?? null,
      children: st?.children ?? [],
      attach: a.id ? `claude attach ${a.id}` : null,
      indexed: sessionId ? lookup(sessionId) : null,
    }
  })
  rows.sort((x, y) => {
    const ax = ACTIVE.has(x.state) ? 0 : 1
    const ay = ACTIVE.has(y.state) ? 0 : 1
    if (ax !== ay) return ax - ay
    return (y.updatedAt ?? y.startedAt).localeCompare(x.updatedAt ?? x.startedAt)
  })
  return rows
}

const IndexedRow = z.object({ sessionId: z.string(), well: z.string(), last: z.string().nullable() })

export function indexedLookup(db: Database): (sessionId: string) => AgentRow['indexed'] {
  const fee = new Map(listUsage(db, { by: 'session', limit: 100000 }).rows.map((r) => [r.key, r]))
  const meta = new Map(
    z
      .array(IndexedRow)
      .parse(
        db
          .prepare(
            `SELECT s.session_id AS sessionId, w.dir AS well, COALESCE(s.last_activity_ts, s.last_ts) AS last
             FROM sessions s JOIN wells w ON w.id = s.well_id`,
          )
          .all(),
      )
      .map((r) => [r.sessionId, r] as const),
  )
  return (sessionId) => {
    const m = meta.get(sessionId)
    if (!m) return null
    const f = fee.get(sessionId)
    return { well: m.well, requests: f?.requests ?? 0, output: f?.output ?? 0, listUsd: f?.listUsd ?? null, last: m.last }
  }
}

export async function listAgents(db: Database): Promise<AgentRow[]> {
  const listed = await listAgentsRaw()
  const states = new Map<string, JobState | null>()
  await Promise.all(listed.map(async (a) => a.id && states.set(a.id, await readJobState(a.id))))
  return joinAgents(listed, states, indexedLookup(db))
}
