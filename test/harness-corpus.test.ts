import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { Listed, State as RosterState } from '../src/agents'
import { State as IndexState } from '../src/jobs'

// The harness fixture corpus (scripts/harness-corpus.ts): the daemon's
// listing, roster and job files as one Claude Code version wrote them,
// scrubbed. Every version here must parse with every schema lore has for
// the file, and must hold the invariants lore's pages and docs lean on. A
// version that moves a field fails HERE on the day it is snapshotted.
// Both lore and ccc read these shapes; the corpus is the shared contract.

const ROOT = join(import.meta.dir, 'fixtures', 'harness')
const versions = existsSync(ROOT) ? readdirSync(ROOT).filter((v) => existsSync(join(ROOT, v, 'agents.json'))) : []
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
function keys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keys(x, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.push(k), keys(x, out))
  return out
}

describe('harness corpus', () => {
  test('at least one Claude Code version is snapshotted', () => {
    expect(versions.length).toBeGreaterThan(0)
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
        }
        for (const k of keys(all)) expect(k).not.toMatch(/auth$|^bridgeOwner|^providerEnv$|^token$|secret|password/i)
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
