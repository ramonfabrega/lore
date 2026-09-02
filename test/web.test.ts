import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { createApp } from '../src/web'

const Any = z.any()

const WELL = '-u-code-fun-app'
function prompt(ts: string, promptId: string, text: string) {
  return JSON.stringify({ type: 'user', timestamp: ts, promptId, sessionId: 'sess-1', cwd: '/u/code/fun/app', message: { role: 'user', content: text } })
}
function assistant(ts: string, id: string, content: unknown[], output: number, stop = 'tool_use') {
  return JSON.stringify({
    type: 'assistant', timestamp: ts, sessionId: 'sess-1',
    message: { id, model: 'claude-opus-5', role: 'assistant', stop_reason: stop, content, usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 100000, output_tokens: output } },
  })
}
function result(ts: string, promptId: string, toolUseId: string, text: string) {
  return JSON.stringify({ type: 'user', timestamp: ts, promptId, sessionId: 'sess-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } })
}

async function seededApp() {
  const dir = mkdtempSync(join(tmpdir(), 'lore-web-'))
  mkdirSync(join(dir, WELL), { recursive: true })
  writeFileSync(
    join(dir, WELL, 'sess-1.jsonl'),
    [
      prompt('2026-09-01T10:00:00.000Z', 'p1', 'ship the explorer'),
      assistant('2026-09-01T10:00:05.000Z', 'msg_1', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'bun test' } }], 50),
      result('2026-09-01T10:00:09.000Z', 'p1', 'tu_1', '91 pass'),
      assistant('2026-09-01T10:00:20.000Z', 'msg_2', [{ type: 'text', text: 'Green.' }], 30, 'end_turn'),
    ].join('\n') + '\n',
  )
  const db = openDb(':memory:')
  await buildIndex(db, { projectsDir: dir, historyPath: join(dir, 'nope.jsonl') })
  // The root joins the live roster; keep the test hermetic.
  return createApp(() => db, { agents: async () => [] })
}

describe('explorer routes', () => {
  test('/ renders wells and answers JSON on request', async () => {
    const app = await seededApp()
    const page = await app.request('/')
    expect(page.status).toBe(200)
    const text = await page.text()
    expect(text).toContain('<title>lore</title>')
    expect(text).toContain(`/well/${encodeURIComponent(WELL)}`)
    // the day chart's legend names the FAMILY; the recent row names what ran it
    expect(text).toContain('<i class="sw m-opus"></i>opus</span>')
    expect(text).toContain('<i class="sw m-opus"></i>opus-5</span>')
    expect(text).toContain('recent')
    expect(text).toContain('ship the explorer')
    expect(text).toContain('layout-root')
    const json = Any.parse(await (await app.request('/?json=1')).json())
    expect(json.active[0].key).toBe(WELL)
    expect(json.recent[0].sessionId).toBe('sess-1')
    expect(json.recent[0].usage.requests).toBe(2)
    expect(json.days[0].models[0].model).toBe('claude-opus-5')
    expect(json.days[0].usd.output).toBeGreaterThan(0)
    const viaAccept = await app.request('/', { headers: { accept: 'application/json' } })
    expect(viaAccept.headers.get('content-type')).toContain('application/json')
  })

  test('/well/:dir lists sessions with their fee; unknown well is 404', async () => {
    const app = await seededApp()
    const res = await app.request(`/well/${encodeURIComponent(WELL)}`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('/session/sess-1')
    expect(text).toContain('ship the explorer')
    // the well's mix in the head, and the model beside each session
    expect(text).toContain('tile models')
    expect(text).toContain('<i class="sw m-opus"></i>opus-5</span>')
    const wjson = Any.parse(await (await app.request(`/well/${encodeURIComponent(WELL)}?json=1`)).json())
    expect(wjson.models).toEqual([{ model: 'claude-opus-5', requests: 2 }])
    expect(wjson.sessions[0].models).toEqual([{ model: 'claude-opus-5', requests: 2 }])
    expect((await app.request('/well/-nope')).status).toBe(404)
  })

  test('/session/:id renders the block and its instructions; unknown id is 404', async () => {
    const app = await seededApp()
    const res = await app.request('/session/sess')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('ship the explorer')
    expect(text).toContain('bun test')
    expect(text).toContain('91 pass')
    expect(text).toContain('Green.')
    // one model, so it is named once in the header and the spine has no column
    expect(text).toContain('<i class="sw m-opus"></i>opus-5</span> <span class="muted">×2</span>')
    expect(text).not.toContain('class="spine mixed"')
    const json = Any.parse(await (await app.request('/session/sess-1?json=1')).json())
    expect(json.models).toEqual([{ model: 'claude-opus-5', requests: 2 }])
    expect(json.transactions[0].model).toBe('claude-opus-5')
    expect(json.spawns).toEqual([])
    expect(json.totals.transactions).toBe(1)
    expect(json.transactions[0].instructions[0].ms).toBe(4000)
    expect((await app.request('/session/zzz')).status).toBe(404)
  })

  test('/usage renders the profile', async () => {
    const app = await seededApp()
    const res = await app.request('/usage')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('2026-09-01')
  })
})
