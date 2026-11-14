import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { createApp, lastDays, markSnippet, shiftDay, usageWindow } from '../src/web'
import { day, dayStart, todayLocal } from '../src/fmt'

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

// The fixture is dated relative to NOW. The root page's panels are windows
// on the real clock — "active this week" is the last 7 days, the day chart
// the last 45 — so a fixed date ages out of them: 2026-09-01 left the week
// on 09-09 and failed every run after, master included. Two days ago sits
// inside every window, in every zone CI runs (UTC and UTC+14).
const T0 = Math.floor((Date.now() - 2 * 86_400_000) / 1000) * 1000
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString()

async function seededApp() {
  const dir = mkdtempSync(join(tmpdir(), 'lore-web-'))
  mkdirSync(join(dir, WELL), { recursive: true })
  writeFileSync(
    join(dir, WELL, 'sess-1.jsonl'),
    [
      prompt(at(0), 'p1', 'ship the explorer'),
      assistant(at(5), 'msg_1', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'bun test' } }], 50),
      result(at(9), 'p1', 'tu_1', '91 pass'),
      // A lane: the session spawns a job, whose answer names the child's id.
      assistant(at(10), 'msg_3', [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'ccc spawn --name w1 --json - < brief.md' } }], 20),
      result(at(12), 'p1', 'tu_2', '{"cwd":"/u/w1","ref":"abcd1234","said":"backgrounded · abcd1234 · w1"}'),
      assistant(at(20), 'msg_2', [{ type: 'text', text: 'Green.' }], 30, 'end_turn'),
    ].join('\n') + '\n',
  )
  // The lane's own transcript, in its worktree well, inside the parent's window.
  mkdirSync(join(dir, `${WELL}--claude-worktrees-w1`), { recursive: true })
  writeFileSync(
    join(dir, `${WELL}--claude-worktrees-w1`, 'abcd1234-5678.jsonl'),
    [
      JSON.stringify({ type: 'user', timestamp: at(14), promptId: 'w1', sessionId: 'abcd1234-5678', session_id: 'abcd1234-root', message: { role: 'user', content: 'You are a worker lane' } }),
      JSON.stringify({
        type: 'assistant', timestamp: at(18), sessionId: 'abcd1234-5678', session_id: 'abcd1234-root',
        message: { id: 'msg_w1', model: 'claude-opus-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'landed' }], usage: { input_tokens: 2, output_tokens: 40 } },
      }),
    ].join('\n') + '\n',
  )
  const db = openDb(':memory:')
  await buildIndex(db, { projectsDir: dir, historyPath: join(dir, 'nope.jsonl') })
  // The daemon reaped the lane: the row stays, its state says so.
  db.prepare("INSERT INTO jobs(job_id, session_id, bridge_key, name, cwd, state) VALUES('abcd1234', 'abcd1234-root', NULL, 'w1', '/u/w1', 'gone')").run()
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
    expect(json.recent[0].usage.requests).toBe(3)
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
    expect(wjson.models).toEqual([{ model: 'claude-opus-5', requests: 3 }])
    expect(wjson.sessions[0].models).toEqual([{ model: 'claude-opus-5', requests: 3 }])
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
    expect(text).toContain('<i class="sw m-opus"></i>opus-5</span> <span class="muted">×3</span>')
    expect(text).not.toContain('class="spine mixed"')
    const json = Any.parse(await (await app.request('/session/sess-1?json=1')).json())
    expect(json.models).toEqual([{ model: 'claude-opus-5', requests: 3 }])
    expect(json.transactions[0].model).toBe('claude-opus-5')
    expect(json.spawns).toEqual([])
    // The lane the session spawned: a tile, a bar in the timeline's lanes band, a row in the ledger.
    expect(json.totals.lanes).toBe(1)
    expect(json.lanes.map((l: { name: string; state: string; spawnedAt: string }) => [l.name, l.state, l.spawnedAt])).toEqual([['w1', 'gone', at(10)]])
    expect(text).toContain('>lanes</span></div>')
    expect(text).toContain('<span class="ln">lanes</span>')
    expect(text).toContain('class="ln st-gone"')
    expect(text).toContain('href="/job/abcd1234-root"')
    expect(text).toContain('<span class="kind st-gone">gone</span>')
    expect(text).toContain('You are a worker lane')
    expect(json.totals.transactions).toBe(1)
    // The transactions tile says who opened them, in the spine's words.
    expect(text).toContain('transactions · <span title="turns the user opened by typing">1 you</span>')
    expect(json.transactions[0].instructions[0].ms).toBe(4000)
    expect((await app.request('/session/zzz')).status).toBe(404)
  })

  test('/session/:id?view=conversation reads the same trace as a dialogue, and its JSON is the projection', async () => {
    const app = await seededApp()
    const res = await app.request('/session/sess-1?view=conversation')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('<section class="convo">')
    // the switch names the view it is on, and links the other
    expect(text).toContain('<a href="?view=block">block</a> · <b>conversation</b>')
    // the user's words (rendered — a brief is written in markdown), the work
    // folded to a line, the reply in markdown
    expect(text).toContain('<div class="say you md"><p>ship the explorer')
    expect(text).toContain('<details class="work" >')
    expect(text).toContain('Green.')
    // the turn's weight on the line that opens it
    expect(text).toMatch(/<div class="who you">.*<span class="fee">3 steps/)
    // the rail: a row per turn linking into it, a sub-row for the reply
    expect(text).toContain('<div class="panel rail">')
    expect(text).toMatch(/<a class="r prompt" href="#tx-[^"]+"/)
    expect(text).toMatch(/<a class="r sub ai" href="#tx-[^"]+-r"/)
    expect(text).toContain('class="layout-convo"')
    const json = Any.parse(await (await app.request('/session/sess-1?view=conversation&json=1')).json())
    expect(json[0].kind).toBe('prompt')
    expect(json[0].beats.map((b: { kind: string }) => b.kind)).toContain('work')
    expect(json[0].reply).toContain('Green.')
  })

  test('/run/:id renders a job as a run without a daemon; no window asked is the last day, ?since= sets one; unknown id is 404', async () => {
    const app = await seededApp()
    const res = await app.request('/run/abcd1234-root')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('class="layout-run"')
    expect(text).toContain('the last day')
    expect(text).toContain('<h2>lanes</h2>')
    const json = Any.parse(await (await app.request('/run/abcd1234-root?json=1')).json())
    expect(json.window.defaulted).toBe(true)
    // The page reads no repo: nothing of a queue file, a tranche or a score.
    expect(Object.keys(json).sort()).toEqual(['lanes', 'loop', 'parent', 'sessions', 'window'])
    expect(Object.keys(json.loop).sort()).toEqual(['asOf', 'job', 'lanes', 'lanesTotal', 'running', 'spend', 'spoke', 'window'])
    const asked = Any.parse(await (await app.request('/run/abcd1234-root?json=1&since=2026-01-01')).json())
    expect(asked.window.defaulted).toBe(false)
    expect(asked.sessions.job.length).toBeGreaterThan(0)
    expect((await app.request('/run/zzz')).status).toBe(404)
  })

  test('/usage renders the profile', async () => {
    const app = await seededApp()
    const res = await app.request('/usage')
    expect(res.status).toBe(200)
    // A usage bucket is a KEY — sorted, filtered, put in a ?since= and typed
    // into an <input type="date">, and it has to read the same as what
    // `lore usage --by day` prints. It stays ISO while the stamps around it
    // went human.
    expect(await res.text()).toContain(day(at(0)))
  })

  // The pages localized their text and left their own tooltips in UTC: hover
  // "17:45" on the front page and it answered "2026-09-02T22:45:40.123Z",
  // five hours off, in a different format, with milliseconds. Every instant
  // now goes through one helper that owns both halves, and this is the guard
  // that no call site quietly grows a raw one back.
  test('no page puts a raw UTC ISO string in a tooltip', async () => {
    const app = await seededApp()
    for (const path of ['/', '/usage', '/agents', `/well/${encodeURIComponent(WELL)}`, '/session/sess-1']) {
      const text = await (await app.request(path)).text()
      expect(text, path).not.toMatch(/title="[^"]*\d{4}-\d{2}-\d{2}T\d{2}:/)
      // and the machine-readable half is on the element where it belongs
      // (/usage is buckets and /agents an empty roster in this fixture)
      if (path === '/' || path.startsWith('/well') || path.startsWith('/session')) {
        expect(text, path).toContain('<time datetime="')
      }
    }
  })
})

