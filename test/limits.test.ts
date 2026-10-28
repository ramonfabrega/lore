import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { readLimits } from '../src/limits'
import { parseLine } from '../src/parse'

// Verbatim shape of the refusal record an attrition lane wrote on
// 2026-10-20 12:44Z: a `<synthetic>` assistant message (no request behind it)
// with the window in `apiErrorParams.rate_limit_info`, `resetsAt` in unix
// seconds (1792839600 = 2026-10-24T11:00:00Z, Saturday 06:00 Panama).
function refusalLine(ts: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      id: 'synthetic-1',
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: "You've hit your weekly limit · resets Oct 24 at 6am (America/Panama)" }],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    requestId: 'req_x',
    apiError: 'usage_limit_reached',
    apiErrorParams: {
      rate_limit_info: { status: 'rejected', resetsAt: 1792839600, rateLimitType: 'seven_day', overageStatus: 'rejected', isUsingOverage: false },
    },
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
  })
}

function requestLine(ts: string, id: string, cacheRead: number, output: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      id,
      model: 'claude-opus-5-5',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: output },
    },
  })
}

describe('parseLine: a 429', () => {
  test('yields the window and its reset as an instant, and no request', () => {
    const p = parseLine(refusalLine('2026-10-20T12:44:13.996Z'))!
    expect(p.limit).toEqual({ kind: 'seven_day', resetsAt: '2026-10-24T11:00:00.000Z' })
    expect(p.request).toBeUndefined()
    // The refusal text still indexes (the text lane), as before.
    expect(p.entries.map((e) => e.lane)).toEqual(['text'])
  })
})

describe('limits: the table and the verb', () => {
  function seed(): { db: ReturnType<typeof openDb>; limitsPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'lore-limits-'))
    const projects = join(dir, 'projects')
    const well = join(projects, '-u-code-fun-app')
    mkdirSync(well, { recursive: true })
    // Three priced requests inside the week, then the refusal.
    writeFileSync(
      join(well, 'sess-1.jsonl'),
      [
        requestLine('2026-10-18T10:00:00Z', 'm1', 1_000_000, 10_000),
        requestLine('2026-10-19T10:00:00Z', 'm2', 1_000_000, 10_000),
        requestLine('2026-10-20T10:00:00Z', 'm3', 1_000_000, 10_000),
        refusalLine('2026-10-20T12:44:13.996Z'),
      ].join('\n'),
    )
    // The mod's log: two readings of the same window, 20 → 60, then a
    // five-hour reading, then a torn tail.
    const limitsPath = join(dir, 'limits.jsonl')
    writeFileSync(
      limitsPath,
      [
        '{"ts":"2026-10-18T12:00:00.000Z","session":"sess-1","kind":"seven_day","pct":20,"resetsAt":"2026-10-24T11:00:00.000Z"}',
        '{"ts":"2026-10-20T11:00:00.000Z","session":"sess-1","kind":"seven_day","pct":60,"resetsAt":"2026-10-24T11:00:00.000Z"}',
        '{"ts":"2026-10-20T11:00:00.000Z","session":"sess-1","kind":"five_hour","pct":3,"resetsAt":"2026-10-20T15:00:00.000Z"}',
        '{"ts":"2026-10-20T11:30',
      ].join('\n'),
    )
    const db = openDb(join(dir, 'lore.db'))
    return { db, limitsPath }
  }

  test('index: the 429 lands at 100 from the transcript, the mod lines from the log; a re-run does not duplicate', async () => {
    const { db, limitsPath } = seed()
    const projectsDir = join(limitsPath, '..', 'projects')
    const historyPath = join(limitsPath, '..', 'none.jsonl')
    const first = await buildIndex(db, { projectsDir, historyPath, limitsPath })
    expect(first.limitRows).toBe(4)
    const again = await buildIndex(db, { projectsDir, historyPath, limitsPath, full: true })
    expect(again.limitRows).toBe(4)
    const rows = db.prepare('SELECT source, kind, pct, resets_at FROM limits ORDER BY ts').all()
    expect(rows).toEqual([
      { source: 'mod', kind: 'seven_day', pct: 20, resets_at: '2026-10-24T11:00:00.000Z' },
      { source: 'mod', kind: 'seven_day', pct: 60, resets_at: '2026-10-24T11:00:00.000Z' },
      { source: 'mod', kind: 'five_hour', pct: 3, resets_at: '2026-10-20T15:00:00.000Z' },
      { source: 'transcript', kind: 'seven_day', pct: 100, resets_at: '2026-10-24T11:00:00.000Z' },
    ])
  })

  test('the verb: the window is anchored on resetsAt, usage is the ledger up to the reading, implied scales it', async () => {
    const { db, limitsPath } = seed()
    await buildIndex(db, { projectsDir: join(limitsPath, '..', 'projects'), historyPath: join(limitsPath, '..', 'none.jsonl'), limitsPath })
    const r = readLimits(db, { limit: 10 })
    expect(r.count).toBe(4)
    expect(r.windows.map((w) => w.kind)).toEqual(['seven_day', 'five_hour'])
    const week = r.windows[0]!
    // The latest reading of the week is the 429: 100, from the transcript.
    expect(week).toMatchObject({ pct: 100, source: 'transcript', from: '2026-10-17T11:00:00.000Z', until: '2026-10-24T11:00:00.000Z' })
    // All three requests sit inside [from, ts of the reading].
    expect(week.usage).toMatchObject({ requests: 3, cacheRead: 3_000_000, output: 30_000 })
    expect(week.implied).toEqual(week.usage)
    // Between the 20 and the 60 readings the ledger priced m2 and m3 (m1 is
    // before the first reading): that spend over 40 points.
    expect(week.usdPerPoint).not.toBeNull()
    expect(week.usdPerPoint!).toBeCloseTo((week.usage!.listUsd * (2 / 3)) / 40, 2)
    // Readings under 5% imply nothing: too noisy to scale.
    const five = r.windows[1]!
    expect(five).toMatchObject({ pct: 3, from: '2026-10-20T10:00:00.000Z', until: '2026-10-20T15:00:00.000Z' })
    expect(five.implied).toBeNull()
    expect(r.hits.map((h) => h.pct)).toEqual([100])
    expect(r.history.map((h) => h.pct)).toEqual([60, 3, 20])
  })

  test('a kind filter and an empty table are both answered plainly', async () => {
    const { db, limitsPath } = seed()
    expect(readLimits(db, { limit: 10 })).toMatchObject({ windows: [], hits: [], history: [], count: 0 })
    await buildIndex(db, { projectsDir: join(limitsPath, '..', 'projects'), historyPath: join(limitsPath, '..', 'none.jsonl'), limitsPath })
    const r = readLimits(db, { kind: 'five_hour', limit: 10 })
    expect(r.windows.map((w) => w.kind)).toEqual(['five_hour'])
    expect(r.count).toBe(1)
  })
})
