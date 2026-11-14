import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ASK_TOOL } from '../src/codex'
import { indexCodex, listCodexSessions, searchCodex } from '../src/codexindex'
import { openDb } from '../src/db'
import { searchMessages } from '../src/search'
import { listSessions } from '../src/sessions'
import { listUsage } from '../src/usage'
import { day } from '../src/fmt'

// The Codex adapter's index half (src/codexindex.ts): a hand-authored Codex
// home — one worker that asked a question, the guardian that judged it, a
// guardian that never ran, and an import of a Claude Code transcript — beside
// a hand-inserted Claude session, so every test can ask the question that
// matters: did anything Claude's change?

const WORKER = '01a07f58-0000-7000-8000-000000000001'
const JUDGE = '01a07f58-0000-7000-8000-000000000002'
const IDLE = '01a07f58-0000-7000-8000-000000000003'
const IMPORTED = '019e2481-8d86-7d80-94eb-2f8c9c386822'
const LIAR = '01a07f58-0000-7000-8000-000000000009'
const EVIDENCE = 'zebrafish transcript re-embedded as evidence'

const lines = (records: [string, unknown, string?][]) => `${records.map(([type, payload, ts], i) => JSON.stringify({ type, timestamp: ts ?? `2026-09-08T04:48:${String(11 + i).padStart(2, '0')}.000Z`, ordinal: i, payload })).join('\n')}\n`
const meta = (over: Record<string, unknown>) => ({ id: WORKER, session_id: WORKER, thread_source: 'user', originator: 'Codex Desktop', cli_version: '0.153.4', source: 'vscode', cwd: '/Users/u/.codex/worktrees/1991/shop', timestamp: '2026-09-08T04:48:11.000Z', git: { repository_url: 'git@github.com:u/shop.git', commit_hash: 'abc', branch: 'codex/refunds' }, ...over })
const said = (text: string) => ['response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] }] as [string, unknown]
const usage = (input: number, cached: number, output: number, reasoning = 0) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output })
const reply = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify([ASK_TOOL, 'call_q', 0]), question: 'Deploy now?', answer: 'staging first please' }])}\n</send_user_message_question_reply>`
const verdict = JSON.stringify({ outcome: 'allow', risk_level: 'low', user_authorization: 'high', rationale: 'a read-only command' })

const worker = lines([
  ['session_meta', meta({})],
  ['event_msg', { type: 'task_started', turn_id: 't1' }],
  ['turn_context', { turn_id: 't1', model: 'gpt-6-astra', effort: 'high' }],
  ['response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>walrus plugin</recommended_plugins>' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['plugins.recommendations'] } }],
  ['event_msg', { type: 'item_completed', turn_id: 't1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'add a refund button to the checkout' }] } }],
  ['response_item', { type: 'reasoning', encrypted_content: 'opaque', summary: [{ type: 'summary_text', text: '**Reading the checkout controller**' }] }],
  ['response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'call_1', input: 'await run("rg refund")', status: 'completed' }],
  ['response_item', { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'app/checkout.rb' }] }],
  ['response_item', { type: 'function_call', name: ASK_TOOL, call_id: 'call_q', arguments: JSON.stringify({ questions: [{ title: 'Deploy now?', options: ['Yes', 'Wait'] }] }) }],
  ['response_item', { type: 'function_call_output', call_id: 'call_q', output: '{"accepted":true}' }],
  said('the button is in; one question pending'),
  ['token_usage_record', { response_id: 'resp_1', turn_id: 't1', usage: usage(100_000, 99_000, 500, 200) }],
  ['event_msg', { type: 'task_complete', turn_id: 't1', duration_ms: 9000, last_agent_message: 'the button is in; one question pending' }],
  ['event_msg', { type: 'task_started', turn_id: 't2' }],
  ['event_msg', { type: 'item_completed', turn_id: 't2', item: { type: 'UserMessage', id: 'u2', content: [{ type: 'text', text: reply }] } }],
  said('deploying to staging'),
  ['token_usage_record', { response_id: 'resp_2', turn_id: 't2', usage: usage(2000, 0, 40) }],
  ['event_msg', { type: 'task_complete', turn_id: 't2', duration_ms: 2000, last_agent_message: 'deploying to staging' }],
])
const judge = lines([
  ['session_meta', meta({ id: JUDGE, parent_thread_id: WORKER, thread_source: 'guardian_review', source: { subagent: { other: 'guardian' } }, timestamp: '2026-09-08T04:50:00.000Z' })],
  ['event_msg', { type: 'task_started', turn_id: 'g1' }],
  ['turn_context', { turn_id: 'g1', model: 'codex-auto-review', effort: 'low' }],
  ['response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: EVIDENCE }, { type: 'input_text', text: 'add a refund button to the checkout' }] }],
  ['event_msg', { type: 'item_completed', turn_id: 'g1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: EVIDENCE }, { type: 'text', text: 'add a refund button to the checkout' }] } }],
  said(verdict),
  ['token_usage_record', { response_id: 'resp_g', turn_id: 'g1', usage: usage(50_000, 40_000, 80, 30) }],
  ['event_msg', { type: 'task_complete', turn_id: 'g1', duration_ms: 3000, last_agent_message: verdict }],
])
const idle = lines([
  ['session_meta', meta({ id: IDLE, parent_thread_id: WORKER, thread_source: 'guardian_review', source: { subagent: { other: 'guardian' } }, timestamp: '2026-09-08T15:00:00.000Z' })],
  ['event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'codex-auto-review' } }],
])

function codexHome() {
  const home = mkdtempSync(join(tmpdir(), 'lore-codexindex-'))
  const put = (rel: string, name: string, body: string | Uint8Array) => {
    mkdirSync(join(home, rel), { recursive: true })
    writeFileSync(join(home, rel, name), body)
    return join(home, rel, name)
  }
  writeFileSync(join(home, 'external_agent_session_imports.json'), JSON.stringify({ records: [{ source_path: '/Users/u/.claude/projects/-x/a.jsonl', imported_thread_id: IMPORTED }] }))
  // Minted at 23:48 local on the 7th: the path says the 7th, the records the 8th.
  const workerPath = put('sessions/2026/09/07', `rollout-2026-09-07T23-48-11-${WORKER}.jsonl`, worker)
  put('sessions/2026/09/07', `rollout-2026-09-07T23-50-00-${JUDGE}.jsonl.zst`, Bun.zstdCompressSync(judge))
  put('archived_sessions', `rollout-2026-09-08T10-00-00-${IDLE}.jsonl.zst`, Bun.zstdCompressSync(idle))
  put('sessions/2026/05/13', `rollout-2026-05-13T22-22-10-${IMPORTED}.jsonl`, lines([['session_meta', meta({ id: IMPORTED })], ['event_msg', { type: 'task_started', turn_id: 'i1' }], said('a Claude Code conversation, imported')]))
  // A file whose NAME is new but whose session_meta is the imported thread.
  put('sessions/2026/05/13', `rollout-2026-05-13T22-22-11-${LIAR}.jsonl`, lines([['session_meta', meta({ id: IMPORTED })], said('the same import under another name')]))
  return { home, workerPath }
}

// One Claude session, inserted the way the indexer would: the control.
function claudeRows(db: ReturnType<typeof openDb>) {
  db.exec(`INSERT INTO wells(id, dir, real_path) VALUES(1, '-Users-u-code-shop', '/Users/u/code/shop')`)
  db.exec(`INSERT INTO sessions(well_id, session_id, size, mtime_ms, lines, first_ts, last_ts, last_activity_ts) VALUES(1, 'claude-session-1', 10, 1, 3, '2026-09-08T01:00:00.000Z', '2026-09-08T02:00:00.000Z', '2026-09-08T02:00:00.000Z')`)
  db.exec(`INSERT INTO messages(id, session_id, ts, lane, type) VALUES(1, 'claude-session-1', '2026-09-08T01:00:00.000Z', 'prompt', 'user')`)
  db.exec(`INSERT INTO messages_fts(rowid, text) VALUES(1, 'add a refund button to the checkout')`)
  db.exec(`INSERT INTO requests(session_id, message_id, ts, model, input_tokens, cache_read_tokens, output_tokens) VALUES('claude-session-1', 'msg_1', '2026-09-08T01:00:05.000Z', 'claude-opus-5-5', 1000, 50000, 300)`)
}
const claudeView = (db: ReturnType<typeof openDb>) => ({
  sessions: listSessions(db, { limit: 100 }),
  usage: (['well', 'session', 'model', 'day'] as const).map((by) => listUsage(db, { by, limit: 50 })),
  explicit: listUsage(db, { by: 'model', limit: 50, source: 'claude' }),
  search: searchMessages(db, 'refund', { lanes: ['prompt', 'text', 'thinking', 'tool', 'event', 'meta', 'relay'], limit: 20 }),
})
const count = (db: ReturnType<typeof openDb>, table: string) => z.object({ n: z.number() }).parse(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n

async function indexed() {
  const { home, workerPath } = codexHome()
  const db = openDb(':memory:')
  claudeRows(db)
  const before = claudeView(db)
  const stats = await indexCodex(db, { codexHome: home })
  return { db, home, workerPath, before, stats }
}

describe('codex index', () => {
  test('the second scanner: threads in, imports out by id and by what the file says it is, incremental by size and mtime', async () => {
    const { db, home, workerPath, stats } = await indexed()
    expect(stats).toMatchObject({ threads: 4, indexed: 3, skipped: 0, imported: 1, refused: 1, requests: 3, unknown: {} })
    // The exclusion list held: neither the import nor its alias is a thread.
    const ids = z.array(z.object({ thread_id: z.string() })).parse(db.prepare('SELECT thread_id FROM codex_threads ORDER BY thread_id').all())
    expect(ids.map((r) => r.thread_id)).toEqual([WORKER, JUDGE, IDLE])
    expect(searchCodex(db, 'imported OR import', { lanes: ['prompt', 'text', 'meta'], limit: 10 })).toEqual([])

    expect(await indexCodex(db, { codexHome: home })).toMatchObject({ indexed: 0, skipped: 3, refused: 1 })
    expect(await indexCodex(db, { codexHome: home, full: true })).toMatchObject({ indexed: 3, skipped: 0 })
    // A thread that grew is re-read whole, and its rows replace the old ones.
    writeFileSync(workerPath, `${worker}${lines([said('one more line')]).replace('"ordinal":0', '"ordinal":99')}`)
    utimesSync(workerPath, new Date(), new Date(Date.now() + 5000))
    expect(await indexCodex(db, { codexHome: home })).toMatchObject({ indexed: 1, skipped: 2 })
    expect(count(db, 'codex_threads')).toBe(3)
    expect(count(db, 'codex_requests')).toBe(3)
    expect(count(db, 'codex_messages')).toBe(count(db, 'codex_messages_fts'))
  })

  test('no schema bump, and nothing Claude\'s moved: same tables, same rows, same answers', async () => {
    const { db, before } = await indexed()
    expect(z.object({ user_version: z.number() }).parse(db.prepare('PRAGMA user_version').get()).user_version).toBe(22)
    expect([count(db, 'sessions'), count(db, 'messages'), count(db, 'messages_fts'), count(db, 'requests'), count(db, 'wells')]).toEqual([1, 1, 1, 1, 1])
    expect(claudeView(db)).toEqual(before)
    // Not even its tokens: the Codex requests are in no Claude total.
    expect(before.usage[2]!.totals).toMatchObject({ requests: 1, cacheRead: 50000 })
  })

  test('sessions: a thread lists by repo, with its turns, what the user submitted, and its judges rolled up', async () => {
    const { db } = await indexed()
    const rows = listCodexSessions(db, { limit: 100 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'codex',
      sessionId: WORKER,
      repo: 'github.com/u/shop',
      kind: 'worker',
      parent: null,
      turns: 2,
      // The reply to a question is an answer, not a second prompt; the
      // plugin injection is neither.
      prompts: 1,
      questions: 1,
      firstPrompt: 'add a refund button to the checkout',
      branch: 'codex/refunds',
      workDir: '/Users/u/.codex/worktrees/1991/shop',
      guardians: 2,
      guardiansRan: 1,
      verdicts: 1,
      reasoning: 1,
      reasoningSummarized: 1,
      archived: false,
      models: [{ model: 'gpt-6-astra', requests: 2 }],
      firstAt: '2026-09-08T04:48:11.000Z',
    })
    // The judges are threads too, when asked for — one of them never ran.
    const all = listCodexSessions(db, { limit: 100, guardians: true })
    expect(all.map((r) => [r.sessionId, r.kind, r.turns, r.parent, r.archived])).toEqual([
      [WORKER, 'worker', 2, null, false],
      [JUDGE, 'guardian', 1, WORKER, false],
      [IDLE, 'guardian', 0, WORKER, true],
    ])
    expect(all[1]!.firstPrompt).toBeNull()
    expect(listCodexSessions(db, { limit: 100, repo: 'shop' })).toHaveLength(1)
    expect(listCodexSessions(db, { limit: 100, repo: 'github.com/u/shop', exact: true })).toHaveLength(1)
    expect(listCodexSessions(db, { limit: 100, repo: 'elsewhere' })).toEqual([])
  })

  test('the window is the instant: a thread filed under the 7th that ran on the 8th (UTC) is in the 8th', async () => {
    const { db } = await indexed()
    expect(listCodexSessions(db, { limit: 100, since: '2026-09-08T00:00:00.000Z' }).map((r) => r.sessionId)).toEqual([WORKER])
    expect(listCodexSessions(db, { limit: 100, since: '2026-09-08T05:00:00.000Z' })).toEqual([])
    expect(searchCodex(db, 'refund', { lanes: ['prompt'], since: '2026-09-08T00:00:00.000Z', until: '2026-09-09T00:00:00.000Z', limit: 10 })).toHaveLength(1)
    expect(searchCodex(db, 'refund', { lanes: ['prompt'], until: '2026-09-08T00:00:00.000Z', limit: 10 })).toEqual([])
  })

  // The rule every verb holds (CLAUDE.md: an instant is UTC, a day is local):
  // a TYPED day becomes the instant of local midnight inside the library, and
  // nothing compares a sliced ISO string against it. 20:00Z is the 9th
  // already at UTC+14, where a string compare against the day would drop it —
  // so the expectations are derived from `day()`, and bite in CI's second zone.
  test('a typed day is the local day on every Codex bound, and a week is the week Claude\'s report keys', async () => {
    const { db } = await indexed()
    const at = '2026-09-08T20:00:00.000Z'
    const LATE = '01a07f60-0000-7000-8000-00000000000a'
    db.exec(`INSERT INTO codex_threads(thread_id, root_thread_id, kind, repo, path, size, mtime_ms, first_ts, last_ts, last_activity_ts, turns) VALUES('${LATE}', '${LATE}', 'worker', 'github.com/u/shop', 'x', 1, 1, '${at}', '${at}', '${at}', 1)`)
    db.exec(`INSERT INTO codex_messages(id, thread_id, ordinal, ts, lane, type, turn_id) VALUES(9001, '${LATE}', 1, '${at}', 'prompt', 'user', 'L1')`)
    db.exec(`INSERT INTO codex_messages_fts(rowid, text) VALUES(9001, 'a nocturne for the night shift')`)
    db.exec(`INSERT INTO codex_requests(thread_id, response_id, turn_id, ts, model, input_tokens, output_tokens) VALUES('${LATE}', 'resp_late', 'L1', '${at}', 'gpt-6-astra', 10, 5)`)
    db.exec(`INSERT INTO requests(session_id, message_id, ts, model, input_tokens, output_tokens) VALUES('claude-session-1', 'msg_late', '${at}', 'claude-opus-5-5', 10, 5)`)
    const local = day(at)
    const next = day(new Date(Date.parse(at) + 86_400_000).toISOString())

    expect(listCodexSessions(db, { limit: 100, since: local }).map((r) => r.sessionId)).toContain(LATE)
    expect(listCodexSessions(db, { limit: 100, since: next }).map((r) => r.sessionId)).not.toContain(LATE)
    expect(searchCodex(db, 'nocturne', { lanes: ['prompt'], since: local, limit: 10 })).toHaveLength(1)
    expect(searchCodex(db, 'nocturne', { lanes: ['prompt'], since: local, until: next, limit: 10 })).toHaveLength(1)
    expect(searchCodex(db, 'nocturne', { lanes: ['prompt'], until: local, limit: 10 })).toEqual([])
    expect(searchCodex(db, 'nocturne', { lanes: ['prompt'], since: next, limit: 10 })).toEqual([])
    // The window and the bucket agree: the day asked for is the day keyed.
    expect(listUsage(db, { by: 'day', source: 'codex', since: local, limit: 50 }).rows.map((r) => r.key)).toEqual([local])
    expect(listUsage(db, { by: 'day', source: 'codex', until: local, limit: 50 }).rows.map((r) => r.key)).not.toContain(local)
    // One week key for both vendors: the ISO week of the local day (fmt.ts weekKeySql).
    const week = listUsage(db, { by: 'week', source: 'codex', session: LATE, limit: 50 }).rows.map((r) => r.key)
    expect(week).toHaveLength(1)
    expect(week[0]).toMatch(/^\d{4}-W\d{2}$/)
    expect(listUsage(db, { by: 'week', since: local, limit: 50 }).rows.map((r) => r.key)).toEqual(week)
  })

  test('usage: Codex\'s requests in lore\'s classes, by repo, unpriced — and never in a Claude total', async () => {
    const { db } = await indexed()
    const byModel = listUsage(db, { by: 'model', limit: 50, source: 'codex' })
    expect(byModel.source).toBe('codex')
    expect(byModel.unpriced).toEqual(['codex-auto-review', 'gpt-6-astra'])
    expect(byModel.rows.map((r) => [r.key, r.requests, r.input, r.cacheRead, r.output, r.thinking, r.listUsd]).sort()).toEqual([
      // input is UNCACHED: 100,000 − 99,000 and 2,000 − 0; 50,000 − 40,000.
      ['codex-auto-review', 1, 10_000, 40_000, 80, 30, null],
      ['gpt-6-astra', 2, 3000, 99_000, 540, 200, null],
    ])
    expect(byModel.totals).toMatchObject({ requests: 3, sessions: 2, listUsd: null })
    const byWell = listUsage(db, { by: 'well', limit: 50, source: 'codex' })
    expect(byWell.rows.map((r) => [r.key, r.sessions, r.spawns])).toEqual([['github.com/u/shop', 2, undefined]])
    expect(listUsage(db, { by: 'session', limit: 50, source: 'codex', well: 'shop' }).rows.map((r) => [r.key, r.well]).sort()).toEqual([
      [WORKER, 'github.com/u/shop'],
      [JUDGE, 'github.com/u/shop'],
    ])
    expect(listUsage(db, { by: 'model', limit: 50, source: 'codex', session: JUDGE.slice(0, 36) }).rows.map((r) => r.key)).toEqual(['codex-auto-review'])
    // A Claude report still prices, and holds one request.
    const claude = listUsage(db, { by: 'model', limit: 50 })
    expect(claude.source).toBeUndefined()
    expect(claude.unpriced).toEqual([])
    expect(claude.totals.requests).toBe(1)
    expect(claude.totals.listUsd).toBeGreaterThan(0)
  })

  test('search: what was said is found once; a guardian\'s evidence is in no lane', async () => {
    const { db } = await indexed()
    const every = ['prompt', 'text', 'thinking', 'tool', 'event', 'meta', 'relay', 'question'] as const
    const hits = searchCodex(db, 'refund', { lanes: [...every], limit: 20 })
    // The worker's prompt and its exec — NOT the copy the guardian was shown.
    expect(hits.map((h) => [h.sessionId, h.lane]).sort()).toEqual([
      [WORKER, 'prompt'],
      [WORKER, 'tool'],
    ])
    expect(hits[0]).toMatchObject({ source: 'codex', repo: 'github.com/u/shop', gitBranch: 'codex/refunds', turnId: 't1', kind: 'worker' })
    expect(searchCodex(db, 'zebrafish', { lanes: [...every], limit: 20 })).toEqual([])
    // The verdict is the guardian's own words and is kept.
    expect(searchCodex(db, 'read-only', { lanes: ['text'], limit: 20 }).map((h) => [h.sessionId, h.kind])).toEqual([[JUDGE, 'guardian']])
    // The injection is meta, never prompt.
    expect(searchCodex(db, 'walrus', { lanes: ['prompt'], limit: 20 })).toEqual([])
    expect(searchCodex(db, 'walrus', { lanes: ['meta'], limit: 20 })).toHaveLength(1)
    // The question lane, both halves, and only there.
    expect(searchCodex(db, 'staging', { lanes: ['question'], limit: 20 }).map((h) => h.turnId)).toEqual(['t2'])
    expect(searchCodex(db, 'Deploy', { lanes: ['question'], limit: 20 }).map((h) => h.turnId)).toEqual(['t1'])
    expect(searchCodex(db, 'Deploy', { lanes: ['prompt', 'tool'], limit: 20 })).toEqual([])
    expect(searchCodex(db, 'refund', { lanes: ['prompt'], session: JUDGE, limit: 20 })).toEqual([])
    expect(searchCodex(db, 'refund', { lanes: ['prompt'], session: WORKER.slice(0, 8), limit: 20 })).toHaveLength(1)
    expect(searchCodex(db, 'refund', { lanes: ['prompt'], repo: 'shop', limit: 20 })).toHaveLength(1)
    // The summary is the thinking lane.
    expect(searchCodex(db, 'checkout controller', { lanes: ['thinking'], limit: 20 })).toHaveLength(1)
  })
})