// ---- windows are local days (2026-11-14) ----------------------------------

// A fixture of one session whose requests sit at the given instants.
// `extra` lines sit between the prompt and those requests.
async function appAt(stamps: string[], extra: string[] = [], promptAt = stamps[0]!) {
  const dir = mkdtempSync(join(tmpdir(), 'lore-web-win-'))
  mkdirSync(join(dir, WELL), { recursive: true })
  const lines = [prompt(promptAt, 'p1', 'go'), ...extra]
  stamps.forEach((ts, i) => lines.push(assistant(ts, `msg_${i}`, [{ type: 'text', text: 'ok' }], 10, 'end_turn')))
  writeFileSync(join(dir, WELL, 'sess-1.jsonl'), lines.join('\n') + '\n')
  const db = openDb(':memory:')
  await buildIndex(db, { projectsDir: dir, historyPath: join(dir, 'nope.jsonl') })
  return createApp(() => db, { agents: async () => [] })
}

describe('a window a person picks is local days', () => {
  test('shiftDay is calendar arithmetic on the date', () => {
    expect(shiftDay('2026-09-07', 1)).toBe('2026-09-08')
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDay('2026-03-09', -6)).toBe('2026-03-03') // across the US spring-forward
  })

  // `until` is inclusive and the query's bound exclusive. It was
  // `isoDay(Date.parse(until) + DAY)` — the local day of 00:00Z the next day,
  // which west of UTC is `until` itself: the last day fell out of every custom
  // window, and since=X&until=X was empty. The zone is pinned here because CI
  // runs only UTC and UTC+14, where the old expression happened to be right.
  test('the custom window includes its until day, in a zone west of UTC', () => {
    for (const tz of ['America/Panama', 'UTC', 'Pacific/Kiritimati']) {
      const w = usageWindow({ since: '2026-09-07', until: '2026-09-07' }, tz)
      expect(w.untilExclusive, tz).toBe('2026-09-08')
    }
  })

  test('a relative range is today and the n − 1 days before it', () => {
    expect(usageWindow({ range: '7d' }).since).toBe(shiftDay(todayLocal(), -6))
    expect(lastDays(1)).toBe(todayLocal())
  })

  // The front page started its week at today − 7: eight days, so its week
  // tiles counted a request /usage?range=7d did not.
  test('the front page week and /usage 7d count the same requests', async () => {
    // local noon seven and six days back, as instants
    const noon = (n: number) => new Date(Date.parse(dayStart(shiftDay(todayLocal(), n))) + 12 * 3_600_000).toISOString()
    const app = await appAt([noon(-7), noon(-6)])
    const front = Any.parse(await (await app.request('/?json=1')).json())
    const usage = Any.parse(await (await app.request('/usage?range=7d&json=1')).json())
    expect(front.week.requests).toBe(usage.models.totals.requests)
  })

  // "since <first day>" was substr(min(ts), 1, 10), the UTC date. It bites
  // wherever the local day and the UTC day differ — at UTC+14 every morning,
  // so CI's second pass carries this test.
  test('/usage names its first LOCAL day, the chart’s own first bucket', async () => {
    const cand = ['2026-09-06T18:00:00.000Z', '2026-09-07T02:00:00.000Z']
    const ts = cand.find((t) => day(t) !== t.slice(0, 10)) ?? cand[0]!
    const app = await appAt([ts])
    const json = Any.parse(await (await app.request('/usage?range=all&json=1')).json())
    const first = json.buckets.rows.map((r: { key: string }) => r.key).sort()[0]
    expect(first).toBe(day(ts))
    expect(json.window.since).toBe(first)
    const html = await (await app.request('/usage?range=all')).text()
    expect(/since \d{4}-\d{2}-\d{2}/.exec(html)?.[0]).toBe(`since ${day(ts)}`)
    expect(html).toContain(`name="since" value="${day(ts)}"`)
  })
})

