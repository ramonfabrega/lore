import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { dayStart } from '../src/fmt'
import { listJobs } from '../src/job'
import { readLimits } from '../src/limits'
import { listPolls } from '../src/polls'
import { listSessions } from '../src/sessions'
import { listSpawns } from '../src/spawns'
import { listToolUsage } from '../src/tools'
import { listWorkflowRuns } from '../src/workflows'

// `--since 2026-07-10` is the LOCAL day (CLAUDE.md, "An instant is UTC, a day
// is local"). Until 2026-11-14 seven verbs compared the typed string against
// UTC instants, so at UTC+14 a row an hour into the local 10th (10:00 UTC on
// the 9th) fell outside `--since 2026-07-10` while `tools` dated it the 10th
// and `usage --since` counted it. Every fixture row here sits at 01:00 local
// on the 10th, in whatever zone the suite runs, so the test bites in CI's
// UTC+14 pass (at UTC the two days coincide and it cannot).
const T = new Date(Date.parse(dayStart('2026-07-10')) + 3_600_000).toISOString()
const SINCE = '2026-07-10'

function seed() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO wells(id, dir, real_path) VALUES (1, '-u-code-a', '/u/code/a')").run()
  db.prepare("INSERT INTO sessions(well_id, session_id, size, mtime_ms, lines, first_ts, last_ts, last_activity_ts) VALUES (1, 's1', 1, 0, 1, ?, ?, ?)").run(T, T, T)
  db.prepare("INSERT INTO messages(id, session_id, ts, lane, type, tool_name, request_id) VALUES (1, 's1', ?, 'tool', 'assistant', 'Bash', 'r1')").run(T)
  db.prepare('INSERT INTO messages_fts(rowid, text) VALUES (1, ?)').run('Bash {"command":"true"}')
  db.prepare("INSERT INTO spawns(well_dir, session_id, agent_id, first_ts, last_ts, size, mtime_ms) VALUES ('-u-code-a', 's1', 'ag1', ?, ?, 0, 0)").run(T, T)
  db.prepare("INSERT INTO workflow_runs(run_id, well_dir, session_id, script, recorded_ts, size, mtime_ms) VALUES ('wf_1', '-u-code-a', 's1', '', ?, 0, 0)").run(T)
  db.prepare("INSERT INTO limits(ts, session_id, kind, pct, resets_at, source) VALUES (?, 's1', 'seven_day', 10, '2099-01-01T00:00:00.000Z', 'mod')").run(T)
  return db
}

describe('--since a date is local midnight on every verb', () => {
  test('sessions', () => {
    expect(listSessions(seed(), { limit: 100 })).toHaveLength(1)
    expect(listSessions(seed(), { since: SINCE, limit: 100 })).toHaveLength(1)
  })
  test('tools', () => {
    expect(listToolUsage(seed(), { limit: 100 })).toHaveLength(1)
    expect(listToolUsage(seed(), { since: SINCE, limit: 100 })).toHaveLength(1)
  })
  test('spawns', () => {
    expect(listSpawns(seed(), { limit: 50 }).spawns).toHaveLength(1)
    expect(listSpawns(seed(), { since: SINCE, limit: 50 }).spawns).toHaveLength(1)
  })
  test('workflows', () => {
    expect(listWorkflowRuns(seed(), { limit: 25 }).runs).toHaveLength(1)
    expect(listWorkflowRuns(seed(), { since: SINCE, limit: 25 }).runs).toHaveLength(1)
  })
  test('polls', () => {
    expect(listPolls(seed(), { limit: 10 }).count).toBe(1)
    expect(listPolls(seed(), { since: SINCE, limit: 10 }).count).toBe(1)
  })
  test('jobs', () => {
    expect(listJobs(seed(), { all: true, limit: 10 })).toHaveLength(1)
    expect(listJobs(seed(), { all: true, since: SINCE, limit: 10 })).toHaveLength(1)
  })
  test('limits', () => {
    expect(readLimits(seed(), { limit: 20 }).count).toBe(1)
    expect(readLimits(seed(), { since: SINCE, limit: 20 }).count).toBe(1)
  })
})
