import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archive } from '../src/archive'

// A ~/.claude shaped enough to exercise the real mirror: nested wells, the
// subagents/ and workflows/ depth, a loose top-level file, and a sibling dir.
function fixture(): { claudeDir: string; archiveDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'lore-archive-test-'))
  const claudeDir = join(root, 'claude')
  const well = join(claudeDir, 'projects', '-Users-x-code-lore')
  mkdirSync(join(well, 'subagents', 'workflows', 'wf_abc'), { recursive: true })
  mkdirSync(join(well, 'memory'), { recursive: true })
  mkdirSync(join(claudeDir, 'todos'), { recursive: true })
  writeFileSync(join(well, 'a.jsonl'), '{"type":"user"}\n')
  writeFileSync(join(well, 'subagents', 'sub.jsonl'), '{"agent":true}\n')
  writeFileSync(join(well, 'subagents', 'workflows', 'wf_abc', 'run.json'), '{"meta":1}\n')
  writeFileSync(join(well, 'memory', 'MEMORY.md'), '- a memory\n')
  writeFileSync(join(claudeDir, 'history.jsonl'), '{"display":"hi"}\n')
  writeFileSync(join(claudeDir, 'todos', 't.json'), '[]\n')
  // Not in the default path list — must never be mirrored.
  writeFileSync(join(claudeDir, 'settings.json'), '{"secret":true}\n')
  return { claudeDir, archiveDir: join(root, 'archive') }
}

describe('archive', () => {
  test('mirrors the tree, preserving structure and content', async () => {
    const { claudeDir, archiveDir } = fixture()
    const stats = await archive({ claudeDir, archiveDir })

    const well = join(archiveDir, 'projects', '-Users-x-code-lore')
    expect(readFileSync(join(well, 'a.jsonl'), 'utf8')).toBe('{"type":"user"}\n')
    expect(readFileSync(join(well, 'subagents', 'workflows', 'wf_abc', 'run.json'), 'utf8')).toBe('{"meta":1}\n')
    expect(readFileSync(join(well, 'memory', 'MEMORY.md'), 'utf8')).toBe('- a memory\n')
    expect(readFileSync(join(archiveDir, 'history.jsonl'), 'utf8')).toBe('{"display":"hi"}\n')
    expect(readFileSync(join(archiveDir, 'todos', 't.json'), 'utf8')).toBe('[]\n')

    // Only the requested paths cross over.
    expect(existsSync(join(archiveDir, 'settings.json'))).toBe(false)

    expect(stats.filesTransferred).toBe(6)
    expect(stats.totalBytes).toBeGreaterThan(0)
    expect(stats.dest).toBe(archiveDir)
  })

  test('is additive: a source deleted after archiving stays preserved', async () => {
    const { claudeDir, archiveDir } = fixture()
    await archive({ claudeDir, archiveDir })

    // The retention purge / a deleted worktree well.
    rmSync(join(claudeDir, 'projects', '-Users-x-code-lore'), { recursive: true })
    const second = await archive({ claudeDir, archiveDir })

    expect(readFileSync(join(archiveDir, 'projects', '-Users-x-code-lore', 'a.jsonl'), 'utf8')).toBe('{"type":"user"}\n')
    expect(second.filesTransferred).toBe(0)
  })

  test('a second run transfers nothing; a changed file transfers again', async () => {
    const { claudeDir, archiveDir } = fixture()
    await archive({ claudeDir, archiveDir })
    expect((await archive({ claudeDir, archiveDir })).filesTransferred).toBe(0)

    // Transcripts grow by append — the size check alone catches this.
    const grown = join(claudeDir, 'projects', '-Users-x-code-lore', 'a.jsonl')
    writeFileSync(grown, '{"type":"user"}\n{"type":"assistant"}\n')
    const third = await archive({ claudeDir, archiveDir })
    expect(third.filesTransferred).toBe(1)
    expect(readFileSync(join(archiveDir, 'projects', '-Users-x-code-lore', 'a.jsonl'), 'utf8')).toContain('assistant')
  })

  test('same size, different mtime still transfers (edit in place)', async () => {
    const { claudeDir, archiveDir } = fixture()
    await archive({ claudeDir, archiveDir })

    const edited = join(claudeDir, 'todos', 't.json')
    writeFileSync(edited, '[]\n') // identical length
    const later = new Date(Date.now() + 10_000)
    utimesSync(edited, later, later)

    expect((await archive({ claudeDir, archiveDir })).filesTransferred).toBe(1)
  })

  test('preserves mtime, so the quick check stays stable across runs', async () => {
    const { claudeDir, archiveDir } = fixture()
    await archive({ claudeDir, archiveDir })
    const src = statSync(join(claudeDir, 'history.jsonl'))
    const dst = statSync(join(archiveDir, 'history.jsonl'))
    expect(Math.floor(dst.mtimeMs / 1000)).toBe(Math.floor(src.mtimeMs / 1000))
  })

  test('appends one manifest line per run', async () => {
    const { claudeDir, archiveDir } = fixture()
    await archive({ claudeDir, archiveDir })
    await archive({ claudeDir, archiveDir })
    const lines = readFileSync(join(archiveDir, 'manifest.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0] as string)
    expect(first.filesTransferred).toBe(6)
    expect(typeof first.ts).toBe('string')
  })

  test('a missing source path is skipped, not an error', async () => {
    const { claudeDir, archiveDir } = fixture()
    const stats = await archive({ claudeDir, archiveDir, paths: ['projects', 'nope-not-here'] })
    expect(stats.filesTransferred).toBe(4)
  })

  // Symlink creation needs a privilege Windows withholds from unelevated
  // processes; the mirror's fallback is exercised by that refusal in the
  // wild, not here.
  test.skipIf(process.platform === 'win32')('recreates symlinks as links, never following them', async () => {
    const { claudeDir, archiveDir } = fixture()
    const well = join(claudeDir, 'projects', '-Users-x-code-lore')
    symlinkSync(join(well, 'a.jsonl'), join(well, 'link.jsonl'))

    await archive({ claudeDir, archiveDir })
    const mirrored = join(archiveDir, 'projects', '-Users-x-code-lore', 'link.jsonl')
    expect(statSync(mirrored).isFile()).toBe(true) // resolves through the link
    expect(readFileSync(mirrored, 'utf8')).toBe('{"type":"user"}\n')

    // And it is not re-transferred on the next run.
    expect((await archive({ claudeDir, archiveDir })).filesTransferred).toBe(0)
  })
})
