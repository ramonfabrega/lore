import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { parseLine } from '../src/parse'
import { listUsage, rateFor } from '../src/usage'

// The real shape, from an attrition grind transcript (2026-09-01): assistant
// records are streaming snapshots — two lines per request sharing message.id,
// identical usage — with `effort` at the record's top level and thinking as a
// sub-count of output.
function assistantLine(opts: {
  ts: string
  id: string
  model: string
  input?: number
  cacheWrite: number
  cacheRead: number
  output: number
  thinking?: number
  stop?: string
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.ts,
    effort: 'high',
    message: {
      id: opts.id,
      model: opts.model,
      role: 'assistant',
      stop_reason: opts.stop ?? 'tool_use',
      content: [{ type: 'text', text: 'working' }],
      usage: {
        input_tokens: opts.input ?? 2,
        cache_creation_input_tokens: opts.cacheWrite,
        cache_read_input_tokens: opts.cacheRead,
        output_tokens: opts.output,
        output_tokens_details: { thinking_tokens: opts.thinking ?? 0 },
      },
    },
  })
}

describe('parseLine: request envelope', () => {
  test('an assistant record with id + usage yields a request', () => {
    const p = parseLine(
      assistantLine({ ts: '2026-09-01T10:00:00Z', id: 'msg_1', model: 'claude-opus-5', cacheWrite: 100, cacheRead: 5000, output: 40, thinking: 10 }),
    )!
    expect(p.request).toEqual({
      id: 'msg_1',
      model: 'claude-opus-5',
      effort: 'high',
      stopReason: 'tool_use',
      input: 2,
      cacheWrite: 100,
      cacheRead: 5000,
      output: 40,
      thinking: 10,
    })
  })

  test('a <synthetic> harness record is not a request', () => {
    const p = parseLine(
      assistantLine({ ts: '2026-09-01T10:00:00Z', id: 'msg_s', model: '<synthetic>', cacheWrite: 0, cacheRead: 0, output: 0 }),
    )!
    expect(p.request).toBeUndefined()
  })

  test('an assistant record without usage yields no request', () => {
    const p = parseLine(JSON.stringify({ type: 'assistant', message: { id: 'x', content: [{ type: 'text', text: 'hi' }] } }))!
    expect(p.request).toBeUndefined()
    expect(p.entries.length).toBe(1)
  })
})

function seedWell(files: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-usage-'))
  const well = join(dir, '-u-code-fun-app')
  mkdirSync(well, { recursive: true })
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(well, `${name}.jsonl`), `${lines.join('\n')}\n`)
  return dir
}

const ReqRow = z.object({ message_id: z.string(), output_tokens: z.number(), cache_read_tokens: z.number(), ts: z.string() })

describe('buildIndex: requests', () => {
  test('streaming snapshots dedupe by message id, keeping the max per field and the first ts', async () => {
    const db = openDb(':memory:')
    const projectsDir = seedWell({
      s1: [
        assistantLine({ ts: '2026-09-01T10:00:00Z', id: 'msg_a', model: 'claude-opus-5', cacheWrite: 100, cacheRead: 5000, output: 40 }),
        assistantLine({ ts: '2026-09-01T10:00:01Z', id: 'msg_a', model: 'claude-opus-5', cacheWrite: 100, cacheRead: 5000, output: 40 }),
        assistantLine({ ts: '2026-09-01T10:01:00Z', id: 'msg_b', model: 'claude-opus-5', cacheWrite: 10, cacheRead: 6000, output: 300, stop: 'end_turn' }),
      ],
    })
    await buildIndex(db, { projectsDir, historyPath: join(projectsDir, 'nope.jsonl') })
    const rows = z.array(ReqRow).parse(db.prepare('SELECT message_id, output_tokens, cache_read_tokens, ts FROM requests ORDER BY ts').all())
    expect(rows).toEqual([
      { message_id: 'msg_a', output_tokens: 40, cache_read_tokens: 5000, ts: '2026-09-01T10:00:00Z' },
      { message_id: 'msg_b', output_tokens: 300, cache_read_tokens: 6000, ts: '2026-09-01T10:01:00Z' },
    ])
  })
})

