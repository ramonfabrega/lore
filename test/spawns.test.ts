import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { indexSpawns, listSpawns } from '../src/spawns'

function assistantLine(opts: {
  ts: string
  msgId: string
  model: string
  usage: { i: number; cc: number; cr: number; o: number }
  toolUse?: boolean
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.ts,
    message: {
      id: opts.msgId,
      model: opts.model,
      usage: {
        input_tokens: opts.usage.i,
        cache_creation_input_tokens: opts.usage.cc,
        cache_read_input_tokens: opts.usage.cr,
        output_tokens: opts.usage.o,
      },
      content: opts.toolUse ? [{ type: 'tool_use', name: 'Bash' }] : [{ type: 'text', text: 'hi' }],
    },
  })
}

// A well with one session and two spawns: a defined agent (no model param in
// meta, sonnet served) and an ad-hoc spawn whose requested model drifted.
function seedProjectsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-spawns-'))
  const sub = join(dir, '-u-code-fun-app--claude-worktrees-x', 'sess-1', 'subagents')
  mkdirSync(sub, { recursive: true })

  writeFileSync(join(sub, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'lore-miner', description: 'mine bucket', spawnDepth: 1 }))
  writeFileSync(
    join(sub, 'agent-abc.jsonl'),
    [
      JSON.stringify({ type: 'user', timestamp: '2026-07-17T10:00:00Z', message: { content: 'go' } }),
      // two streaming snapshots of one request — must count once, output = max
      assistantLine({ ts: '2026-07-17T10:00:05Z', msgId: 'm1', model: 'claude-sonnet-5', usage: { i: 2, cc: 30000, cr: 0, o: 7 } }),
      assistantLine({ ts: '2026-07-17T10:00:06Z', msgId: 'm1', model: 'claude-sonnet-5', usage: { i: 2, cc: 30000, cr: 0, o: 90 }, toolUse: true }),
      assistantLine({ ts: '2026-07-17T10:00:30Z', msgId: 'm2', model: 'claude-sonnet-5', usage: { i: 2, cc: 500, cr: 30000, o: 40 } }),
      '{"torn', // live-append tail — must not abort the file
    ].join('\n'),
  )

  writeFileSync(join(sub, 'agent-def.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'review', spawnDepth: 1, model: 'sonnet' }))
  writeFileSync(
    join(sub, 'agent-def.jsonl'),
    [assistantLine({ ts: '2026-07-17T11:00:00Z', msgId: 'm9', model: 'claude-fable-5', usage: { i: 2, cc: 40000, cr: 0, o: 10 } })].join('\n'),
  )
  return dir
}

describe('indexSpawns + listSpawns', () => {
  test('extracts verified model, boot envelope, deduped requests, tool uses; flags drift', async () => {
    const db = openDb(':memory:')
    const projectsDir = seedProjectsDir()
    const stats = await indexSpawns(db, { projectsDir })
    expect(stats.spawnFiles).toBe(2)
    expect(stats.spawnsIndexed).toBe(2)

    const { spawns, byAgentType } = listSpawns(db, { limit: 50 })
    expect(spawns.map((s) => s.agentId)).toEqual(['def', 'abc']) // newest first

    const miner = spawns.find((s) => s.agentId === 'abc')!
    expect(miner.well).toBe('-u-code-fun-app--claude-worktrees-x')
    expect(miner.sessionId).toBe('sess-1')
    expect(miner.agentType).toBe('lore-miner')
    expect(miner.model).toBe('claude-sonnet-5')
    expect(miner.requestedModel).toBeNull()
    expect(miner.drift).toBeUndefined() // no param passed → no drift verdict
    expect(miner.bootTokens).toBe(30002)
    expect(miner.requests).toBe(2)
    expect(miner.outputTokens).toBe(130) // max(7, 90) + 40, not 7+90+40
    expect(miner.toolUses).toBe(1)
    expect(miner.first).toBe('2026-07-17T10:00:00Z')
    expect(miner.durationMs).toBe(30_000)

    const adHoc = spawns.find((s) => s.agentId === 'def')!
    expect(adHoc.requestedModel).toBe('sonnet')
    expect(adHoc.model).toBe('claude-fable-5')
    expect(adHoc.drift).toBe(true) // asked sonnet, served fable

    const minerSummary = byAgentType.find((r) => r.agentType === 'lore-miner')!
    expect(minerSummary.n).toBe(1)
    expect(minerSummary.avgBoot).toBe(30002)
    expect(minerSummary.models).toBe('claude-sonnet-5')
  })

  test('incremental skip by size+mtime; --full reindexes', async () => {
    const db = openDb(':memory:')
    const projectsDir = seedProjectsDir()
    await indexSpawns(db, { projectsDir })
    const again = await indexSpawns(db, { projectsDir })
    expect(again.spawnsSkipped).toBe(2)
    expect(again.spawnsIndexed).toBe(0)

    // touch one file → only it reindexes
    const touched = join(projectsDir, '-u-code-fun-app--claude-worktrees-x', 'sess-1', 'subagents', 'agent-abc.jsonl')
    utimesSync(touched, new Date(), new Date('2027-01-01'))
    const after = await indexSpawns(db, { projectsDir })
    expect(after.spawnsIndexed).toBe(1)
    expect(after.spawnsSkipped).toBe(1)

    const full = await indexSpawns(db, { projectsDir, full: true })
    expect(full.spawnsIndexed).toBe(2)
  })

  test('filters: agentType, since, well exact vs substring', async () => {
    const db = openDb(':memory:')
    await indexSpawns(db, { projectsDir: seedProjectsDir() })

    expect(listSpawns(db, { agent: 'lore-miner', limit: 50 }).spawns.map((s) => s.agentId)).toEqual(['abc'])
    expect(listSpawns(db, { since: '2026-07-17T10:30:00Z', limit: 50 }).spawns.map((s) => s.agentId)).toEqual(['def'])
    expect(listSpawns(db, { well: 'fun-app', limit: 50 }).spawns).toHaveLength(2)
    expect(listSpawns(db, { well: 'fun-app', exact: true, limit: 50 }).spawns).toHaveLength(0)
    expect(listSpawns(db, { well: '-u-code-fun-app--claude-worktrees-x', exact: true, limit: 50 }).spawns).toHaveLength(2)
  })

  test('missing projects dir and empty db are safe', async () => {
    const db = openDb(':memory:')
    const stats = await indexSpawns(db, { projectsDir: '/nonexistent/nowhere' })
    expect(stats.spawnFiles).toBe(0)
    expect(listSpawns(db, { limit: 10 }).spawns).toEqual([])
  })
})
