import { describe, expect, test } from 'bun:test'
import { ixTable, sessionBody } from '../src/block'
import type { Trace, Transaction } from '../src/trace'

// Review 2026-11-14: a thought placed after a turn's last instruction (cursor
// === instructions.length — the reasoning before the reply) never rendered:
// `ixTable` gave the last phase a tail case for messages read there but not
// for thoughts, and a phase with no instructions returned before any table.
const at = (s: number) => `2026-09-07T15:00:0${s}.000Z`
function tx(over: Partial<Transaction>): Transaction {
  return {
    promptId: 'p1', kind: 'prompt', ts: at(0), tag: null, prompt: 'go', message: null, sent: [], received: [],
    steps: 1, instructions: [], notes: [], thoughts: [],
    annotations: { files: [], commands: 0, tests: { ran: 0, passed: 0, failed: 0 }, commits: [], retries: 0 },
    errors: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, listUsd: null, model: null,
    reply: 'All good.', ms: 3000,
    ...over,
  }
}
const read = { tool: 'Read', input: '{"file_path":"/u/a.ts"}', ts: at(1), ms: 5, error: false, result: 'x', requestId: 'm1' }

describe('block view thoughts', () => {
  test('the last phase renders the thought after the last instruction', async () => {
    const x = tx({
      instructions: [read],
      thoughts: [
        { at: 0, ts: at(1), text: 'FIRST-THOUGHT' },
        { at: 1, ts: at(3), text: 'FINAL-THOUGHT' },
      ],
    })
    const last = String(await ixTable(x, 0, 1, new Map(), true))
    expect(last).toContain('FIRST-THOUGHT')
    expect(last).toContain('FINAL-THOUGHT')
    // A phase that is not the last does not take the next phase's thought.
    expect(String(await ixTable(x, 0, 1, new Map(), false))).not.toContain('FINAL-THOUGHT')
  })

  test('a turn that called nothing still shows its thinking', async () => {
    const x = tx({ thoughts: [{ at: 0, ts: at(1), text: 'ONLY-THOUGHT' }] })
    const trace: Trace = {
      session: { well: '-u-app', sessionId: 's1', name: null, jobSessionId: null, jobKey: null, first: at(0), last: at(3), lines: 3 },
      totals: {
        transactions: 1, turns: { prompt: 1, command: 0, relay: 0, meta: 0 }, sent: 0, lost: 0, steps: 1, requests: 1, instructions: 0, errors: 0,
        input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, listUsd: null, spawns: 0, spawnOutput: 0, lanes: 0, laneUsd: 0, ms: 3000,
      },
      models: [], spawns: [], lanes: [], classes: [],
      polls: { reads: 0, files: 0, rereads: 0, runs: 0, longest: 0, inRuns: 0, medianGapS: null },
      idle: { idles: 0, longestIdle: 0, medianIdleGapS: null },
      unplaced: [],
      transactions: [x],
    }
    expect(String(await sessionBody(trace))).toContain('ONLY-THOUGHT')
  })
})
