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

  // `-c` overrides config, and init passed both fallback keys always, so every
  // first commit read `lore` whatever the user had configured (2026-11-14).
  async function initUnder(gitconfig: string): Promise<{ name: string; email: string }> {
    const home = tempDir()
    writeFileSync(join(home, '.gitconfig'), gitconfig)
    const keys = ['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const
    const prev = keys.map((k) => process.env[k])
    process.env.HOME = home
    process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    try {
      const dir = join(home, 'wiki')
      await wikiInit(dir)
      const [name = '', email = ''] = (await Bun.$`git -C ${dir} log -1 --format=%an%n%ae`.quiet().text()).trim().split('\n')
      return { name, email }
    } finally {
      keys.forEach((k, i) => {
        if (prev[i] === undefined) delete process.env[k]
        else process.env[k] = prev[i]
      })
    }
  }

  test('the first commit is the user when git config names one, lore only for a missing key', async () => {
    expect(await initUnder('[user]\n\tname = Real Person\n\temail = real@example.com\n')).toEqual({ name: 'Real Person', email: 'real@example.com' })
    expect(await initUnder('[user]\n\tname = Real Person\n')).toEqual({ name: 'Real Person', email: 'lore@localhost' })
    expect(await initUnder('')).toEqual({ name: 'lore', email: 'lore@localhost' })
  })

  test('commit names the fix when no wiki exists', async () => {
    const dir = join(tempDir(), 'missing')
    await expect(wikiCommit(dir)).rejects.toThrow(/lore wiki init/)
  })
})
