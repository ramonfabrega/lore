import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { joinAgents } from '../src/agents'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { parseLine } from '../src/parse'
import { prefixLastToken, searchSessions } from '../src/search'
import { annotate, getTrace } from '../src/trace'
import { createApp } from '../src/web'

const Any = z.any()
const WELL = '-u-code-fun-app'
const JOB = 'job-0001'
function prompt(ts: string, promptId: string, text: string, sid = 'sess-1') {
  return JSON.stringify({ type: 'user', timestamp: ts, promptId, session_id: JOB, sessionId: sid, cwd: '/u/code/fun/app', message: { role: 'user', content: text } })
}
function assistant(ts: string, id: string, content: unknown[], output: number, sid = 'sess-1', stop = 'tool_use') {
  return JSON.stringify({
    type: 'assistant', timestamp: ts, session_id: JOB, sessionId: sid,
    message: { id, model: 'claude-opus-5', role: 'assistant', stop_reason: stop, content, usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 100000, output_tokens: output } },
  })
}
function result(ts: string, promptId: string, toolUseId: string, text: string, sid = 'sess-1', isError = false) {
  return JSON.stringify({ type: 'user', timestamp: ts, promptId, session_id: JOB, sessionId: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }] } })
}
const bash = (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } })

const S1 = [
  prompt('2026-09-01T10:00:00Z', 'p1', 'fix the sparkle notarization step'),
  assistant('2026-09-01T10:00:05Z', 'm1', [bash('t1', 'bun test')], 50),
  result('2026-09-01T10:00:09Z', 'p1', 't1', 'test/a.test.ts:\n 3 pass\n 1 fail\nRan 4 tests', 'sess-1', true),
  assistant('2026-09-01T10:00:20Z', 'm2', [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/u/code/fun/app/src/sign.ts', old_string: 'a', new_string: 'b' } }], 30),
  result('2026-09-01T10:00:21Z', 'p1', 't2', 'ok'),
  assistant('2026-09-01T10:00:30Z', 'm3', [bash('t3', 'bun test')], 40),
  result('2026-09-01T10:00:34Z', 'p1', 't3', ' 4 pass\n 0 fail\nRan 4 tests'),
  assistant('2026-09-01T10:00:40Z', 'm4', [bash('t4', 'git commit -q -m "notarization: sign the right bundle"')], 20),
  result('2026-09-01T10:00:41Z', 'p1', 't4', '[master ab12cd3] notarization: sign the right bundle\n 1 file changed'),
  assistant('2026-09-01T10:00:50Z', 'm5', [{ type: 'text', text: 'Signed and green.' }], 60, 'sess-1', 'end_turn'),
]
const S2 = [
  prompt('2026-09-02T10:00:00Z', 'p9', 'unrelated: tune the sparkline colors', 'sess-2'),
  assistant('2026-09-02T10:00:05Z', 'm9', [{ type: 'text', text: 'Using the palette hue.' }], 10, 'sess-2', 'end_turn'),
]

async function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'lore-explorer-'))
  mkdirSync(join(dir, WELL), { recursive: true })
  writeFileSync(join(dir, WELL, 'sess-1.jsonl'), `${S1.join('\n')}\n`)
  writeFileSync(join(dir, WELL, 'sess-2.jsonl'), `${S2.join('\n')}\n`)
  const db = openDb(':memory:')
  await buildIndex(db, { projectsDir: dir, historyPath: join(dir, 'nope.jsonl') })
  return db
}

describe('search: sessions first', () => {
  test('prefixLastToken makes a half-typed word a prefix and leaves FTS syntax alone', () => {
    expect(prefixLastToken('sparkle notar')).toBe('sparkle notar*')
    expect(prefixLastToken('"sparkle notarization"')).toBe('"sparkle notarization"')
    expect(prefixLastToken('a AND b')).toBe('a AND b')
    expect(prefixLastToken('  ')).toBe('')
  })

  test('groups hits by session, ranks by best hit then count, links hits to their transaction', async () => {
    const db = await seeded()
    const r = searchSessions(db, 'notar', { lanes: ['prompt', 'text', 'tool'], limit: 10 })
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['sess-1'])
    const s = r.sessions[0]!
    expect(s.hits).toBeGreaterThanOrEqual(2)
    expect(s.firstPrompt).toBe('fix the sparkle notarization step')
    expect(s.snippets[0]!.promptId).toBe('p1')
    expect(s.snippets[0]!.snippet).toContain('«')
    const both = searchSessions(db, 'sparkl', { lanes: ['prompt', 'text'], limit: 10 })
    expect(both.sessions.map((s) => s.sessionId).sort()).toEqual(['sess-1', 'sess-2'])
    const recent = searchSessions(db, 'sparkl', { lanes: ['prompt', 'text'], limit: 10, sort: 'recent' })
    expect(recent.sessions[0]!.sessionId).toBe('sess-2')
  })
})

