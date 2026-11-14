import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { indexSpawns } from '../src/spawns'
import { priceOf, rateFor } from '../src/usage'

// The corpus the subagent-ledger tests share (spawn-requests.test.ts,
// all-in.test.ts): one well, one main session served by Opus, and three
// subagent files under it — a Sonnet miner (two streaming snapshots of one
// request, a second request, then one past the narrow window), a Fable
// spawn, and a workflow agent. The limits mod read the week at 10 then 50.

export type Tok = { i?: number; cw?: number; cw1h?: number; cr?: number; o?: number; th?: number }
export function assistant(ts: string, id: string, model: string, t: Tok, stop: string | null = 'end_turn'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      id,
      model,
      role: 'assistant',
      stop_reason: stop,
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: t.i ?? 0,
        cache_creation_input_tokens: t.cw ?? 0,
        ...(t.cw1h != null ? { cache_creation: { ephemeral_5m_input_tokens: (t.cw ?? 0) - t.cw1h, ephemeral_1h_input_tokens: t.cw1h } } : {}),
        cache_read_input_tokens: t.cr ?? 0,
        output_tokens: t.o ?? 0,
        output_tokens_details: { thinking_tokens: t.th ?? 0 },
      },
    },
  })
}

export const OPUS = 'claude-opus-5-5'
export const SONNET = 'claude-sonnet-5'
export const FABLE = 'claude-fable-5-2'
export const WEEK_END = '2026-11-14T11:00:00.000Z'
export const NOW = '2026-11-14T10:00:00.000Z'
export const WELL = '-u-code-fun-app'

export function corpus(): { dir: string; projects: string; limitsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lore-spawn-requests-'))
  const projects = join(dir, 'projects')
  const well = join(projects, WELL)
  const sub = join(well, 'sess-9', 'subagents')
  mkdirSync(join(sub, 'workflows', 'wf_run1'), { recursive: true })
  writeFileSync(
    join(well, 'sess-9.jsonl'),
    [
      assistant('2026-11-13T20:00:00Z', 'main-0', OPUS, { i: 10, cr: 1_000_000, o: 10_000 }),
      assistant('2026-11-13T21:00:00Z', 'main-1', OPUS, { i: 10, cr: 1_000_000, o: 10_000 }),
      assistant('2026-11-14T08:00:00Z', 'main-2', OPUS, { i: 10, cr: 1_000_000, o: 10_000 }),
    ].join('\n'),
  )
  writeFileSync(join(sub, 'agent-miner.meta.json'), JSON.stringify({ agentType: 'lore-miner' }))
  writeFileSync(
    join(sub, 'agent-miner.jsonl'),
    [
      JSON.stringify({ type: 'user', timestamp: '2026-11-13T21:30:00Z', message: { content: 'go' } }),
      // Two snapshots of one request: counted once, each field its max.
      assistant('2026-11-13T21:30:05Z', 's-1', SONNET, { i: 2, cw: 100_000, cw1h: 100_000, o: 5 }, null),
      assistant('2026-11-13T21:30:06Z', 's-1', SONNET, { i: 2, cw: 100_000, cw1h: 100_000, o: 500 }, 'tool_use'),
      assistant('2026-11-13T22:00:00Z', 's-2', SONNET, { i: 2, cw: 1_000, cw1h: 1_000, cr: 4_000_000, o: 3_000, th: 200 }),
      // After the last reading and past the until of the narrow window.
      assistant('2026-11-14T09:30:00Z', 's-3', SONNET, { i: 2, cr: 4_000_000, o: 3_000 }),
    ].join('\n'),
  )
  writeFileSync(
    join(sub, 'agent-fable.jsonl'),
    [assistant('2026-11-13T23:00:00Z', 'f-1', FABLE, { i: 5, cw: 50_000, cw1h: 50_000, cr: 2_000_000, o: 20_000 })].join('\n'),
  )
  writeFileSync(
    join(sub, 'workflows', 'wf_run1', 'agent-wf.jsonl'),
    [assistant('2026-11-14T01:00:00Z', 'w-1', SONNET, { i: 1, cr: 1_000_000, o: 1_000 })].join('\n'),
  )
  const limitsPath = join(dir, 'limits.jsonl')
  const at = (ts: string, kind: string, pct: number) => JSON.stringify({ ts, session: 'sess-9', kind, pct, resetsAt: WEEK_END })
  writeFileSync(
    limitsPath,
    [
      at('2026-11-13T20:30:00.000Z', 'seven_day', 10),
      at('2026-11-13T20:30:00.000Z', 'seven_day_fable', 10),
      at('2026-11-14T09:00:00.000Z', 'seven_day', 50),
      at('2026-11-14T09:00:00.000Z', 'seven_day_fable', 30),
    ].join('\n'),
  )
  return { dir, projects, limitsPath }
}

export async function seed() {
  const c = corpus()
  const db = openDb(join(c.dir, 'lore.db'))
  await buildIndex(db, { projectsDir: c.projects, historyPath: join(c.dir, 'none.jsonl'), limitsPath: c.limitsPath })
  await indexSpawns(db, { projectsDir: c.projects })
  return { db, ...c }
}

// Each request's list price, unrounded, the way the ledger computes it.
export const usd = (model: string, day: string, t: Tok) => {
  const p = priceOf({ input: t.i ?? 0, cacheWrite: t.cw ?? 0, cacheWrite1h: t.cw1h ?? 0, cacheRead: t.cr ?? 0, output: t.o ?? 0 }, rateFor(model, day)!)
  return p.input + p.cacheWrite + p.cacheRead + p.output
}
export const r2 = (n: number) => Math.round(n * 100) / 100
export const MAIN = usd(OPUS, '2026-11-13', { i: 10, cr: 1_000_000, o: 10_000 })
export const S1 = usd(SONNET, '2026-11-13', { i: 2, cw: 100_000, cw1h: 100_000, o: 500 })
export const S2 = usd(SONNET, '2026-11-13', { i: 2, cw: 1_000, cw1h: 1_000, cr: 4_000_000, o: 3_000 })
export const S3 = usd(SONNET, '2026-11-14', { i: 2, cr: 4_000_000, o: 3_000 })
export const F1 = usd(FABLE, '2026-11-13', { i: 5, cw: 50_000, cw1h: 50_000, cr: 2_000_000, o: 20_000 })
export const W1 = usd(SONNET, '2026-11-14', { i: 1, cr: 1_000_000, o: 1_000 })
