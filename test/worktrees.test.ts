import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverWorktreeDirs, parseCherry, parseDu, parseLsofCwd, parseWorktreeList, prLabel, repoFromCommonDir, repoKey } from '../src/worktrees'

// Samples cut from the 2026-10-15 cleanup on the Studio.

describe('parseLsofCwd', () => {
  test('pairs each p line with the n line that follows', () => {
    const m = parseLsofCwd('p9208\nn/Users/x/code/work/cuanto/.claude/worktrees/drain/api\np65212\nn/Users/x/gone\n')
    expect(m.get(9208)).toBe('/Users/x/code/work/cuanto/.claude/worktrees/drain/api')
    expect(m.get(65212)).toBe('/Users/x/gone')
    expect(m.size).toBe(2)
  })
})

describe('parseWorktreeList', () => {
  test('reads the worktree paths out of the porcelain form', () => {
    const out = 'worktree /Users/x/code/fun/ccc\nHEAD 933b9b6\nbranch refs/heads/master\n\nworktree /Users/x/code/fun/ccc/.claude/worktrees/v2\nHEAD 933b9b6\nbranch refs/heads/worktree-v2\n'
    expect(parseWorktreeList(out)).toEqual(['/Users/x/code/fun/ccc', '/Users/x/code/fun/ccc/.claude/worktrees/v2'])
  })
})

describe('parseCherry', () => {
  test('landed when every commit has an equivalent patch upstream', () => {
    expect(parseCherry('- 2a39678f\n- e4d4aaa6\n')).toEqual({ commits: 2, landed: true })
  })
  test('not landed while any commit is still only here', () => {
    expect(parseCherry('- 2a39678f\n+ e4d4aaa6\n')).toEqual({ commits: 2, landed: false })
  })
  test('nothing beyond base is not "landed" — that is the ancestor case', () => {
    expect(parseCherry('')).toEqual({ commits: 0, landed: false })
  })
})

describe('parseDu', () => {
  test('bytes per path', () => {
    const m = parseDu('29400000\t/a/attrition/.claude/worktrees\n6200000\t/a/ccc/.claude/worktrees\n')
    expect(m.get('/a/attrition/.claude/worktrees')).toBe(29400000 * 1024)
    expect(m.size).toBe(2)
  })
})

describe('prLabel', () => {
  test('joins state and number per PR', () => {
    expect(prLabel('[{"state":"MERGED","number":5195}]')).toBe('MERGED#5195')
    expect(prLabel('[{"state":"OPEN","number":5242},{"state":"CLOSED","number":5100}]')).toBe('OPEN#5242,CLOSED#5100')
  })
  test('none for an empty list or garbage', () => {
    expect(prLabel('[]')).toBe('none')
    expect(prLabel('not json')).toBe('none')
  })
})

describe('repoKey / repoFromCommonDir', () => {
  test('relative to the code dir inside it, the path itself outside', () => {
    expect(repoKey('/Users/x/code/fun/attrition', '/Users/x/code')).toBe('fun/attrition')
    expect(repoKey('/Users/x/code/fun/attrition', '/Users/x/code/')).toBe('fun/attrition')
    expect(repoKey('/opt/elsewhere', '/Users/x/code')).toBe('/opt/elsewhere')
  })
  test('the repo is the parent of its .git', () => {
    expect(repoFromCommonDir('/Users/x/code/fun/attrition/.git\n')).toBe('/Users/x/code/fun/attrition')
    expect(repoFromCommonDir('')).toBe(null)
  })
})

describe('discoverWorktreeDirs', () => {
  test('finds <code>/<group>/<repo>/.claude/worktrees/* and <codex>/worktrees/<id>/<repo>', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'lore-worktrees-test-')))
    const code = join(root, 'code')
    const codex = join(root, '.codex')
    mkdirSync(join(code, 'fun', 'attrition', '.claude', 'worktrees', 'replan-pdb'), { recursive: true })
    mkdirSync(join(code, 'fun', 'attrition', '.claude', 'worktrees', 'agent-a1'), { recursive: true })
    mkdirSync(join(code, 'fun', 'plain', 'src'), { recursive: true })
    mkdirSync(join(codex, 'worktrees', '31a0', 'attrition'), { recursive: true })
    const found = discoverWorktreeDirs(code, codex).sort((a, b) => a.path.localeCompare(b.path))
    expect(found).toEqual([
      { path: join(codex, 'worktrees', '31a0', 'attrition'), minter: 'codex' },
      { path: join(code, 'fun', 'attrition', '.claude', 'worktrees', 'agent-a1'), minter: 'claude' },
      { path: join(code, 'fun', 'attrition', '.claude', 'worktrees', 'replan-pdb'), minter: 'claude' },
    ])
  })
  test('a missing code dir is an empty inventory, not an error', () => {
    expect(discoverWorktreeDirs('/nonexistent/code', '/nonexistent/.codex')).toEqual([])
  })
})
