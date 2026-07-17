import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wikiCommit } from '../src/wiki'

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-wiki-test-'))
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir })
  return dir
}

describe('wikiCommit', () => {
  test('clean tree is a no-op', async () => {
    const dir = tempRepo()
    expect(await wikiCommit(dir)).toEqual({ committed: false, sha: null, files: [] })
  })

  test('commits pending changes with auto message from file list', async () => {
    const dir = tempRepo()
    writeFileSync(join(dir, 'index.md'), '# index\n')
    writeFileSync(join(dir, 'log.md'), '# log\n')
    const r = await wikiCommit(dir)
    expect(r.committed).toBe(true)
    expect(r.files.sort()).toEqual(['index.md', 'log.md'])
    const msg = execSync('git log -1 --format=%s', { cwd: dir, encoding: 'utf8' }).trim()
    expect(msg).toBe('auto: index.md log.md')
    expect(execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).trim()).toBe('')
  })

  test('explicit message wins', async () => {
    const dir = tempRepo()
    writeFileSync(join(dir, 'x.md'), 'x\n')
    const r = await wikiCommit(dir, 'ingest: x')
    expect(r.committed).toBe(true)
    expect(execSync('git log -1 --format=%s', { cwd: dir, encoding: 'utf8' }).trim()).toBe('ingest: x')
  })

  test('non-repo throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lore-wiki-test-'))
    expect(wikiCommit(dir)).rejects.toThrow('not a git repo')
  })
})
