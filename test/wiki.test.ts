import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WIKI_TEMPLATE, wikiCommit, wikiInit } from '../src/wiki'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'lore-wiki-test-'))
}

describe('wikiInit', () => {
  test('lays down the template as a git repo with one commit', async () => {
    const dir = join(tempDir(), 'wiki')
    const r = await wikiInit(dir)
    expect(r.dir).toBe(dir)
    expect(r.sha).toMatch(/^[0-9a-f]{7,}$/)
    expect(r.files.sort()).toEqual(Object.keys(WIKI_TEMPLATE).sort())
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('lore wiki commit')
    expect(readFileSync(join(dir, 'index.md'), 'utf8')).toMatch(/^# index/)
    // The template is real content, not a stub — it must carry the schema.
    for (const section of ['## Layout', '## Durability', '## Operations', '## Privacy']) {
      expect(WIKI_TEMPLATE['CLAUDE.md']).toContain(section)
    }
    // Clean after init: the first commit swept everything.
    expect(await wikiCommit(dir)).toEqual({ committed: false, sha: null, files: [] })
  })

  test('the initialised wiki accepts the passage model', async () => {
    const dir = join(tempDir(), 'wiki')
    await wikiInit(dir)
    writeFileSync(join(dir, 'projects', 'demo.md'), '# demo\n')
    const r = await wikiCommit(dir, 'ingest: demo')
    expect(r.committed).toBe(true)
    expect(r.files).toEqual(['projects/demo.md'])
  })

  test('refuses a non-empty directory', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'notes.md'), 'mine\n')
    await expect(wikiInit(dir)).rejects.toThrow(/non-empty/)
    // Nothing was written into the stranger's directory.
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false)
  })

  test('commit names the fix when no wiki exists', async () => {
    const dir = join(tempDir(), 'missing')
    await expect(wikiCommit(dir)).rejects.toThrow(/lore wiki init/)
  })
})
