import { describe, expect, test } from 'bun:test'
import { beatsOf } from '../src/conversation'
import type { Instruction, Transaction } from '../src/trace'

// The projection is pure over a transaction, so the fixture is one: a turn
// the user opened, in which the assistant spoke, worked, read the user's
// mid-turn words and a peer's, answered the peer with SendMessage, and
// replied — the shape of the steer session the view was designed against.

const ix = (i: number, tool: string, extra: Partial<Instruction> = {}): Instruction => ({
  tool,
  input: tool === 'SendMessage' ? '{"to":"uds:/tmp/cc-socks/1.sock","summary":"the gate is green","message":"Gate green at 7c0c34b; merging."}' : `{"command":"step ${i}"}`,
  ts: new Date(Date.UTC(2026, 9, 20, 17, 0, i)).toISOString(),
  ms: 1000,
  error: false,
  result: 'ok',
  requestId: `r${i}`,
  ...extra,
})

const tx: Transaction = {
  promptId: 'p1',
  kind: 'prompt',
  ts: '2026-10-20T17:00:00.000Z',
  tag: null,
  prompt: 'measure the tranche',
  message: null,
  sent: [],
  received: [
    { at: 3, ts: '2026-10-20T17:00:02.500Z', kind: 'prompt', tag: null, text: 'then we talk' },
    { at: 3, ts: '2026-10-20T17:00:02.600Z', kind: 'meta', tag: 'task', text: 'Background command finished' },
    { at: 5, ts: '2026-10-20T17:00:04.500Z', kind: 'relay', tag: 'lean', text: 'Item 3354 is built' },
  ],
  steps: 8,
  instructions: [ix(0, 'Bash'), ix(1, 'Bash'), ix(2, 'Read'), ix(3, 'Bash', { error: true }), ix(4, 'Bash'), ix(5, 'Bash'), ix(6, 'SendMessage', { to: 'uds:/tmp/cc-socks/1.sock', toName: 'ccc', delivered: true }), ix(7, 'Bash')],
  notes: [
    { at: 0, ts: '2026-10-20T16:59:59.000Z', text: 'Reading the handoff first.' },
    { at: 3, ts: '2026-10-20T17:00:02.700Z', text: 'Noted. Finishing the pass, then we talk.', body: 'Noted. Finishing the pass, then we talk.\n\nThe gate runs first.' },
  ],
  thoughts: [],
  annotations: { files: [], commands: 7, tests: { ran: 0, passed: 0, failed: 0 }, commits: [], retries: 0 },
  errors: 1,
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  thinking: 0,
  listUsd: 1.6,
  model: 'claude-fable-5-1',
  reply: 'Committed and pushed.',
  ms: 9000,
  requests: Array.from({ length: 8 }, (_, i) => ({
    requestId: `r${i}`, ts: null, model: 'claude-fable-5-1', stopReason: 'tool_use', input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 10, thinking: 0, listUsd: 0.2,
  })),
}

describe('beatsOf', () => {
  const beats = beatsOf(tx)
  test('reads in cursor order: said, work, you, said, work, peer, work, sent, work', () => {
    expect(beats.map((b) => b.kind)).toEqual(['said', 'work', 'you', 'said', 'work', 'peer', 'work', 'sent', 'work'])
  })
  test('a message read mid-turn precedes the instruction at its cursor, and a note at the same cursor follows it', () => {
    expect(beats[2]).toMatchObject({ kind: 'you', text: 'then we talk' })
    expect(beats[3]).toMatchObject({ kind: 'said', text: 'Noted. Finishing the pass, then we talk.\n\nThe gate runs first.' })
    expect(beats[4]).toMatchObject({ kind: 'work', from: 3, to: 5 })
  })
  test('a heading-only note is speech too, with its text', () => {
    expect(beats[0]).toMatchObject({ kind: 'said', text: 'Reading the handoff first.' })
  })
  test('a work beat prices its own steps, counts its errors and the notifications read inside it', () => {
    expect(beats[1]).toMatchObject({ kind: 'work', from: 0, to: 3, steps: 3, listUsd: 0.6, errors: 0, tools: [{ tool: 'Bash', n: 2 }, { tool: 'Read', n: 1 }] })
    expect(beats[4]).toMatchObject({ kind: 'work', errors: 1, notifications: 1 })
  })
  test('a SendMessage is its own beat, named from the address book, and consumed from the work around it', () => {
    expect(beats[7]).toMatchObject({ kind: 'sent', name: 'ccc', summary: 'the gate is green', message: 'Gate green at 7c0c34b; merging.', delivered: true })
    expect(beats[8]).toMatchObject({ kind: 'work', from: 7, to: 8 })
  })
  test('a harness notification is never a beat', () => {
    expect(beats.some((b) => b.kind !== 'work' && b.kind !== 'said' && b.kind !== 'sent' && 'tag' in b && b.tag === 'task')).toBe(false)
  })
})
