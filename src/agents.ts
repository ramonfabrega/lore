import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { CLAUDE_DIR, PROJECTS_DIR } from './config'
import { dominantModel } from './model'
import { listUsage } from './usage'
import { slugWellDir } from './wells'

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
  // What is running this conversation (model.ts), and how we know.
  model: string | null
  modelSource: 'transcript' | 'index' | null
  // lore's side — null when the session is not indexed yet
  indexed: {
    well: string
    requests: number
    output: number
    listUsd: number | null
    last: string | null
    models: { model: string; requests: number }[]
  } | null
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

// Order of attention, not of time: working, then blocked (needs input),
// then failed (crashed), then stopped (someone killed it — not the same as
// finishing), then done (finished on its own), then anything unknown.
// Within a group, most recently updated first.
const STATE_RANK: Record<string, number> = { working: 0, blocked: 1, failed: 2, stopped: 3, done: 4 }
const rank = (s: string) => STATE_RANK[s] ?? 5

export function joinAgents(
  listed: ListedAgent[],
  states: Map<string, JobState | null>,
  lookup: (sessionId: string) => AgentRow['indexed'],
): AgentRow[] {
  const rows = listed.map((a): AgentRow => {
    const st = a.id ? (states.get(a.id) ?? null) : null
    const sessionId = a.sessionId ?? st?.sessionId ?? null
    const indexed = sessionId ? lookup(sessionId) : null
    const model = dominantModel(indexed?.models)
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
      model,
      modelSource: model ? 'index' : null,
      indexed,
    }
  })
  rows.sort((x, y) => rank(x.state) - rank(y.state) || (y.updatedAt ?? y.startedAt).localeCompare(x.updatedAt ?? x.startedAt))
  return rows
}

const IndexedRow = z.object({ sessionId: z.string(), well: z.string(), last: z.string().nullable() })

export function indexedLookup(db: Database): (sessionId: string) => AgentRow['indexed'] {
  // `split` costs nothing here — the same (key, model, day) cells the fee is
  // already folded from carry the model mix.
  const fee = new Map(listUsage(db, { by: 'session', limit: 100000, split: true }).rows.map((r) => [r.key, r]))
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
    return {
      well: m.well,
      requests: f?.requests ?? 0,
      output: f?.output ?? 0,
      listUsd: f?.listUsd ?? null,
      last: m.last,
      models: (f?.models ?? []).map((x) => ({ model: x.model, requests: x.requests })),
    }
  }
}

export async function listAgents(db: Database): Promise<AgentRow[]> {
  const listed = await listAgentsRaw()
  const states = new Map<string, JobState | null>()
  await Promise.all(listed.map(async (a) => a.id && states.set(a.id, await readJobState(a.id))))
  const rows = joinAgents(listed, states, indexedLookup(db))
  await verifyModels(rows)
  return rows
}

// The last model a transcript actually served, read from its tail. Records
// are one JSON object per line; the last one is what is running now. The
// first line of a byte-slice is a fragment, so it is dropped, and a tail
// that holds no assistant record answers null rather than a guess — the
// caller falls back to the index and says so.
export async function verifyModel(path: string, bytes = 256 * 1024): Promise<string | null> {
  const f = Bun.file(path)
  const size = f.size
  if (!size) return null
  const text = await (size > bytes ? f.slice(size - bytes) : f).text()
  const lines = text.split('\n')
  const from = size > bytes ? 1 : 0
  for (let i = lines.length - 1; i >= from; i--) {
    const line = lines[i]
    if (!line || !line.includes('"model"')) continue
    try {
      const rec = JSON.parse(line) as { type?: string; message?: { model?: string } }
      if (rec.type === 'assistant' && typeof rec.message?.model === 'string') return rec.message.model
    } catch {
      // a truncated or non-record line — keep walking back
    }
  }
  return null
}

// Verify the LIVE rows only. A finished agent's model is settled and the
// index already holds it; a working or blocked one is exactly where the
// index lags, and it is the row a person is reading.
export async function verifyModels(rows: AgentRow[]): Promise<void> {
  await Promise.all(
    rows.map(async (r) => {
      if (r.state !== 'working' && r.state !== 'blocked') return
      if (!r.sessionId) return
      // Two candidate wells. Worktree entry MOVES the transcript file
      // retroactively — the whole file, pre-entry records included, ends up
      // in the worktree well with nothing left in the parent (confirmed
      // 2026-09-02 across two sessions: 5a57a968 and 57084123). So the
      // agent's CURRENT cwd is the likely holder and is tried first; the
      // indexed well is the fallback, since it is only as fresh as the last
      // `lore index`. Take whichever exists.
      const path = [slugWellDir(r.cwd), r.indexed?.well]
        .filter((w): w is string => !!w)
        .map((w) => join(PROJECTS_DIR, w, `${r.sessionId}.jsonl`))
        .find((p) => existsSync(p))
      if (!path) return
      const model = await verifyModel(path)
      if (model) {
        r.model = model
        r.modelSource = 'transcript'
      }
    }),
  )
}