describe('annotations', () => {
  test('files, commands, tests with verdicts read from the tail, commits, retries', async () => {
    const db = await seeded()
    const t = getTrace(db, 'sess-1', { limit: 10 })
    const a = t.transactions[0]!.annotations
    expect(a.files).toEqual(['/u/code/fun/app/src/sign.ts'])
    expect(a.commands).toBe(3)
    expect(a.tests).toEqual({ ran: 2, passed: 1, failed: 1 })
    expect(a.commits).toEqual(['ab12cd3'])
    expect(a.retries).toBe(1)
  })

  test('annotate is pure and empty-safe', () => {
    expect(annotate([])).toEqual({ files: [], commands: 0, tests: { ran: 0, passed: 0, failed: 0 }, commits: [], retries: 0 })
    expect(annotate([{ tool: 'Bash', inputFull: '{"command":"cargo test -p sim"}', resultFull: 'test result: ok. 685 passed', error: false }]).tests).toEqual({ ran: 1, passed: 1, failed: 0 })
    expect(annotate([{ tool: 'Bash', inputFull: '{"command":"cargo test"}', resultFull: 'test result: FAILED. 1 failed', error: false }]).tests).toEqual({ ran: 1, passed: 0, failed: 1 })
  })

  test('tool results index head + tail so the verdict survives the cap', () => {
    const long = `${'x'.repeat(3000)}\nRan 9 tests, 9 pass`
    const p = parseLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'z', content: long }] } }))!
    expect(p.entries[0]!.text.length).toBeLessThan(2100)
    expect(p.entries[0]!.text).toContain('Ran 9 tests, 9 pass')
    expect(p.entries[0]!.text).toContain('… … …')
  })
})

describe('agents join', () => {
  test('working, blocked, failed, stopped, done — then by last update; lore side joins by session id; attach is a command', () => {
    const rows = joinAgents(
      [
        { id: 'aaa', cwd: '/u/code/fun/app', kind: 'background', startedAt: 1_700_000_000_000, sessionId: 'sess-1', name: 'older-done', state: 'done' },
        { id: 'bbb', cwd: '/u/code/fun/app/.claude/worktrees/x', kind: 'background', startedAt: 1_700_000_100_000, sessionId: 'sess-9', name: 'live', state: 'working' },
        { id: 'ccc', cwd: '/u/code/work/thing', kind: 'background', startedAt: 1_700_000_200_000, sessionId: 'sess-2', state: 'blocked', waitingFor: 'permission prompt' },
        { id: 'ddd', cwd: '/u/code/work/thing', kind: 'background', startedAt: 1_700_000_300_000, sessionId: 'sess-3', name: 'killed', state: 'stopped' },
        { id: 'eee', cwd: '/u/code/work/thing', kind: 'background', startedAt: 1_700_000_050_000, sessionId: 'sess-4', name: 'crashed', state: 'failed' },
      ],
      new Map([
        ['bbb', { detail: 'running tests', tempo: 'active', tokens: 12345, worktreeBranch: 'x', children: [{ id: '7', href: 'https://github.com/o/r/pull/7', kind: 'pr' }], updatedAt: '2023-11-14T22:18:20.000Z' }],
        ['ccc', null],
      ]),
      (sid) =>
        sid === 'sess-1'
          ? { well: WELL, requests: 5, output: 200, listUsd: 0.23, last: '2026-09-01T10:00:50Z', models: [{ model: 'claude-opus-5', requests: 5 }] }
          : null,
    )
    expect(rows.map((r) => r.id)).toEqual(['bbb', 'ccc', 'eee', 'ddd', 'aaa'])
    expect(rows[0]).toMatchObject({ liveTokens: 12345, branch: 'x', attach: 'claude attach bbb', indexed: null })
    expect(rows[0]!.children[0]!.id).toBe('7')
    expect(rows[1]!.waitingFor).toBe('permission prompt')
    expect(rows[4]!.indexed).toMatchObject({ requests: 5, listUsd: 0.23 })
    // the model rides on the row, from the index, and says so
    expect(rows[4]).toMatchObject({ model: 'claude-opus-5', modelSource: 'index' })
    expect(rows[0]).toMatchObject({ model: null, modelSource: null })
  })
})