describe('rateFor', () => {
  test('longest prefix wins and the rate is dated', () => {
    expect(rateFor('claude-fable-5-1', '2026-09-02')?.cacheRead).toBe(0.25)
    expect(rateFor('claude-fable-5', '2026-08-20')?.cacheRead).toBe(1)
    expect(rateFor('claude-opus-5', '2026-09-01')?.output).toBe(25)
    expect(rateFor('claude-sonnet-4-6', '2026-09-01')?.input).toBe(3)
    expect(rateFor('claude-unknown-9', '2026-09-01')).toBeNull()
    expect(rateFor(null, '2026-09-01')).toBeNull()
  })
})

function seedDb() {
  const db = openDb(':memory:')
  db.exec(`
    INSERT INTO wells(id, dir, real_path) VALUES (1, '-u-code-a', '/u/code/a'), (2, '-u-code-b', '/u/code/b');
    INSERT INTO sessions(well_id, session_id, size, mtime_ms, first_ts) VALUES
      (1, 's1', 0, 0, '2026-08-30T10:00:00Z'), (1, 's2', 0, 0, '2026-09-01T10:00:00Z'), (2, 's3', 0, 0, '2026-09-01T12:00:00Z');
    INSERT INTO requests(session_id, message_id, ts, model, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, thinking_tokens) VALUES
      ('s1', 'm1', '2026-08-30T10:00:00Z', 'claude-opus-5', 0, 0, 1000000, 1000, 100),
      ('s1', 'm2', '2026-08-30T11:00:00Z', 'claude-opus-5', 0, 0, 1000000, 1000, 0),
      ('s2', 'm3', '2026-09-01T10:00:00Z', 'claude-fable-5-1', 0, 0, 4000000, 2000, 500),
      ('s3', 'm4', '2026-09-01T12:00:00Z', 'claude-mystery-1', 0, 0, 10, 10, 0);
    INSERT INTO spawns(well_dir, session_id, agent_id, output_tokens, size, mtime_ms) VALUES
      ('-u-code-a', 's2', 'ag1', 5000, 0, 0);
  `)
  return db
}

describe('listUsage', () => {
  test('by well: sums, distinct sessions, dated pricing, spawn join, unpriced flag', () => {
    const r = listUsage(seedDb(), { by: 'well', limit: 10 })
    expect(r.rows.map((x) => x.key)).toEqual(['-u-code-a', '-u-code-b'])
    const a = r.rows[0]!
    expect(a.requests).toBe(3)
    expect(a.sessions).toBe(2)
    expect(a.cacheRead).toBe(6_000_000)
    expect(a.output).toBe(4000)
    expect(a.thinking).toBe(600)
    // opus: 2M cache-read × $0.5/M + 2k out × $25/M = 1.00 + 0.05; fable 5.1: 4M × $0.25/M + 2k × $50/M = 1.00 + 0.10
    expect(a.listUsd).toBe(2.15)
    expect(a.spawns).toBe(1)
    expect(a.spawnOutput).toBe(5000)
    const b = r.rows[1]!
    expect(b.listUsd).toBeNull()
    expect(r.unpriced).toEqual(['claude-mystery-1'])
    expect(r.totals.requests).toBe(4)
    expect(r.totals.sessions).toBe(3)
    expect(r.totals.listUsd).toBeNull()
  })

  test('by session carries well + first, and --session narrows by prefix', () => {
    const r = listUsage(seedDb(), { by: 'session', session: 's2', limit: 10 })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ key: 's2', well: '-u-code-a', first: '2026-09-01', listUsd: 1.1, spawnOutput: 5000 })
  })

  test('time groupings sort ascending and page from the newest end', () => {
    const r = listUsage(seedDb(), { by: 'day', limit: 1 })
    expect(r.rows.map((x) => x.key)).toEqual(['2026-09-01'])
    expect(r.totals.requests).toBe(4)
    const all = listUsage(seedDb(), { by: 'day', limit: 10 })
    expect(all.rows.map((x) => x.key)).toEqual(['2026-08-30', '2026-09-01'])
    const month = listUsage(seedDb(), { by: 'month', model: 'opus', limit: 10 })
    expect(month.rows).toEqual([
      expect.objectContaining({ key: '2026-08', requests: 2, listUsd: 1.05 }),
    ])
  })
})
