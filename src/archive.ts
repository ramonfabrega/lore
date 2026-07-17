import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type ArchiveStats = { dest: string; filesTransferred: number; totalBytes: number; durationMs: number }

// Additive mirror (no --delete): files removed at the source — retention,
// deleted worktree wells — stay preserved in the archive. That property IS
// the archive; never "clean it up" to match the source.
export async function archive(opts: {
  claudeDir: string
  archiveDir: string
  paths?: string[]
}): Promise<ArchiveStats> {
  const started = performance.now()
  mkdirSync(opts.archiveDir, { recursive: true })
  const paths = opts.paths ?? ['projects', 'history.jsonl', 'todos']

  let filesTransferred = 0
  let totalBytes = 0
  for (const p of paths) {
    const src = join(opts.claudeDir, p)
    if (!(await Bun.file(src).exists()) && !(await isDir(src))) continue
    const proc = Bun.spawn(['rsync', '-a', '--stats', src, `${opts.archiveDir}/`], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) throw new Error(`rsync ${p} failed (${code}): ${await new Response(proc.stderr).text()}`)
    // GNU rsync: "Number of regular files transferred"; openrsync (macOS 15+): "Number of files transferred"
    filesTransferred += statNum(out, /Number of (?:regular )?files transferred: ([\d,]+)/)
    totalBytes += statNum(out, /Total transferred file size: ([\d,]+)/)
  }

  const stats: ArchiveStats = {
    dest: opts.archiveDir,
    filesTransferred,
    totalBytes,
    durationMs: Math.round(performance.now() - started),
  }
  appendFileSync(join(opts.archiveDir, 'manifest.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...stats }) + '\n')
  return stats
}

async function isDir(path: string): Promise<boolean> {
  try {
    const { statSync } = await import('node:fs')
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function statNum(out: string, re: RegExp): number {
  const m = out.match(re)
  return m?.[1] ? Number(m[1].replaceAll(',', '')) : 0
}
