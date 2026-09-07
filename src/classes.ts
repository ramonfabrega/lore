// Tool classes: what a request was SPENT ON, read off the tool call it
// made. Born from the 2026-09-06 lane split on attrition (log 09-07): four
// capture-lane sessions cost 159.50 USD at list, 2% of it the captures the
// lanes existed to run, 41% a once-a-turn `cat` of a background task's
// output file — 381 requests at 240k cache-read tokens each, median 4.6 s
// apart, buying nothing the harness was not going to deliver unprompted
// (`run_in_background` re-invokes the session when the task exits). A lane
// request costs the same whatever it does, so spend is context × request
// count and what a turn is spent on is the whole lever.
//
// Classes are generic, never project-specific: `poll` is a read of a task
// output file (a Bash read of a path under the harness's `tasks/` dir, or
// a non-blocking TaskOutput); `wait` is a BLOCKING wait — Monitor, a
// blocking TaskOutput, a bare `sleep`, or an until/while loop around one
// inside a single call, which is the right shape and passes by
// construction; `idle` is a turn held open on NOTHING; `read` / `write` /
// `shell` / `spawn` / `relay` by tool; `other` the rest; `text` a request
// that called nothing.
//
// `idle` is the second shape, and it cost more than the first (lane-286,
// 2026-09-07): a worker backgrounded its capture correctly — two
// `run_in_background` waits, exactly as attrition's canon asks — and then,
// with a task notification already guaranteed, ran `true` 107 times over
// four minutes to stay alive, one every 2.3 s, each returning no output
// and re-billing 168k of context. 18.04M cache-read tokens, 28.01 USD at
// list, 57% of everything that session ever spent, on a session twelve
// minutes old. The polling lint scored it a 0.10 USD single read — its
// best row of the day — because it measures reads of a task file and this
// shape reads nothing. A poll at least buys stale information; an idle
// turn buys none at the same price, so it is the cheapest-looking and most
// expensive thing a lane can do. Before this class it counted as `shell`,
// indistinguishable from work.
//
// lane-286 was the one a human caught. The lint's first run over the index
// found a worse one nobody had: loop-258, thirteen hours earlier the same
// day, 282 idle turns with an unbroken stretch of 187 and 39.99 USD — and
// its spelling was `echo .`, not `true`, which is why the class matches a
// literal echo and why a hand-written scan for `true` missed it entirely.
// The move is what is being detected, not the two spellings: any command
// whose purpose is to yield the turn. Across the fleet, 447 turns and
// 60.67 USD, 93% of it in one repo's capture and loop workers — the
// sessions that background a long external wait are exactly the ones that
// reach for a way to stay alive while it runs.
//
// A request with several calls takes the highest class by CLASS_RANK.
// `poll` ranks first so its share is a measurement, not a floor: the first
// pass ranked read over poll, and attrition pointed out that every mixed
// turn then counted against the conclusion.

export type ToolClass = 'poll' | 'write' | 'spawn' | 'relay' | 'shell' | 'read' | 'wait' | 'other' | 'idle' | 'text'

