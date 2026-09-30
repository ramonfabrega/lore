import { describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Listed, State as RosterState } from '../src/agents'
import { openDb } from '../src/db'
import { State as IndexState } from '../src/jobs'
import { indexSpawns, listSpawns } from '../src/spawns'

// The harness fixture corpus (scripts/harness-corpus.ts): the daemon's
// listing, roster and job files as one Claude Code version wrote them,
// scrubbed. Every version here must parse with every schema lore has for
// the file, and must hold the invariants lore's pages and docs lean on. A
// version that moves a field fails HERE on the day it is snapshotted.
// Both lore and ccc read these shapes; the corpus is the shared contract.

const ROOT = join(import.meta.dir, 'fixtures', 'harness')
const versions = existsSync(ROOT) ? readdirSync(ROOT).filter((v) => existsSync(join(ROOT, v, 'agents.json'))) : []
// Subagent transcripts (skeletons, `--subagent`): a version dir may hold one
// without the daemon files, so they are scanned on their own.
const subagents = existsSync(ROOT)
  ? readdirSync(ROOT).flatMap((v) =>
      readdirSync(join(ROOT, v))
        .filter((f) => f.startsWith('subagent-') && f.endsWith('.jsonl'))
        .map((f) => ({ version: v, file: f, agentId: f.slice('subagent-'.length, -'.jsonl'.length) })),
    )
  : []
const read = (...p: string[]) => JSON.parse(readFileSync(join(ROOT, ...p), 'utf8')) as unknown

const Worker = z
  .object({
    pid: z.number(),
    // The session inbox socket is keyed on replPid, NOT pid (the launcher):
    // /tmp/cc-socks/<replPid>.sock — nine for nine on 2026-09-04 (ccc HARNESS.md).
    replPid: z.number(),
    sessionId: z.string(),
    cwd: z.string(),
    cliVersion: z.string(),
    ptySock: z.string(),
    rendezvousSock: z.string(),
    startedAt: z.union([z.string(), z.number()]),
  })
  .loose()
const Roster = z.object({ proto: z.unknown(), supervisorPid: z.number(), updatedAt: z.unknown(), workers: z.record(z.string(), Worker) }).loose()

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out)
  return out
}
function entries(v: unknown, out: [string, unknown][] = []): [string, unknown][] {
  if (Array.isArray(v)) for (const x of v) entries(x, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.push([k, x]), entries(x, out))
  return out
}
const PROSE = new Set(['intent', 'detail', 'needs', 'label', 'question', 'header', 'description'])
// The rule arrived with 2.1.285; versions compare numerically, part by part.
const proseScrubbed = (v: string) => {
  const [a, b] = [v, '2.1.285'].map((s) => s.split('.').map(Number))
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return true
}
function keys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keys(x, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.push(k), keys(x, out))
  return out
}

// What each version's subagent file says about its own requests, as the
// spawn observatory reads it (spawns.ts). `open` is the number of requests
// whose LAST record carries no stop_reason — no completion record, so the
// request's real output never reached the file and the spawn's total is a
// floor. 2.1.260 wrote one for every request; 2.1.280 started dropping it
// on tool_use-ended requests (2 of 6 here, the Bash and the handback) and
// still closed on a text turn; 2.1.285 drops it on EVERY tool_use-ended
// request but the first (20 of 21) and ends on the `SubagentHandback` tool
// call — the ending lore names `handback`; 2.1.299 drops all 13 of 13.
// 2.1.307 fixed it upstream ("subagent transcripts recording placeholder
// token usage and an empty stop reason for streamed responses"), so on
// 2.1.321 every request carries its stop_reason and its real usage: the
// handback's record now says `tool_use`, a finished spawn is a MEASUREMENT
// (open 0, no flag), and meta.json gained `finished: true` — absent while
// the spawn runs, which the second 2.1.321 file is: a copy taken mid-flight,
// ending on a complete tool_use request with no result after it. That one
// is the only shape lore still calls `in-flight`. `partial` is the
// `partialReason` the row must carry, null for none; `finished` is what the
// harness's own meta says, which lore does not read and must not contradict.
//
// A file lands here WITHOUT a row and fails: say how its version records
// completions, then add the row — and a version snapshotted without any
// subagent file fails too (2.1.299 and 2.1.321 were, and the stop_reason
// move went four days unseen with this suite green). Both the sweep-trial
// pricing (attrition, 2026-10-07) and `lore spawns` lean on this.
type Completion = { requests: number; open: number; last: string | null; partial: 'floor' | 'in-flight' | null; finished?: true }
const COMPLETIONS: Record<string, Completion> = {
  '2.1.260/a4f9cab5e2d5f56ad': { requests: 11, open: 0, last: 'end_turn', partial: null },
  '2.1.280/a857ec397ebacf76f': { requests: 6, open: 2, last: 'end_turn', partial: 'floor' },
  '2.1.285/aaf774965de61fa92': { requests: 21, open: 20, last: 'handback', partial: 'floor' },
  '2.1.299/a862351c631a10a00': { requests: 13, open: 13, last: 'handback', partial: 'floor' },
  '2.1.321/abae2d1f7ee57aa09': { requests: 9, open: 0, last: 'handback', partial: null, finished: true },
  '2.1.321/a6412fdd2263f79bb': { requests: 2, open: 0, last: 'tool_use', partial: 'in-flight' },
}

