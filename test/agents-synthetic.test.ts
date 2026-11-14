import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tailOf } from '../src/agents'

// Review 2026-11-14: the roster's tail read took the harness's `<synthetic>`
// stand-in (an API error, a usage-limit refusal) for the model that served,
// and its zero usage for the context the next turn carries.
const synthetic = (ts: string, text: string) =>
  JSON.stringify({
    type: 'assistant', timestamp: ts, isApiErrorMessage: true,
    message: { id: `syn-${ts}`, model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'text', text }] },
  })
const real = (ts: string, id: string, model: string, ctx: number) =>
  JSON.stringify({
    type: 'assistant', timestamp: ts,
    message: { id, model, role: 'assistant', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: ctx - 10 }, content: [{ type: 'text', text: 'ok' }] },
  })

describe('tailOf', () => {
  test('walks back past <synthetic> to the last request that was served', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'lore-tail-')), 's.jsonl')
    writeFileSync(p, `${real('2026-11-14T01:00:00Z', 'msg_1', 'claude-opus-5-5', 412_000)}\n${synthetic('2026-11-14T01:00:05Z', 'API Error: 529 overloaded')}\n`)
    expect(await tailOf(p)).toEqual({ model: 'claude-opus-5-5', ctx: 412_000 })
  })

  test('a transcript of nothing but <synthetic> has no model and no context', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'lore-tail-')), 's.jsonl')
    writeFileSync(p, `${synthetic('2026-11-14T01:00:05Z', "You've hit your limit")}\n`)
    expect(await tailOf(p)).toEqual({ model: null, ctx: null })
  })
})