// `idle` ranks LAST above `text` for the same reason `poll` ranks first: a
// mixed turn must not count as idle. A request that ran `true` AND
// something real did something, and only a turn whose every call was
// nothing is one.
export const CLASS_RANK: Record<ToolClass, number> = { poll: 9, write: 8, spawn: 7, relay: 6, shell: 5, read: 4, wait: 3, other: 2, idle: 1, text: 0 }

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LSP', 'WebFetch', 'WebSearch', 'ReadMcpResourceTool', 'ListMcpResourcesTool'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SPAWN_TOOLS = new Set(['Agent', 'Task', 'Workflow'])
// The harness's task output directory: `<tmp>/claude-<uid>/<well>/<session>/tasks/<id>.output`.
const TASK_PATH = /\/tasks\/([A-Za-z0-9_-]+)/
const TASK_ID = /"task_id":"([^"]+)"/
const BLOCKING = /"block":true/
// A loop around a sleep inside ONE call is a blocking wait, whatever it
// reads afterwards; a bare sleep is one too. A read of a task file with no
// loop is the per-turn poll.
const LOOP_WAIT = /\b(?:until|while)\b[^\n]*?\bdo\b[\s\S]*?\bsleep\b/
const BARE_SLEEP = /^\s*sleep\s+\d/
// A command that runs nothing: `true`, `:`, an empty string, or an `echo`
// of a literal with nowhere to send it. Deliberately NARROW — a false
// positive accuses a lane of waste — so anything carrying a pipe, a
// redirect, a substitution or a second command falls through to `shell`,
// and a shape this misses reads as work rather than as an accusation.
const IDLE_NOOP = /^\s*(?::|true)?\s*;?\s*$/
const IDLE_ECHO = /^\s*echo(?:\s+-n)?(?:\s+(?:[\w.,:!?-]+|"[^"'$`\\|;&<>()]*"|'[^'|;&<>()]*'))?\s*;?\s*$/

// The command a Bash call ran, unescaped enough for the patterns here. The
// input is the tool_use's JSON with the tool name taken off (trace.ts).
export function bashCommand(inputFull: string): string {
  const m = /"command":"((?:[^"\\]|\\.)*)"/.exec(inputFull)
  const raw = m?.[1] ?? inputFull
  return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

// The task a call read, when it is a poll or a wait on one: the `tasks/<id>`
// path segment for Bash, `task_id` for TaskOutput. Null for everything else.
export function taskRef(tool: string, inputFull: string): string | null {
  if (tool === 'TaskOutput') return TASK_ID.exec(inputFull)?.[1] ?? null
  if (tool !== 'Bash') return null
  return TASK_PATH.exec(bashCommand(inputFull))?.[1] ?? null
}

export function classify(tool: string, inputFull: string): ToolClass {
  if (tool === 'Bash') {
    const cmd = bashCommand(inputFull)
    // Before every other test: a no-op has no task path, no loop and no
    // sleep, so nothing below would claim it — it would land on `shell`.
    if (IDLE_NOOP.test(cmd) || IDLE_ECHO.test(cmd)) return 'idle'
    if (LOOP_WAIT.test(cmd)) return 'wait'
    // A sleep THEN a read of the task file is the per-turn poll with a pause
    // in it — the sleep-and-grep loop spread across turns — not a wait.
    if (TASK_PATH.test(cmd)) return 'poll'
    if (BARE_SLEEP.test(cmd)) return 'wait'
    return 'shell'
  }
  if (tool === 'TaskOutput') return BLOCKING.test(inputFull) ? 'wait' : 'poll'
  if (tool === 'Monitor') return 'wait'
  if (READ_TOOLS.has(tool)) return 'read'
  if (WRITE_TOOLS.has(tool)) return 'write'
  if (SPAWN_TOOLS.has(tool)) return 'spawn'
  if (tool === 'SendMessage') return 'relay'
  return 'other'
}

// The class of a request that made these calls: the highest-ranked one.
export function requestClass(classes: ToolClass[]): ToolClass {
  let best: ToolClass = 'text'
  for (const c of classes) if (CLASS_RANK[c] > CLASS_RANK[best]) best = c
  return best
}

export type ClassRow = {
  class: ToolClass
  requests: number
  output: number
  // Null when any request in the class had no rate (usage.ts `unpriced`).
  listUsd: number | null
  // Share of the session's priced spend, 0–1; null when unpriced.
  share: number | null
}

// The rollup: per class, how many requests, their output, their list price
// and their share of the whole. Sorted by spend, then requests. A request
// with no recorded class is `text`.
export function rollup(
  steps: { requestId: string; output: number; listUsd: number | null }[],
  classOf: Map<string, ToolClass>,
): ClassRow[] {
  const acc = new Map<ToolClass, { requests: number; output: number; listUsd: number | null }>()
  for (const s of steps) {
    const c = classOf.get(s.requestId) ?? 'text'
    const a = acc.get(c) ?? { requests: 0, output: 0, listUsd: 0 }
    a.requests++
    a.output += s.output
    a.listUsd = a.listUsd == null || s.listUsd == null ? null : a.listUsd + s.listUsd
    acc.set(c, a)
  }
  let total: number | null = 0
  for (const a of acc.values()) total = total == null || a.listUsd == null ? null : total + a.listUsd
  const rows: ClassRow[] = [...acc.entries()].map(([cls, a]) => ({
    class: cls,
    requests: a.requests,
    output: a.output,
    listUsd: a.listUsd == null ? null : Math.round(a.listUsd * 100) / 100,
    share: total == null || a.listUsd == null || total === 0 ? null : Math.round((a.listUsd / total) * 1000) / 1000,
  }))
  return rows.sort((x, y) => (y.listUsd ?? -1) - (x.listUsd ?? -1) || y.requests - x.requests)
}