describe('rendered text from the transcript', () => {
  // The search markers were « », which transcripts contain (2026-11-14).
  test('a literal « or » is text, only the FTS marks highlight', () => {
    expect(markSnippet('el dijo «arreglalo y \u0002zanahoria\u0003 » <b>')).toBe('el dijo «arreglalo y <mark>zanahoria</mark> » &lt;b&gt;')
  })

  test('a search hit whose text holds « opens exactly one <mark>', async () => {
    const app = await appAt([at(1)], [prompt(at(2), 'p2', 'el dijo «arreglalo y luego zanahoria funciona')])
    const html = await (await app.request('/search?q=zanahoria')).text()
    const snip = /<div class="snippet">[\s\S]*?<\/div>/.exec(html)?.[0] ?? ''
    expect(snip).toContain('<mark>zanahoria</mark>')
    expect((snip.match(/<mark>/g) ?? []).length).toBe((snip.match(/<\/mark>/g) ?? []).length)
    const json = Any.parse(await (await app.request('/search?q=zanahoria&json=1')).json())
    expect(json.sessions[0].snippets[0].snippet).toContain('«zanahoria»')
  })

  // The conversation view's sent beat read its body off an input cut to 400
  // characters, and the fallback returned null for it (2026-11-14).
  test('a SendMessage over 400 characters keeps its body in the conversation view', async () => {
    const brief = `Kickoff brief for the lane. ${'Read CLAUDE.md, then docs/DESIGN.md, then run the suite. '.repeat(12)}`
    const app = await appAt(
      [at(9)],
      [
        assistant(at(5), 'msg_s', [{ type: 'tool_use', id: 'tu_s', name: 'SendMessage', input: { to: 'ccc', summary: 'brief for v0', message: brief } }], 10),
        result(at(6), 'p1', 'tu_s', '{"success":true,"message":"sent"}'),
      ],
      at(0),
    )
    const json = Any.parse(await (await app.request('/session/sess-1?view=conversation&json=1')).json())
    const sent = json.flatMap((t: { beats: unknown[] }) => t.beats).find((b: { kind: string }) => b.kind === 'sent')
    expect(sent.summary).toBe('brief for v0')
    expect(sent.message).toStartWith('Kickoff brief for the lane.')
    expect(sent.message.endsWith('…')).toBe(true)
  })
})
