import { appendFileSync, constants, copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync, utimesSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export type ArchiveStats = { dest: string; filesTransferred: number; totalBytes: number; durationMs: number }

// Additive mirror (no --delete): files removed at the source — retention,
// deleted worktree wells — stay preserved in the archive. That property IS
// the archive; never "clean it up" to match the source.
//
// Implemented in-process rather than shelling out to rsync: rsync is absent
// on Windows, and the two rsyncs we did support disagreed on their --stats
// wording (openrsync "files transferred" vs GNU "regular files transferred"),
// so the numbers below came from parsing prose. Now they are counted.
export async function archive(opts: {
  claudeDir: string
  archiveDir: string
  paths?: string[]
}): Promise<ArchiveStats> {
  const started = performance.now()
  mkdirSync(opts.archiveDir, { recursive: true })
  const paths = opts.paths ?? ['projects', 'history.jsonl', 'todos']

  const tally = { filesTransferred: 0, totalBytes: 0 }
  for (const p of paths) {
    const src = join(opts.claudeDir, p)
    if (!lstat(src)) continue
    mirror(src, join(opts.archiveDir, basename(src)), tally)
  }

  const stats: ArchiveStats = {
    dest: opts.archiveDir,
    ...tally,
    durationMs: Math.round(performance.now() - started),
  }
  appendFileSync(join(opts.archiveDir, 'manifest.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...stats }) + '\n')
  return stats
}

type Tally = { filesTransferred: number; totalBytes: number }

function lstat(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function mirror(src: string, dest: string, tally: Tally): void {
  const st = lstat(src)
  if (!st) return

  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true })
    for (const entry of readdirSync(src)) mirror(join(src, entry), join(dest, entry), tally)
    return
  }

  // Symlinks are recreated as links (rsync -a), never followed — following
  // one out of ~/.claude would pull in unrelated trees, and a directory cycle
  // would not terminate. Creating them needs a privilege Windows withholds by
  // default, so a refusal degrades to copying the target when it is a regular
  // file, and is skipped when it isn't. Nothing inside ~/.claude has ever
  // been a symlink; this is here so the mirror can't silently corrupt if that
  // changes.
  if (st.isSymbolicLink()) {
    const target = readlinkSync(src)
    const prev = lstat(dest)
    if (prev?.isSymbolicLink() && readlinkSync(dest) === target) return // already mirrored
    try {
      symlinkSync(target, dest)
    } catch {
      const resolved = lstat(resolve(dirname(src), target))
      if (resolved?.isFile()) copyFile(src, dest, tally)
    }
    return
  }

  if (!st.isFile()) return // sockets, fifos: not our data

  // rsync's default quick check — size, then mtime to whole seconds, which is
  // the coarsest granularity any filesystem under us records.
  const prev = lstat(dest)
  if (prev?.isFile() && prev.size === st.size && Math.floor(prev.mtimeMs / 1000) === Math.floor(st.mtimeMs / 1000)) return
  copyFile(src, dest, tally)
}

function copyFile(src: string, dest: string, tally: Tally): void {
  const st = statSync(src) // follows: in the symlink fallback the link's own size would understate the copy
  mkdirSync(dirname(dest), { recursive: true })
  // FICLONE makes this a metadata-only copy-on-write clone on APFS and Btrfs,
  // and is ignored elsewhere — never an error, so no fallback path needed.
  copyFileSync(src, dest, constants.COPYFILE_FICLONE)
  // Preserve mtime: rsync -a does, and the quick check above depends on it.
  utimesSync(dest, st.atime, st.mtime)
  tally.filesTransferred += 1
  tally.totalBytes += st.size
}
