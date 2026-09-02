import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { buildIndex } from '../src/indexer'
import { getTrace } from '../src/trace'
import { seedDemo } from '../scripts/demo'

// The demo corpus exists to be photographed, and a screenshot of a shape the
// harness no longer writes is worse than no screenshot: it is a confident,
// wrong picture of the tool. Nothing else asserts on this generator, so if the
// record shapes drift, these are the tests that notice.
describe('demo corpus', () => {
  test('indexes, and the block view has the parts a capture needs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lore-demo-test-'))
    try {
      const c = await seedDemo(root)
      expect(c.sessions).toBeGreaterThan(20)
      expect(c.showcaseSessionId).not.toBe('')

      const db = openDb(':memory:')
      const stats = await buildIndex(db, {
        projectsDir: c.projectsDir,
        historyPath: join(c.projectsDir, 'nope.jsonl'),
      })
      // Every seeded session parses — a shape change would skip them instead.
      expect(stats.sessionsIndexed).toBe(c.sessions)

      const trace = getTrace(db, c.showcaseSessionId, { limit: 50, exact: true })
      // The three things the session page renders, and the three the fixture
      // could silently stop producing: prompts, tool calls, and priced requests.
      expect(trace.transactions.length).toBeGreaterThan(5)
      const instructions = trace.transactions.reduce((n, t) => n + t.instructions.length, 0)
      expect(instructions).toBeGreaterThan(5)
      expect(trace.totals.listUsd).toBeGreaterThan(0)

      // Prompts are sampled without replacement, so a session never repeats one.
      const prompts = trace.transactions.map((t) => t.prompt)
      expect(new Set(prompts).size).toBe(prompts.length)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('is deterministic — a recapture differs only where the explorer changed', async () => {
    const a = mkdtempSync(join(tmpdir(), 'lore-demo-a-'))
    const b = mkdtempSync(join(tmpdir(), 'lore-demo-b-'))
    try {
      const one = await seedDemo(a)
      const two = await seedDemo(b)
      expect(two.showcaseSessionId).toBe(one.showcaseSessionId)
      expect(two.sessions).toBe(one.sessions)
      const read = (c: typeof one) => Bun.file(join(c.projectsDir, c.showcaseWellDir, `${c.showcaseSessionId}.jsonl`)).text()
      expect(await read(two)).toBe(await read(one))
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })
})
