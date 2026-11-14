import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import { discoverWorktreeDirs, listWorktrees, narrowToRepo, parseCherry, parseDu, parseLsofCwd, parseWorktreeList, prLabel, repoFromCommonDir, repoKey, type WorktreesReport } from '../src/worktrees'

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

describe('narrowToRepo', () => {
  test('--repo keeps claude rows by their path-derived key before anything is read, and every codex row', () => {
    const found = [
      { path: '/c/fun/lore/.claude/worktrees/a', minter: 'claude' as const },
      { path: '/c/fun/attrition/.claude/worktrees/b', minter: 'claude' as const },
      { path: '/x/.codex/worktrees/31a0/attrition', minter: 'codex' as const },
    ]
    expect(narrowToRepo(found, '/c', 'fun/lore').map((f) => f.path)).toEqual(['/c/fun/lore/.claude/worktrees/a', '/x/.codex/worktrees/31a0/attrition'])
    expect(narrowToRepo(found, '/c', undefined)).toEqual(found)
  })
})

// The reading over real git: a fixture code dir built the way the Studio's
// is (2026-11-14 review). One repo has a worktree whose two commits were
// squash-merged into main, and a stray dir under .claude/worktrees that is
// not a worktree at all (cuanto had `.claude/worktrees/node_modules`), with
// its root checkout dirty. One repo sits on a path with a space, with a
// worktree named in non-ASCII and a process inside it. One repo sits
// directly under the code dir and one three deep (~/code/mirador,
// ~/code/games/rs/runelite-mobile).
describe('listWorktrees', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'lore-worktrees-read-')))
  const code = join(root, 'code')
  let report: WorktreesReport
  let sleeper: ReturnType<typeof Bun.spawn> | null = null
  const g = (cwd: string, ...args: string[]) => $`git -C ${cwd} -c user.name=t -c user.email=t@t ${args}`.quiet()
  async function mkRepo(path: string) {
    mkdirSync(path, { recursive: true })
    await $`git init -q -b main ${path}`.quiet()
    writeFileSync(join(path, 'README'), 'x\n')
    writeFileSync(join(path, '.gitignore'), '.claude/\n')
    await g(path, 'add', '-A')
    await g(path, 'commit', '-q', '-m', 'init')
  }

  beforeAll(async () => {
    const r1 = join(code, 'fun', 'r1')
    await mkRepo(r1)
    const sq = join(r1, '.claude', 'worktrees', 'sq')
    await g(r1, 'worktree', 'add', '-q', '-b', 'sq', sq)
    writeFileSync(join(sq, 'a.txt'), 'a\n')
    await g(sq, 'add', '-A')
    await g(sq, 'commit', '-q', '-m', 'a')
    writeFileSync(join(sq, 'b.txt'), 'b\n')
    await g(sq, 'add', '-A')
    await g(sq, 'commit', '-q', '-m', 'b')
    await g(r1, 'merge', '--squash', 'sq')
    await g(r1, 'commit', '-q', '-m', 'squash sq (#1)')
    // a branch with work base does not have: never landed
    const open = join(r1, '.claude', 'worktrees', 'open')
    await g(r1, 'worktree', 'add', '-q', '-b', 'open', open)
    writeFileSync(join(open, 'c.txt'), 'c\n')
    await g(open, 'add', '-A')
    await g(open, 'commit', '-q', '-m', 'c')
    mkdirSync(join(r1, '.claude', 'worktrees', 'node_modules'), { recursive: true })
    writeFileSync(join(r1, '.claude', 'worktrees', 'node_modules', '.yarn-integrity'), '{}')
    writeFileSync(join(r1, 'README'), 'modified in the ROOT checkout\n')

    const r2 = join(code, 'fun', 'my repo')
    await mkRepo(r2)
    await g(r2, 'worktree', 'add', '-q', '-b', 'sp', join(r2, '.claude', 'worktrees', 'with space'))
    const acc = join(r2, '.claude', 'worktrees', 'café')
    await g(r2, 'worktree', 'add', '-q', '-b', 'acc', acc)

    const top = join(code, 'mirador')
    await mkRepo(top)
    await g(top, 'worktree', 'add', '-q', '-b', 'bg', join(top, '.claude', 'worktrees', 'bg-space'))
    const deep = join(code, 'games', 'rs', 'runelite-mobile')
    await mkRepo(deep)
    await g(deep, 'worktree', 'add', '-q', '-b', 'wd', join(deep, '.claude', 'worktrees', 'window-discovery-fix'))

    sleeper = Bun.spawn(['sleep', '60'], { cwd: acc })
    await Bun.sleep(300)
    report = await listWorktrees({ codeDir: code, codexDir: join(root, '.codex-none') })
  })
  afterAll(() => {
    sleeper?.kill()
  })
  const row = (name: string) => report.worktrees.find((r) => r.name === name)!

  test('a branch squash-merged as one commit reads landed, though cherry matches neither commit', () => {
    expect(row('sq')).toMatchObject({ registered: true, ancestor: false, landed: true })
    expect(row('open')).toMatchObject({ registered: true, ancestor: false, landed: false })
  })

  test('a dir under .claude/worktrees with no .git borrows nothing from the root checkout', () => {
    expect(row('node_modules')).toMatchObject({ registered: false, branch: null, head: null, dirty: null, ancestor: null, landed: null })
  })

  test('repos directly under the code dir and three deep are in the inventory', () => {
    expect(row('bg-space')).toMatchObject({ repo: 'mirador', registered: true })
    expect(row('window-discovery-fix')).toMatchObject({ repo: 'games/rs/runelite-mobile', registered: true })
  })

  test('paths with a space and non-ASCII names read, size and hold their processes', () => {
    expect(row('with space')).toMatchObject({ repo: 'fun/my repo', registered: true })
    expect(row('with space').bytes).toBeGreaterThan(0)
    expect(row('café').registered).toBe(true)
    expect(row('café').pids).toContain(sleeper!.pid)
    expect(report.orphanProcesses.map((p) => p.pid)).not.toContain(sleeper!.pid)
  })

  test('--repo narrows the whole report', async () => {
    const r = await listWorktrees({ codeDir: code, codexDir: join(root, '.codex-none'), repo: 'mirador' })
    expect(r.worktrees.map((w) => w.name)).toEqual(['bg-space'])
  })
})
