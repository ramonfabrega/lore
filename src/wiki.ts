import { spawnSync } from 'node:child_process'

export type WikiCommitResult = {
  committed: boolean
  sha: string | null
  files: string[]
}

function git(wikiDir: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', wikiDir, ...args], { encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() }
}

// The passage model: a wiki mutation isn't durable until committed, and the
// commit is the tool's job — not the harness's, so it holds under any driver
// (interactive session, subagent, `claude -p`). No-op when the tree is clean.
export function wikiCommit(wikiDir: string, message?: string): WikiCommitResult {
  const status = git(wikiDir, 'status', '--porcelain')
  if (!status.ok) throw new Error(`not a git repo: ${wikiDir}`)
  if (!status.out) return { committed: false, sha: null, files: [] }
  git(wikiDir, 'add', '-A')
  const files = git(wikiDir, 'diff', '--cached', '--name-only').out.split('\n').filter(Boolean)
  const msg = message ?? `auto: ${files.slice(0, 5).join(' ')}`
  const commit = git(wikiDir, 'commit', '-q', '-m', msg)
  if (!commit.ok) throw new Error(`git commit failed in ${wikiDir}`)
  return { committed: true, sha: git(wikiDir, 'rev-parse', '--short', 'HEAD').out, files }
}
