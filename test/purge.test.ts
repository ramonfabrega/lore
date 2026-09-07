import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { purgeSession } from '../src/purge'

const WELL = '-Users-me-code-thing'
const KEEP = '11111111-1111-1111-1111-111111111111'
const GONE = '22222222-2222-2222-2222-222222222222'

function prompt(ts: string, text: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
}

function lay(): { root: string; projectsDir: string; archiveDir: string; historyPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'lore-purge-'))
  const projectsDir = join(root, 'projects')
  const archiveDir = join(root, 'archive')
  mkdirSync(join(projectsDir, WELL), { recursive: true })
  mkdirSync(join(archiveDir, 'projects', WELL), { recursive: true })
  for (const id of [KEEP, GONE]) {
    const body = [prompt('2026-09-07T10:00:00.000Z', `${id} the secret phrase`), ''].join('\n')
    writeFileSync(join(projectsDir, WELL, `${id}.jsonl`), body)
    writeFileSync(join(archiveDir, 'projects', WELL, `${id}.jsonl`), body)
  }
  // The spawn/title sidecar dir that travels with a session.
  mkdirSync(join(projectsDir, WELL, GONE, 'subagents'), { recursive: true })
  writeFileSync(join(projectsDir, WELL, GONE, 'subagents', 'agent-x.jsonl'), '{}\n')

  const historyPath = join(root, 'history.jsonl')
  writeFileSync(
    historyPath,
    [
      JSON.stringify({ display: 'keep me', sessionId: KEEP, project: '/x' }),
      JSON.stringify({ display: 'the secret phrase', sessionId: GONE, project: '/x' }),
      JSON.stringify({ display: 'also gone', sessionId: GONE, project: '/x' }),
      '',
    ].join('\n'),
  )
  writeFileSync(join(archiveDir, 'history.jsonl'), `${JSON.stringify({ display: 'the secret phrase', sessionId: GONE })}\n`)
  return { root, projectsDir, archiveDir, historyPath }
}

const Count = z.object({ n: z.number() })
const count = (db: ReturnType<typeof openDb>, sql: string, ...p: string[]) => Count.parse(db.prepare(sql).get(...p)).n

describe('purge', () => {
  test('dry run reports every copy and deletes nothing', async () => {
    const { projectsDir, archiveDir, historyPath } = lay()
    const db = openDb(':memory:')
    await buildIndex(db, { projectsDir, historyPath })

    const report = await purgeSession(db, '2222', { projectsDir, archiveDir, historyPath })
    expect(report.dryRun).toBe(true)
    expect(report.sessionId).toBe(GONE)
    expect(report.rows.sessions).toBe(1)
    expect(report.rows.messages).toBeGreaterThan(0)
    expect(report.files.map((f) => f.kind).sort()).toEqual(['archive', 'source', 'source'])
    expect(report.historyLines.reduce((n, h) => n + h.lines, 0)).toBe(3)

    expect(count(db, 'SELECT count(*) AS n FROM sessions WHERE session_id = ?', GONE)).toBe(1)
    expect(existsSync(join(projectsDir, WELL, `${GONE}.jsonl`))).toBe(true)
    expect((await Bun.file(historyPath).text()).split('\n').filter(Boolean)).toHaveLength(3)
  })

  test('--yes removes the rows, both trees, the sidecar dir and the history lines — and only this session', async () => {
    const { projectsDir, archiveDir, historyPath } = lay()
    const db = openDb(':memory:')
    await buildIndex(db, { projectsDir, historyPath })

    const report = await purgeSession(db, GONE, { projectsDir, archiveDir, historyPath, yes: true })
    expect(report.dryRun).toBe(false)

    for (const t of ['sessions', 'messages', 'requests', 'history'])
      expect(count(db, `SELECT count(*) AS n FROM ${t} WHERE session_id = ?`, GONE)).toBe(0)
    // The FTS is the copy that outlives a naive delete: the text has to go too.
    expect(count(db, "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'secret'")).toBe(1)

    expect(existsSync(join(projectsDir, WELL, `${GONE}.jsonl`))).toBe(false)
    expect(existsSync(join(projectsDir, WELL, GONE))).toBe(false)
    expect(existsSync(join(archiveDir, 'projects', WELL, `${GONE}.jsonl`))).toBe(false)

    const history = (await Bun.file(historyPath).text()).split('\n').filter(Boolean)
    expect(history).toHaveLength(1)
    expect(history[0]).toContain('keep me')
    expect(await Bun.file(join(archiveDir, 'history.jsonl')).text()).toBe('\n')

    // The neighbour is untouched in every copy.
    expect(count(db, 'SELECT count(*) AS n FROM sessions WHERE session_id = ?', KEEP)).toBe(1)
    expect(existsSync(join(projectsDir, WELL, `${KEEP}.jsonl`))).toBe(true)
    expect(existsSync(join(archiveDir, 'projects', WELL, `${KEEP}.jsonl`))).toBe(true)
  })

  test('a re-index does not resurrect it', async () => {
    const { projectsDir, archiveDir, historyPath } = lay()
    const db = openDb(':memory:')
    await buildIndex(db, { projectsDir, historyPath })
    await purgeSession(db, GONE, { projectsDir, archiveDir, historyPath, yes: true })
    await buildIndex(db, { projectsDir, historyPath })
    expect(count(db, 'SELECT count(*) AS n FROM sessions WHERE session_id = ?', GONE)).toBe(0)
    expect(count(db, 'SELECT count(*) AS n FROM history WHERE session_id = ?', GONE)).toBe(0)
  })

  test('--index-only unindexes and leaves every file', async () => {
    const { projectsDir, archiveDir, historyPath } = lay()
    const db = openDb(':memory:')
    await buildIndex(db, { projectsDir, historyPath })
    const report = await purgeSession(db, GONE, { projectsDir, archiveDir, historyPath, yes: true, indexOnly: true })
    expect(report.files).toEqual([])
    expect(count(db, 'SELECT count(*) AS n FROM sessions WHERE session_id = ?', GONE)).toBe(0)
    expect(existsSync(join(projectsDir, WELL, `${GONE}.jsonl`))).toBe(true)
    // ...and the next index brings it back, which is the whole point of the flag.
    await buildIndex(db, { projectsDir, historyPath })
    expect(count(db, 'SELECT count(*) AS n FROM sessions WHERE session_id = ?', GONE)).toBe(1)
  })

  test('resolves a session whose row is already gone, off the files alone', async () => {
    const { projectsDir, archiveDir, historyPath } = lay()
    const db = openDb(':memory:')
    const report = await purgeSession(db, '2222', { projectsDir, archiveDir, historyPath, yes: true })
    expect(report.indexed).toBe(false)
    expect(report.sessionId).toBe(GONE)
    expect(existsSync(join(projectsDir, WELL, `${GONE}.jsonl`))).toBe(false)
  })

  test('an ambiguous prefix is an error, and an unknown one too', async () => {
    const { projectsDir, archiveDir, historyPath } = lay()
    const db = openDb(':memory:')
    await buildIndex(db, { projectsDir, historyPath })
    expect(purgeSession(db, '', { projectsDir, archiveDir, historyPath })).rejects.toThrow(/ambiguous/)
    expect(purgeSession(db, 'deadbeef', { projectsDir, archiveDir, historyPath })).rejects.toThrow(/nothing to purge/)
  })
})
