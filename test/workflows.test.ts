import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { indexSpawns, listSpawns } from '../src/spawns'
import { extractMeta, indexWorkflowRuns, listWorkflowRuns } from '../src/workflows'

const SCRIPT = `export const meta = {
  name: 'storefront-review',
  description: 'Multi-agent audit: finders, refute, rank',
  phases: [
    { title: 'Find', detail: 'finders with {braces} in the detail' },
    { title: 'Refute' },
  ],
}
const ROOT = 'apps/storefront'
phase('Find')
`

function assistantLine(opts: { ts: string; msgId: string; model: string; usage: { i: number; cc: number; cr: number; o: number } }): string {
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
      content: [{ type: 'text', text: 'hi' }],
    },
  })
}

// A well with one session holding a workflow run: the run json under
// <session>/workflows/, two orchestrated agents under
// <session>/subagents/workflows/wf_run1/ (one of them drifted), and one
// direct (non-workflow) spawn that must stay untagged.
function seedProjectsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-workflows-'))
  const sess = join(dir, '-u-code-work-shop', 'sess-1')
  const runDir = join(sess, 'subagents', 'workflows', 'wf_run1')
  mkdirSync(join(sess, 'workflows'), { recursive: true })
  mkdirSync(runDir, { recursive: true })

  writeFileSync(
    join(sess, 'workflows', 'wf_run1.json'),
    JSON.stringify({ runId: 'wf_run1', timestamp: '2026-07-18T04:46:45Z', taskId: 'task-9', script: SCRIPT }),
  )

  writeFileSync(join(runDir, 'agent-w1.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1, model: 'sonnet' }))
  writeFileSync(
    join(runDir, 'agent-w1.jsonl'),
    [
      assistantLine({ ts: '2026-07-18T04:40:00Z', msgId: 'm1', model: 'claude-sonnet-5', usage: { i: 2, cc: 20000, cr: 0, o: 50 } }),
      assistantLine({ ts: '2026-07-18T04:41:00Z', msgId: 'm2', model: 'claude-sonnet-5', usage: { i: 2, cc: 100, cr: 20000, o: 30 } }),
    ].join('\n'),
  )
  writeFileSync(join(runDir, 'agent-w2.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1, model: 'sonnet' }))
  writeFileSync(
    join(runDir, 'agent-w2.jsonl'),
    [assistantLine({ ts: '2026-07-18T04:42:00Z', msgId: 'm3', model: 'claude-fable-5', usage: { i: 2, cc: 10000, cr: 0, o: 20 } })].join('\n'),
  )

  const sub = join(sess, 'subagents')
  writeFileSync(join(sub, 'agent-plain.meta.json'), JSON.stringify({ agentType: 'general-purpose', spawnDepth: 1 }))
  writeFileSync(
    join(sub, 'agent-plain.jsonl'),
    [assistantLine({ ts: '2026-07-18T05:00:00Z', msgId: 'm4', model: 'claude-fable-5', usage: { i: 2, cc: 5000, cr: 0, o: 10 } })].join('\n'),
  )
  return dir
}

describe('extractMeta', () => {
  test('pulls name, description, phases from the meta literal', () => {
    const meta = extractMeta(SCRIPT)
    expect(meta.name).toBe('storefront-review')
    expect(meta.description).toBe('Multi-agent audit: finders, refute, rank')
    expect(meta.phases).toEqual([
      { title: 'Find', detail: 'finders with {braces} in the detail' },
      { title: 'Refute' },
    ])
  })

  test('name/description never read from inside phases', () => {
    const meta = extractMeta(`export const meta = {
      phases: [{ title: 'X', detail: "name: 'decoy'" }],
      name: 'real-name',
      description: 'real description',
    }`)
    expect(meta.name).toBe('real-name')
    expect(meta.description).toBe('real description')
    expect(meta.phases).toEqual([{ title: 'X', detail: "name: 'decoy'" }])
  })

  test('degrades to nulls on a script without meta', () => {
    expect(extractMeta('phase("Go")')).toEqual({ name: null, description: null, phases: [] })
  })
})

describe('indexWorkflowRuns + listWorkflowRuns', () => {
  test('one row per run with spawn-joined totals, model mix, drift', async () => {
    const db = openDb(':memory:')
    const projectsDir = seedProjectsDir()
    await indexSpawns(db, { projectsDir })
    const stats = await indexWorkflowRuns(db, { projectsDir })
    expect(stats.runFiles).toBe(1)
    expect(stats.runsIndexed).toBe(1)

    const { runs, byName } = listWorkflowRuns(db, { limit: 25 })
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    expect(run.runId).toBe('wf_run1')
    expect(run.well).toBe('-u-code-work-shop')
    expect(run.sessionId).toBe('sess-1')
    expect(run.name).toBe('storefront-review')
    expect(run.taskId).toBe('task-9')
    // phases render as flat strings so the md table formatter can't turn them
    // into [object Object] — the whole point of the lane is that the phase list
    // is readable in the format agents actually read.
    expect(run.phases).toEqual(['Find — finders with {braces} in the detail', 'Refute'])
    expect(run.phases.every((p) => typeof p === 'string')).toBe(true)
    expect(run.agents).toBe(2) // the direct spawn is not part of the run
    expect(run.outputTokens).toBe(100) // (50+30) + 20
    expect(run.bootTokens).toBe(30004) // 20002 + 10002 (first-request envelopes)
    expect(run.models).toContain('claude-sonnet-5')
    expect(run.models).toContain('claude-fable-5')
    expect(run.drift).toBe(1) // w2 asked sonnet, served fable
    expect(run.first).toBe('2026-07-18T04:40:00Z')
    expect(run.durationMs).toBe(120_000)

    expect(byName).toEqual([
      { name: 'storefront-review', n: 1, avgAgents: 2, avgOutputTokens: 100, bootReusePct: 0 },
    ])
  })

  test('workflow agents index as spawns tagged with the run id; --workflow filters by prefix', async () => {
    const db = openDb(':memory:')
    await indexSpawns(db, { projectsDir: seedProjectsDir() })

    const all = listSpawns(db, { limit: 50 }).spawns
    expect(all).toHaveLength(3)
    expect(all.find((s) => s.agentId === 'plain')!.workflowRunId).toBeNull()
    expect(all.find((s) => s.agentId === 'w1')!.workflowRunId).toBe('wf_run1')

    const inRun = listSpawns(db, { workflow: 'wf_run', limit: 50 }).spawns
    expect(inRun.map((s) => s.agentId).sort()).toEqual(['w1', 'w2'])
  })

  test('incremental skip by size+mtime; --full reindexes', async () => {
    const db = openDb(':memory:')
    const projectsDir = seedProjectsDir()
    await indexWorkflowRuns(db, { projectsDir })
    const again = await indexWorkflowRuns(db, { projectsDir })
    expect(again.runsSkipped).toBe(1)
    expect(again.runsIndexed).toBe(0)

    utimesSync(join(projectsDir, '-u-code-work-shop', 'sess-1', 'workflows', 'wf_run1.json'), new Date(), new Date('2027-01-01'))
    expect((await indexWorkflowRuns(db, { projectsDir })).runsIndexed).toBe(1)
    expect((await indexWorkflowRuns(db, { projectsDir, full: true })).runsIndexed).toBe(1)
  })

  test('filters: name, well, since', async () => {
    const db = openDb(':memory:')
    const projectsDir = seedProjectsDir()
    await indexSpawns(db, { projectsDir })
    await indexWorkflowRuns(db, { projectsDir })

    expect(listWorkflowRuns(db, { name: 'storefront', limit: 25 }).runs).toHaveLength(1)
    expect(listWorkflowRuns(db, { name: 'nope', limit: 25 }).runs).toHaveLength(0)
    expect(listWorkflowRuns(db, { well: 'work-shop', limit: 25 }).runs).toHaveLength(1)
    expect(listWorkflowRuns(db, { well: 'work-shop', exact: true, limit: 25 }).runs).toHaveLength(0)
    expect(listWorkflowRuns(db, { since: '2026-07-19', limit: 25 }).runs).toHaveLength(0)
    // the rollup respects filters too
    expect(listWorkflowRuns(db, { name: 'nope', limit: 25 }).byName).toHaveLength(0)
  })

  test('missing projects dir and empty db are safe', async () => {
    const db = openDb(':memory:')
    const stats = await indexWorkflowRuns(db, { projectsDir: '/nonexistent/nowhere' })
    expect(stats.runFiles).toBe(0)
    expect(listWorkflowRuns(db, { limit: 10 }).runs).toEqual([])
  })
})
