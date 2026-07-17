#!/usr/bin/env bun
// Entrypoint kept separate from cli.ts: Bun auto-serves an entry module whose
// default export has .fetch (incur CLIs do), which would hang every invocation.
import cli from './cli'

// Self-identifying provenance on stderr (stdout stays parseable): installed
// artifacts get LORE_BUILD_INFO inlined by scripts/install; dev runs derive it
// from the checkout so transcripts always show WHICH lore did the work.
declare const LORE_BUILD_INFO: string
const provenance =
  typeof LORE_BUILD_INFO === 'string'
    ? LORE_BUILD_INFO
    : (() => {
        const dir = new URL('..', import.meta.url).pathname
        const git = (...args: string[]) =>
          new TextDecoder()
            .decode(Bun.spawnSync(['git', '-C', dir, ...args]).stdout)
            .trim()
        const sha = git('rev-parse', '--short', 'HEAD') || 'no-git'
        const dirty = git('status', '--porcelain') ? '+dirty' : ''
        return `dev @ ${sha}${dirty} (${dir})`
      })()
console.error(`lore ${provenance}`)

cli.serve()
