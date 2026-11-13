import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { z } from 'zod'

// ccc's spawn ledger: which session spawned which job, as a FIELD.
//
// The daemon records no parentage, so lore read a spawn edge off the
// spawning session's transcript — `"ref":"<id>"` in a `ccc spawn --json`
// answer, or the harness's `backgrounded · <id>` (job.ts). That is the shape
// of a tool's output, and on 2026-11-13 it stopped being there: attrition's
// commander redirected the answer into a file and printed `ref branch base`
// through python, and lane-4199 … lane-4216 had no parent. A wider regex
// fixes one spelling and breaks on the next. ccc is the one place that
// knows both ends at the moment of a spawn, so it writes them down
// (ccc `cbeadc8`, asked 2026-11-13): one JSON line per spawn, appended by
// ccc itself whatever `--json` or stdout did, one write(2) under O_APPEND
// so parallel spawns each land whole. lore indexes it, the limits mod's
// pattern — the writer owns the file, `lore index` reads it.
//
// The line, v1 (every key on every line, null where ccc has nothing to
// say): `ts`, `kind` (`spawn`, or `fork` for `--from`), `child` (the daemon
// id, the same `ref`), `host` (ccc's name for the machine it ran on — a
// remote spawn is written on the Mac that ran `ccc`, so its child is not a
// local job), `via` (`cli` or `app`), `name`, `model` / `effort` (what was
// ASKED, never what served), `cwd`, `worktree`, `branch` (only when ccc cut
// the worktree), `replaced` (the daemon id a `--replace` stopped), `draft`,
// and `parent`: `{job, session, bridge}` or null — the caller as its
// ENVIRONMENT says, each field null on its own. `job` is the basename of
// `CLAUDE_JOB_DIR`, the daemon id, and survives /clear; `bridge` is
// `CLAUDE_CODE_BRIDGE_SESSION_ID` in the commit-trailer spelling
// (`session_…`); `session` is `CLAUDE_CODE_SESSION_ID`, the transcript live
// at the spawn, which moves at /clear — the one that says WHICH session of
// the job spawned this, and not a key. `parent: null` is a spawn typed by a
// person, which is a fact too.
//
// What it does not say: a successor from a lane. A handover that spawns
// the next seat and a commander that spawns a worker are both a named
// spawn by a session; `ccc clear --then` mints nothing and writes no line.
// The `cwd` and `worktree` are there to be read; a role would have to be a
// word the caller passes.
//
// Rows are kept, never replaced wholesale: the index outlives its sources
// (CLAUDE.md), and a ledger ccc rotates or a machine that loses the file
// must not take the edges with it. `(child, ts)` is the identity — a daemon
// id is minted once.

const Parent = z.object({ job: z.string().nullish(), session: z.string().nullish(), bridge: z.string().nullish() })
const Line = z
  .object({
    v: z.number(),
    ts: z.string(),
    kind: z.string(),
    child: z.string(),
    host: z.string().nullish(),
    via: z.string().nullish(),
    name: z.string().nullish(),
    model: z.string().nullish(),
    effort: z.string().nullish(),
    cwd: z.string().nullish(),
    worktree: z.string().nullish(),
    branch: z.string().nullish(),
    replaced: z.string().nullish(),
    draft: z.boolean().nullish(),
    parent: Parent.nullish(),
  })
  .loose()

// The kinds lore knows. ccc's word: skip the ones you do not, and `v` moves
// only when a field changes meaning — so both are counted, never guessed at.
export const LEDGER_KINDS = new Set(['spawn', 'fork'])
const LEDGER_VERSION = 1

export type LedgerStats = {
  // Lines read off the file this run, and rows the table holds after it.
  lines: number
  rows: number
  // What was left out, by why: a version lore does not read, a kind it does
  // not know, a line that is not the shape (a torn tail included).
  skipped: { version: number; kind: number; malformed: number }
  // False when the file is not there — ccc not installed, or no spawn yet.
  present: boolean
}

export async function indexSpawnLedger(db: Database, opts: { path: string }): Promise<LedgerStats> {
  const count = () => z.object({ n: z.number() }).parse(db.prepare('SELECT COUNT(*) AS n FROM spawn_ledger').get()).n
  const skipped = { version: 0, kind: 0, malformed: 0 }
  if (!existsSync(opts.path)) return { lines: 0, rows: count(), skipped, present: false }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO spawn_ledger(ts, child, kind, host, via, name, model, effort, cwd, worktree, branch, replaced, draft, parent_job, parent_session, parent_bridge)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  let lines = 0
  const load = db.transaction((text: string) => {
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      lines++
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        skipped.malformed++ // a torn tail: the file is appended live
        continue
      }
      const parsed = Line.safeParse(json)
      if (!parsed.success) {
        skipped.malformed++
        continue
      }
      const l = parsed.data
      if (l.v !== LEDGER_VERSION) {
        skipped.version++
        continue
      }
      if (!LEDGER_KINDS.has(l.kind)) {
        skipped.kind++
        continue
      }
      const at = new Date(l.ts)
      if (Number.isNaN(at.getTime())) {
        skipped.malformed++
        continue
      }
      // An instant is stored the way every other one is (ccc writes it to
      // the second, without the milliseconds).
      insert.run(
        at.toISOString(),
        l.child,
        l.kind,
        l.host ?? null,
        l.via ?? null,
        l.name ?? null,
        l.model ?? null,
        l.effort ?? null,
        l.cwd ?? null,
        l.worktree ?? null,
        l.branch ?? null,
        l.replaced ?? null,
        l.draft == null ? null : Number(l.draft),
        l.parent?.job ?? null,
        l.parent?.session ?? null,
        l.parent?.bridge ?? null,
      )
    }
  })
  load(await Bun.file(opts.path).text())
  return { lines, rows: count(), skipped, present: true }
}
