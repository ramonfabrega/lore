import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { ftsMatch, quoteFtsTokens } from '../src/fts'

function ftsDb(): Database {
  const db = new Database(':memory:')
  db.run('CREATE VIRTUAL TABLE t USING fts5(text)')
  const insert = db.prepare('INSERT INTO t(text) VALUES(?)')
  insert.run('the three-tier knowledge model lives here')
  insert.run("don't confirm — refute-don't-confirm is the verifier stance")
  insert.run('xcode-build-server reconciles the compile db')
  insert.run('plain sparkle notarization doctrine')
  return db
}

function search(db: Database, query: string): string[] {
  return ftsMatch(query, (q) =>
    db
      .prepare('SELECT text FROM t WHERE t MATCH ? ORDER BY rank')
      .all(q)
      .map((r) => (r as { text: string }).text),
  )
}

describe('quoteFtsTokens', () => {
  test('quotes each whitespace token as a phrase, doubling inner quotes', () => {
    expect(quoteFtsTokens('three-tier model')).toBe('"three-tier" "model"')
    expect(quoteFtsTokens('  spaced   out  ')).toBe('"spaced" "out"')
    expect(quoteFtsTokens('say "hi"')).toBe('"say" """hi"""')
  })
})

describe('ftsMatch', () => {
  test('valid FTS5 syntax passes through untouched', () => {
    expect(search(ftsDb(), 'sparkle AND notarization')).toHaveLength(1)
    expect(search(ftsDb(), '"knowledge model"')).toHaveLength(1)
    expect(search(ftsDb(), 'notar*')).toHaveLength(1)
  })

  test('bare hyphenated term (column-filter misparse) falls back to literal phrase', () => {
    // Raw: `no such column: tier`. Fallback quotes it; the tokenizer splits
    // hyphens identically at index and query time, so the phrase matches.
    expect(search(ftsDb(), 'three-tier')).toHaveLength(1)
    expect(search(ftsDb(), 'xcode-build-server')).toHaveLength(1)
  })

  test('apostrophes and stray quotes fall back instead of leaking fts5 errors', () => {
    expect(search(ftsDb(), "refute-don't-confirm")).toHaveLength(1)
    expect(search(ftsDb(), '"sparkle')).toHaveLength(1)
  })

  test('hyphenated term mixed with plain terms still matches', () => {
    expect(search(ftsDb(), 'three-tier knowledge')).toHaveLength(1)
  })

  test('a query that fails even quoted throws a clean error, not raw SQL', () => {
    expect(() => search(ftsDb(), '   ')).toThrow(/invalid FTS5 query/)
  })

  test('non-parse errors rethrow untouched', () => {
    expect(() =>
      ftsMatch('fine', () => {
        throw new Error('disk I/O error')
      }),
    ).toThrow('disk I/O error')
  })
})
