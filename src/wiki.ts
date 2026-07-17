import { $ } from 'bun'

export type WikiCommitResult = {
  committed: boolean
  sha: string | null
  files: string[]
}

async function git(wikiDir: string, ...args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await $`git -C ${wikiDir} ${args}`.quiet().nothrow()
  return { ok: r.exitCode === 0, out: r.text().trim() }
}

// The passage model: a wiki mutation isn't durable until committed, and the
// commit is the tool's job — not the harness's, so it holds under any driver
// (interactive session, subagent, `claude -p`). No-op when the tree is clean.
export async function wikiCommit(wikiDir: string, message?: string): Promise<WikiCommitResult> {
  const status = await git(wikiDir, 'status', '--porcelain')
  if (!status.ok) throw new Error(`not a git repo: ${wikiDir}`)
  if (!status.out) return { committed: false, sha: null, files: [] }
  await git(wikiDir, 'add', '-A')
  const files = (await git(wikiDir, 'diff', '--cached', '--name-only')).out.split('\n').filter(Boolean)
  const msg = message ?? `auto: ${files.slice(0, 5).join(' ')}`
  const commit = await git(wikiDir, 'commit', '-q', '-m', msg)
  if (!commit.ok) throw new Error(`git commit failed in ${wikiDir}`)
  return { committed: true, sha: (await git(wikiDir, 'rev-parse', '--short', 'HEAD')).out, files }
}