describe('explorer pages: search, agents, job, anchors', () => {
  test('/search renders grouped hits with transaction anchors; /agents renders the injected roster; /job lists the clears', async () => {
    const db = await seeded()
    const app = createApp(() => db, {
      agents: async () => [
        { id: 'bbb', name: 'live', state: 'working', waitingFor: null, detail: 'running tests', tempo: 'active', cwd: '/u/code/fun/app', branch: null, sessionId: 'sess-1', startedAt: '2026-09-01T09:00:00.000Z', updatedAt: null, liveTokens: 999, children: [], attach: 'claude attach bbb', model: 'claude-fable-5-1', modelSource: 'transcript', indexed: { well: WELL, requests: 5, output: 200, listUsd: 0.23, last: '2026-09-01T10:00:50Z', models: [{ model: 'claude-fable-5-1', requests: 5 }] } },
      ],
      wikiDir: '/nonexistent',
    })
    const search = await (await app.request('/search?q=notar&lanes=prompt,text,tool')).text()
    expect(search).toContain('<mark>notarization</mark>')
    expect(search).toContain('/session/sess-1#tx-p1')
    const sjson = Any.parse(await (await app.request('/search?q=notar&json=1')).json())
    expect(sjson.sessions[0].sessionId).toBe('sess-1')
    expect((await app.request('/search')).status).toBe(200)

    const agents = await (await app.request('/agents')).text()
    expect(agents).toContain('claude attach bbb')
    expect(agents).toContain('running tests')
    expect(agents).toContain('/session/sess-1')
    // the roster names the model without opening the session, and says how it knows
    expect(agents).toContain('<i class="sw m-fable"></i>fable-5.1')
    expect(agents).toContain('verified from the transcript')
    // A row is a job: the live row merged with the index's job (both
    // sessions under the root), named by the roster, linking the job page.
    expect(agents).toContain(`/job/${JOB}`)
    expect(agents).toContain('>@live<')
    const ajson = Any.parse(await (await app.request('/agents?json=1')).json())
    expect(ajson.count).toBe(1)
    expect(ajson.jobs[0]).toMatchObject({ key: JOB, kind: 'root', sessions: 2, name: null })

    // The job page, from the root (an older link), its sessions by local
    // day, the newest session as the opener.
    const job = await (await app.request(`/job/${JOB}`)).text()
    expect(job).toContain('/session/sess-1')
    expect(job).toContain('/session/sess-2')
    expect(job).toContain('root id')
    expect(job).toContain('class="row day"')
    const jjson = Any.parse(await (await app.request(`/job/sess-2?json=1`)).json())
    expect(jjson.job.key).toBe(JOB)
    expect(jjson.job.latest.sessionId).toBe('sess-2')
    expect(jjson.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(['sess-1', 'sess-2'])
    expect((await app.request('/job/nope')).status).toBe(404)

    const session = await (await app.request('/session/sess-1')).text()
    expect(session).toContain('id="tx-p1"')
    expect(session).toContain('tests 2')
    expect(session).toContain('ab12cd3')
    expect(session).toContain(`/job/${JOB}`)
    const home = await (await app.request('/')).text()
    expect(home).toContain('action="/search"')
  })
})

describe('jobs: commit trailer → transcript', () => {
  test('bridgeKey normalises every spelling; indexJobs reads state.json; /s/ redirects; trace resolves a trailer', async () => {
    const { bridgeKey, indexJobs, resolveBridge } = await import('../src/jobs')
    expect(bridgeKey('session_0145Qxeq')).toBe('0145Qxeq')
    expect(bridgeKey('cse_0145Qxeq')).toBe('0145Qxeq')
    expect(bridgeKey('https://claude.ai/code/session_0145Qxeq')).toBe('0145Qxeq')
    expect(bridgeKey('0145Qxeq')).toBe('0145Qxeq')

    const db = await seeded()
    const claudeDir = mkdtempSync(join(tmpdir(), 'lore-jobs-'))
    mkdirSync(join(claudeDir, 'jobs', 'ab12cd34'), { recursive: true })
    writeFileSync(
      join(claudeDir, 'jobs', 'ab12cd34', 'state.json'),
      JSON.stringify({ sessionId: 'sess-1', bridgeSessionId: 'cse_0145Qxeq', name: 'lore', cwd: '/u/code/fun/app', state: 'working', createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T11:00:00.000Z' }),
    )
    mkdirSync(join(claudeDir, 'jobs', 'nostate'), { recursive: true })
    const stats = await indexJobs(db, { claudeDir })
    expect(stats).toMatchObject({ jobs: 1, withBridge: 1 })
    expect(resolveBridge(db, 'session_0145Qxeq')).toBe('sess-1')
    expect(resolveBridge(db, 'session_nope')).toBeNull()

    const app = createApp(() => db, { wikiDir: '/nonexistent' })
    const r = await app.request('/s/session_0145Qxeq', { redirect: 'manual' })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/session/sess-1')
    expect((await app.request('/s/sess-1', { redirect: 'manual' })).headers.get('location')).toBe('/session/sess-1')
    expect((await app.request('/s/sess')).status).toBe(404) // ambiguous prefix, two sessions
    expect((await app.request('/s/session_nope')).status).toBe(404)

    const t = getTrace(db, 'https://claude.ai/code/session_0145Qxeq', { limit: 1 })
    expect(t.session.sessionId).toBe('sess-1')
  })

  test('nav shows when the server last refreshed the index', async () => {
    const db = await seeded()
    const app = createApp(() => db, { wikiDir: '/nonexistent', indexed: { at: new Date(Date.now() - 120_000).toISOString(), busy: false, error: null } })
    expect(await (await app.request('/usage')).text()).toContain('indexed 2 min ago')
    const stale = createApp(() => db, { wikiDir: '/nonexistent' })
    expect(await (await stale.request('/usage')).text()).toContain('last `lore index`')
  })
})
