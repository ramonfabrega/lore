import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDb } from '../src/db'
import { RELAYS_SQL } from '../src/job'

// A fixture cannot feel a bad plan: the relays query of `listJobs` passed
// every test and then did not finish on the real index, because the planner
// (no statistics in lore.db) walked `idx_messages_lane` for the sender's
// half of each message instead of `idx_messages_msg` — every relay row
// against every tool row. So this reads the plan the planner picks on an
// index with no statistics, which is the production condition.
test('the relays query finds the sender half by msg_id, never by scanning a lane', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'lore-job-plan-')), 'lore.db'))
  const plan = z
    .array(z.object({ detail: z.string() }))
    .parse(db.prepare(`EXPLAIN QUERY PLAN ${RELAYS_SQL}`).all())
    .map((r) => r.detail)
  const senderHalf = plan.filter((d) => /^SEARCH a /.test(d))
  expect(senderHalf.length).toBeGreaterThan(0)
  for (const d of senderHalf) expect(d).toContain('idx_messages_msg')
})