// The polling shape of one session, over its instruction sequence in
// order — every instruction, with `ref` set only on the poll-class ones.
// Two shapes, because they answer two questions (attrition, 09-07):
// `runs` / `longest` / `inRuns` count CONSECUTIVE reads of the same task
// file with nothing between — the shape a live guard refuses on the third,
// with a clean margin (every honest check in the measured session was a
// run of one or two). `rereads` is every read past the first of each file,
// however interleaved — the window-free count a session that alternates
// between two long jobs would otherwise hide from the consecutive shape.
// `medianGapS` is the seconds between adjacent same-file reads: 4.6 in the
// measured session, the API round trip and nothing else.
export type PollShape = {
  reads: number
  files: number
  rereads: number
  runs: number
  longest: number
  inRuns: number
  medianGapS: number | null
}

export const RUN_MIN = 3

export function pollShape(seq: { ref: string | null; ts: string | null }[]): PollShape {
  const files = new Set<string>()
  let reads = 0
  let runs = 0
  let longest = 0
  let inRuns = 0
  const gaps: number[] = []
  let cur: string | null = null
  let n = 0
  let prevTs: string | null = null
  const close = () => {
    if (cur != null && n >= RUN_MIN) {
      runs++
      inRuns += n
    }
    if (cur != null && n > longest) longest = n
  }
  for (const x of seq) {
    if (x.ref != null) {
      reads++
      files.add(x.ref)
      if (x.ref === cur) {
        n++
        if (prevTs && x.ts) gaps.push((Date.parse(x.ts) - Date.parse(prevTs)) / 1000)
      } else {
        close()
        cur = x.ref
        n = 1
      }
      prevTs = x.ts
    } else {
      close()
      cur = null
      n = 0
      prevTs = null
    }
  }
  close()
  gaps.sort((a, b) => a - b)
  const median = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]! * 10) / 10 : null
  return { reads, files: files.size, rereads: reads - files.size, runs, longest, inRuns, medianGapS: median }
}

// The idle shape of one session, over the same instruction sequence. No
// RUN_MIN here and no `inRuns`: the polling shapes need a threshold
// because an honest check is a run of one or two, but there is no honest
// idle turn — the first one already bought nothing — so every one counts
// and `longestIdle` is what separates a loop (107, lane-286) from
// sloppiness (5, scattered). `medianIdleGapS` is the API round trip and
// nothing else: 2.3 s in the measured loop, against the 4.6 s of a poll
// that at least waited for a file to change.
//
// The sequence is instructions, not transcript records, so a stretch is
// contiguous by construction — the assistant's "Waiting." text between two
// `true`s is not an instruction and does not break the run. Counting off
// raw records instead reports a longest of 2 for a loop of 107.
export type IdleShape = {
  idles: number
  longestIdle: number
  medianIdleGapS: number | null
}

export function idleShape(seq: { idle: boolean; ts: string | null }[]): IdleShape {
  let idles = 0
  let longestIdle = 0
  let n = 0
  let prevTs: string | null = null
  const gaps: number[] = []
  for (const x of seq) {
    if (x.idle) {
      idles++
      n++
      if (n > longestIdle) longestIdle = n
      if (prevTs && x.ts) gaps.push((Date.parse(x.ts) - Date.parse(prevTs)) / 1000)
      prevTs = x.ts
    } else {
      n = 0
      prevTs = null
    }
  }
  gaps.sort((a, b) => a - b)
  return { idles, longestIdle, medianIdleGapS: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]! * 10) / 10 : null }
}
