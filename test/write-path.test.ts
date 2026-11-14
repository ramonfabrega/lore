// The index write path, as the code review of 2026-11-14 found it: five ways
// a record was dropped, misfiled or over-deleted. Each describe is one of
// them and was red before its fix.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { jobNames } from '../src/job'
import { indexJobs } from '../src/jobs'
import { indexSpawnLedger } from '../src/ledger'
import { parseLine } from '../src/parse'
import { purgeSession } from '../src/purge'

const scratch = (tag: string) => mkdtempSync(join(tmpdir(), `lore-write-path-${tag}-`))
const Count = z.object({ n: z.number() })
const count = (db: ReturnType<typeof openDb>, sql: string, ...p: string[]) => Count.parse(db.prepare(sql).get(...p)).n

// ---------------------------------------------------------------------------
// F1: a mid-turn message with a pasted image is dropped whole.
// Verbatim key set of the record (tv well 4929eb49, 2026-11): `prompt` is an
// ARRAY of content blocks — text + image — when the user pastes an image.
describe('F1 parse: queued_command with an array prompt', () => {
  const rec = {
    type: 'attachment',
    timestamp: '2026-11-10T15:00:00.000Z',
    uuid: 'u1',
    sessionId: 's1',
    attachment: {
      type: 'queued_command',
      prompt: [
        { type: 'text', text: '[Image #3] is this old / can i close etc?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      ],
      imagePasteIds: [3],
      commandMode: 'prompt',
      origin: { kind: 'human' },
      timestamp: '2026-11-10T15:00:00.000Z',
    },
  }
  test('the user\'s words index into the prompt lane', () => {
    const p = parseLine(JSON.stringify(rec))!
    expect(p.entries).toEqual([{ lane: 'prompt', text: '[Image #3] is this old / can i close etc?' }])
  })
})

// ---------------------------------------------------------------------------
// F2: a subagent's hand-back was attributed to a peer SESSION named after the
// agent TYPE. Verbatim origin keys (lore well 891e0004). It stays in the relay
// lane — the conversation reads hand-backs there — and names no peer.
describe('F2 parse: a SubagentHandback names no peer session', () => {
  const rec = {
    type: 'attachment',
    timestamp: '2026-11-01T20:00:00.000Z',
    uuid: 'u2',
    sessionId: 's2',
    attachment: {
      type: 'queued_command',
      prompt: '<agent-message from="a43c15636ca077e41"> [Subagent hand-back] The text below is the final report of a subagent ...\n  Brief: ...</agent-message>',
      origin: {
        kind: 'peer',
        from: 'a43c15636ca077e41',
        senderTaskId: 'a43c15636ca077e41',
        name: 'lean',
        handback: true,
        handbackReportText: 'Brief: ...',
      },
    },
  }
  test('no peer attribution to a session named after the agent type', () => {
    const e = parseLine(JSON.stringify(rec))!.entries[0]!
    expect(e.peer).toBeUndefined()
    expect(e.lane).toBe('relay')
  })
})

// ---------------------------------------------------------------------------
// Shared transcript fixtures for the purge findings.
const WELL = '-u-code-fun-x'
const ROOT = 'aaaa1111-0000-0000-0000-000000000001'
const NEXT = 'bbbb2222-0000-0000-0000-000000000002'
const line = (r: Record<string, unknown>) => JSON.stringify(r)
const prompt = (s: string, ts: string, text: string, root?: string) =>
  line({ type: 'user', timestamp: ts, promptId: `p-${ts}`, sessionId: s, ...(root ? { session_id: root } : {}), message: { role: 'user', content: text } })
const refusal = (s: string, ts: string) =>
  line({
    type: 'assistant', timestamp: ts, sessionId: s,
    message: { id: 'synthetic-1', model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your weekly limit" }], usage: { input_tokens: 0, output_tokens: 0 } },
    apiError: 'usage_limit_reached',
    apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: 1792839600, rateLimitType: 'seven_day' } },
  })

function lay(sessions: Record<string, string[]>) {
  const root = scratch('purge')
  const projectsDir = join(root, 'projects')
  const archiveDir = join(root, 'archive')
  mkdirSync(join(projectsDir, WELL), { recursive: true })
  mkdirSync(join(archiveDir, 'projects'), { recursive: true })
  for (const [id, lines] of Object.entries(sessions)) writeFileSync(join(projectsDir, WELL, `${id}.jsonl`), `${lines.join('\n')}\n`)
  const historyPath = join(root, 'history.jsonl')
  writeFileSync(historyPath, '')
  return { root, projectsDir, archiveDir, historyPath }
}

// ---------------------------------------------------------------------------
// F3: purge leaves the session's 429 rows in `limits`.
describe('F3 purge: the limits table', () => {
  test('a purged session keeps no transcript-sourced limit rows', async () => {
    const { projectsDir, archiveDir, historyPath } = lay({
      [ROOT]: [prompt(ROOT, '2026-10-20T12:40:00.000Z', 'secret work'), refusal(ROOT, '2026-10-20T12:44:13.996Z')],
    })
    const db = openDb(':memory:')
    await buildIndex(db, { projectsDir, historyPath })
    expect(count(db, 'SELECT count(*) AS n FROM limits WHERE session_id = ?', ROOT)).toBe(1)
    await purgeSession(db, ROOT, { projectsDir, archiveDir, historyPath, yes: true })
    expect(count(db, 'SELECT count(*) AS n FROM sessions WHERE session_id = ?', ROOT)).toBe(0)
    expect(count(db, 'SELECT count(*) AS n FROM limits WHERE session_id = ?', ROOT)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// F4: purging a job's FIRST session deletes the whole job's `jobs` row (its
// state.json sessionId is that root) — for a job the daemon has deleted, the
// one row with no source to rebuild from (db.ts:123-126).
describe('F4 purge: the jobs row belongs to the job, not to one session', () => {
  test('purging the root session does not take the job name from its other sessions', async () => {
    const { root, projectsDir, archiveDir, historyPath } = lay({
      [ROOT]: [prompt(ROOT, '2026-11-01T08:00:00.000Z', 'kickoff')],
      [NEXT]: [
        line({ type: 'bridge-session', timestamp: '2026-11-01T09:00:00.000Z', sessionId: NEXT, session_id: ROOT, bridgeSessionId: 'cse_XYZ' }),
        prompt(NEXT, '2026-11-01T09:00:01.000Z', 'after the clear', ROOT),
      ],
    })
    const claudeDir = join(root, 'claude')
    mkdirSync(join(claudeDir, 'jobs', 'aaaa1111'), { recursive: true })
    writeFileSync(join(claudeDir, 'jobs', 'aaaa1111', 'state.json'), JSON.stringify({ sessionId: ROOT, bridgeSessionId: 'cse_XYZ', name: 'commander', state: 'working' }))
    const db = openDb(':memory:')
    await buildIndex(db, { projectsDir, historyPath })
    await indexJobs(db, { claudeDir })
    // The user deletes the job in the daemon: its state.json goes, the row stays as `gone`.
    rmSync(join(claudeDir, 'jobs', 'aaaa1111'), { recursive: true })
    await indexJobs(db, { claudeDir })
    expect(jobNames(db)('XYZ', 'bridge')).toBe('commander')

    // Purge ONE session of the job — its first, a stub.
    await purgeSession(db, ROOT, { projectsDir, archiveDir, historyPath, yes: true, indexOnly: true })
    expect(count(db, 'SELECT count(*) AS n FROM sessions WHERE session_id = ?', NEXT)).toBe(1)
    // NEXT is still the job's; its name should still be known.
    expect(jobNames(db)('XYZ', 'bridge')).toBe('commander')
  })
})

// ---------------------------------------------------------------------------
// F5: spawn_ledger is in the schema-bump drop list, so the next bump drops
// edges ledger.ts:42-45 promises to keep after ccc's file rotates.
describe('F5 db: a schema bump drops spawn_ledger', () => {
  test('ledger rows survive a rebuild once ccc has rotated its file', async () => {
    const dir = scratch('bump')
    const dbPath = join(dir, 'lore.db')
    const ledgerPath = join(dir, 'spawns.jsonl')
    writeFileSync(ledgerPath, `${JSON.stringify({ v: 1, ts: '2026-11-14T10:00:00Z', kind: 'spawn', child: 'cccc0001', parent: { job: 'aaaa1111', session: ROOT, bridge: null } })}\n`)
    let db = openDb(dbPath)
    await indexSpawnLedger(db, { path: ledgerPath })
    expect(count(db, 'SELECT count(*) AS n FROM spawn_ledger')).toBe(1)
    // ccc rotates its ledger; then the next build bumps the schema (simulated: the db reads one older).
    rmSync(ledgerPath)
    const SV = z.object({ user_version: z.number() }).parse(db.prepare('PRAGMA user_version').get()).user_version
    db.exec(`PRAGMA user_version = ${SV - 1}`)
    db.close()
    db = openDb(dbPath)
    await indexSpawnLedger(db, { path: ledgerPath })
    expect(count(db, 'SELECT count(*) AS n FROM spawn_ledger')).toBe(1)
    db.close()
  })
})
