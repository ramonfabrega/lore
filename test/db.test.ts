import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDb } from '../src/db'

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'lore-db-')), 'lore.db')
}

test('openDb refuses a db newer than the build', () => {
  const path = tempDbPath()
  const raw = new Database(path)
  raw.exec('PRAGMA user_version = 9999')
  raw.close()
  expect(() => openDb(path)).toThrow(/stale lore/)
})

test('openDb rebuilds a db older than the build', () => {
  const path = tempDbPath()
  const raw = new Database(path)
  raw.exec('PRAGMA user_version = 1')
  raw.exec('CREATE TABLE sessions (junk TEXT)')
  raw.close()
  const db = openDb(path)
  const { user_version } = z
    .object({ user_version: z.number() })
    .parse(db.prepare('PRAGMA user_version').get())
  expect(user_version).toBeGreaterThan(1)
  // old table dropped and recreated with the real schema
  expect(() => db.prepare('SELECT session_id FROM sessions').all()).not.toThrow()
  db.close()
})