describe('harness corpus', () => {
  test('at least one Claude Code version is snapshotted', () => {
    expect(versions.length).toBeGreaterThan(0)
  })

  describe('subagent transcripts', () => {
    test('every snapshotted version holds one', () => {
      expect(subagents.length).toBeGreaterThan(0)
      for (const v of versions)
        expect(
          subagents.some((s) => s.version === v),
          `${v}: no subagent transcript — bun scripts/harness-corpus.ts --subagent <agent-*.jsonl of that version>`,
        ).toBe(true)
    })
    for (const { version, file, agentId } of subagents) {
      test(`claude ${version} ${agentId}: the skeleton held — ids and shapes, never words; home and work trees scrubbed`, () => {
        const lines = readFileSync(join(ROOT, version, file), 'utf8').trim().split('\n')
        expect(lines.length).toBeGreaterThan(0)
        for (const line of lines) {
          const r = JSON.parse(line) as unknown
          for (const k of keys(r)) expect(k).not.toMatch(/^(text|input|thinking|result|output|params|shape|tail|base)$/)
          // A tool's ack is kept as ONE boolean and nothing else of the result.
          const ack = z.object({ toolUseResult: z.unknown().optional() }).loose().parse(r).toolUseResult
          if (ack !== undefined) expect(z.strictObject({ success: z.boolean() }).safeParse(ack).success, 'toolUseResult carries more than its success flag').toBe(true)
          for (const s of strings(r)) {
            expect(s).not.toMatch(/\/Users\/(?!u\/)[^/]+\//)
            expect(s).not.toMatch(/-Users-(?!u-)[A-Za-z0-9]+-/)
            expect(s).not.toContain('/code/work/')
            expect(s.length).toBeLessThanOrEqual(200)
          }
          const rec = z.object({ type: z.string(), version: z.string().optional() }).loose().parse(r)
          if (rec.version) expect(rec.version).toBe(version)
        }
      })

      test(`claude ${version} ${agentId}: the spawn observatory reads it the way the table says`, async () => {
        const expected = COMPLETIONS[`${version}/${agentId}`]
        expect(expected, `${version}/${agentId}: no COMPLETIONS row — say how this version records subagent completions`).toBeDefined()
        if (!expected) return
        // Lay the skeleton out the way the harness does: <well>/<session>/subagents/agent-<id>.jsonl.
        const projectsDir = mkdtempSync(join(tmpdir(), 'lore-harness-sub-'))
        const sub = join(projectsDir, '-u-code-fun-x', 'sess', 'subagents')
        mkdirSync(sub, { recursive: true })
        copyFileSync(join(ROOT, version, file), join(sub, `agent-${agentId}.jsonl`))
        const meta = join(ROOT, version, `subagent-${agentId}.meta.json`)
        if (existsSync(meta)) copyFileSync(meta, join(sub, `agent-${agentId}.meta.json`))
        const db = openDb(':memory:')
        await indexSpawns(db, { projectsDir })
        const { spawns } = listSpawns(db, { limit: 10 })
        expect(spawns).toHaveLength(1)
        const row = spawns[0]!
        // The verified model is a full id off the first request, never the alias.
        expect(row.model).toMatch(/^claude-/)
        expect(row.requests).toBe(expected.requests)
        if (expected.partial) {
          expect(row).toMatchObject({ telemetryPartial: true, partialReason: expected.partial, lastStopReason: expected.last, openRequests: expected.open })
        } else {
          expect(row.telemetryPartial).toBeUndefined()
          expect(row.partialReason).toBeUndefined()
          expect(row.openRequests).toBeUndefined()
        }
        // The harness's own word (2.1.321): `finished: true` once the spawn
        // ended, the key absent before. lore reads the transcript, not this —
        // but the two must never disagree, and the day they do is the day to
        // look at which one moved.
        const finished = existsSync(meta) ? z.object({ finished: z.boolean().optional() }).loose().parse(read(version, `subagent-${agentId}.meta.json`)).finished : undefined
        expect(finished).toBe(expected.finished)
        if (finished) expect(row.partialReason).not.toBe('in-flight')
      })
    }
  })

  for (const v of versions) {
    describe(`claude ${v}`, () => {
      const listing = read(v, 'agents.json')
      const jobFiles = readdirSync(join(ROOT, v, 'jobs')).filter((f) => f.endsWith('.json') && !f.endsWith('.launch.json'))
      const launches = readdirSync(join(ROOT, v, 'jobs')).filter((f) => f.endsWith('.launch.json'))
      const jobs = jobFiles.map((f) => [f, read(v, 'jobs', f)] as const)

      test('the scrub held: no home path, no work tree, no auth or owner field anywhere', () => {
        const all = [listing, ...jobs.map(([, j]) => j), existsSync(join(ROOT, v, 'roster.json')) ? read(v, 'roster.json') : null]
        for (const s of strings(all)) {
          expect(s).not.toMatch(/\/Users\/(?!u\/)[^/]+\//)
          // The home dir SLUGGED inside a well dir name (`-Users-<name>-…`).
          expect(s).not.toMatch(/-Users-(?!u-)[A-Za-z0-9]+-/)
          expect(s).not.toContain('/code/work/')
          expect(s).not.toContain('-code-work-')
          // Prose is cut to a fragment wherever it hides — the roster keeps
          // the opener whole inside the launch argv. The longest honest
          // string is a transcript path in a worktree well.
          expect(s.length).toBeLessThanOrEqual(200)
        }
        for (const k of keys(all)) expect(k).not.toMatch(/auth$|^bridgeOwner|^providerEnv$|^token$|secret|password/i)
      })

      // An artifact's name says what the work was about, and the cwd rule
      // cannot vouch for it: a session in a personal well published a plan
      // for a work project, and the 2.1.280 snapshot carried its title
      // until this test existed.
      test('the scrub held: a frame keeps its shape and loses its name', () => {
        const frames = jobs.flatMap(([, j]) => RosterState.parse(j).children ?? []).filter((c) => c.kind === 'frame')
        for (const c of frames) {
          expect(c.id).toBe('frame.html')
          if ('title' in c) expect(c.title).toBe('frame')
        }
      })

      // The third free-text field to name a work project from inside a
      // personal well, after artifact titles and launch argv: the 2.1.285
      // snapshot was taken mid-ingest and carried the fan-out's labels.
      // Fixtures older than the rule keep their fragments — they were read
      // by hand before they shipped.
      test('the scrub held: prose a session wrote keeps its shape and loses its words', () => {
        if (!proseScrubbed(v)) return
        const all = [listing, ...jobs.map(([, j]) => j), existsSync(join(ROOT, v, 'roster.json')) ? read(v, 'roster.json') : null]
        for (const [k, x] of entries(all)) if (PROSE.has(k) && typeof x === 'string') expect(x === '' || x === k).toBe(true)
      })

      test('the listing parses with the roster schema; a background row carries a job id and a session id', () => {
        const rows = z.array(Listed).parse(listing)
        expect(rows.length).toBeGreaterThan(0)
        for (const r of rows) {
          expect(typeof r.cwd).toBe('string')
          expect(typeof r.startedAt).toBe('number')
          if (r.kind === 'background') {
            expect(r.id).toBeTruthy()
            expect(r.sessionId).toBeTruthy()
          }
        }
      })

      test('every job file parses with BOTH of lore\'s state.json schemas, and holds the invariants the pages lean on', () => {
        expect(jobs.length).toBeGreaterThan(0)
        for (const [f, raw] of jobs) {
          const a = RosterState.parse(raw)
          const b = IndexState.parse(raw)
          const j = raw as Record<string, unknown>
          // The three ids (CLAUDE.md): state.json's sessionId is the FIRST
          // root; the bridge id keys the job.
          expect(typeof a.sessionId, f).toBe('string')
          expect(b.sessionId).toBe(a.sessionId)
          if (j.bridgeSessionId != null) expect(String(j.bridgeSessionId)).toMatch(/^cse_/)
          // respawnFlags is an array of argv strings — REBUILT by the harness
          // after init, not the line as typed (log 09-07, the probes below):
          // trust it for the presence of a flag, never for a value.
          if (j.respawnFlags != null) expect(z.array(z.string()).safeParse(j.respawnFlags).success, f).toBe(true)
          // children[] are LINKS (pr, frame…), not spawns: no parentage here,
          // the fleet tree comes from the parent's spawn calls (log 09-07).
          for (const c of a.children ?? []) {
            expect(typeof c.kind).toBe('string')
            expect(typeof c.href).toBe('string')
            expect('sessionId' in c).toBe(false)
          }
          if (j.nameSource != null) expect(['user', 'auto']).toContain(String(j.nameSource))
          if (j.worktreePath != null) expect(typeof j.worktreeBranch, f).toBe('string')
          if (a.updatedAt != null) expect(Number.isNaN(new Date(a.updatedAt).getTime())).toBe(false)
        }
      })

      // A probe is a job launched to measure the recording (scripts/
      // harness-corpus.ts --probe): its sidecar holds the argv as typed. What
      // lore leans on: every flag typed is present in the recorded array, and
      // the model named is kept verbatim — but a VALUE can be rewritten. On
      // 2.1.260 a typed `--permission-mode auto` is recorded `default` when
      // the model named is Haiku 4.5 (alias or full id), and `auto` on opus,
      // sonnet and fable; the array is reordered on every model, and a
      // `--model` nobody typed is filled in. The transcript's own
      // `permission-mode` record says `auto` on every one of them. Both lore
      // (CLAUDE.md) and ccc (its `asks` mark) read this array; the day the
      // rewrite stops, this fails and the rule gets revisited — that is the
      // point, not a defect in the test.
      test('probes: every typed flag is present and the model verbatim; at least one typed value was rewritten', () => {
        if (launches.length === 0) return
        const Launch = z.object({ typed: z.array(z.string()), note: z.string().optional() })
        const Flags = z.object({ respawnFlags: z.array(z.string()) }).loose()
        const val = (a: string[], flag: string) => {
          const i = a.indexOf(flag)
          return i >= 0 ? a[i + 1] : undefined
        }
        const rewritten: string[] = []
        for (const f of launches) {
          const launch = Launch.parse(read(v, 'jobs', f))
          const fixture = f.replace(/\.launch\.json$/, '.json')
          const recorded = Flags.parse(read(v, 'jobs', fixture)).respawnFlags
          for (const flag of launch.typed.filter((x) => x.startsWith('--'))) expect(recorded, `${fixture}: ${flag}`).toContain(flag)
          const model = val(launch.typed, '--model')
          if (model != null) expect(val(recorded, '--model'), fixture).toBe(model)
          if (val(launch.typed, '--permission-mode') !== val(recorded, '--permission-mode')) rewritten.push(fixture)
        }
        expect(rewritten.length, 'no probe shows a rewritten value: the harness stopped resolving respawnFlags — revisit the presence-not-value rule').toBeGreaterThan(0)
      })

      test('the roster names each worker\'s replPid, session and sockets', () => {
        if (!existsSync(join(ROOT, v, 'roster.json'))) return
        const roster = Roster.parse(read(v, 'roster.json'))
        for (const [id, w] of Object.entries(roster.workers)) {
          expect(w.cliVersion, id).toBe(v)
          // The PTY socket is the daemon's, under its own short id and a
          // random name — it does NOT carry the job id (2.1.260).
          expect(w.ptySock).toMatch(/\.pty\.sock$/)
          expect(w.rendezvousSock).toMatch(/\.sock$/)
          expect(w.replPid).not.toBe(w.pid)
        }
      })
    })
  }
})
