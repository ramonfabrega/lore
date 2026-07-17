import { describe, expect, test } from 'bun:test'
import { parseLine } from '../src/parse'

const env = (extra: object) =>
  JSON.stringify({
    uuid: 'u1',
    parentUuid: null,
    sessionId: 's1',
    timestamp: '2026-07-17T12:00:00.000Z',
    cwd: '/Users/x/code/fun/lore',
    gitBranch: 'master',
    ...extra,
  })

describe('parseLine laning', () => {
  test('human prompt (string content) → prompt lane', () => {
    const p = parseLine(env({ type: 'user', message: { content: 'fix the auth bug' } }))!
    expect(p.entries).toEqual([{ lane: 'prompt', text: 'fix the auth bug' }])
    expect(p.gitBranch).toBe('master')
  })

  test('harness-injected user content → meta lane', () => {
    const p = parseLine(env({ type: 'user', message: { content: '<local-command-caveat>Caveat: ...' } }))!
    expect(p.entries[0]!.lane).toBe('meta')
  })

  test('skill expansions and interruption markers → meta lane', () => {
    const skill = parseLine(
      env({ type: 'user', message: { content: 'Base directory for this skill: /u/.claude/skills/expo-ui\n\n# Expo UI' } }),
    )!
    expect(skill.entries[0]!.lane).toBe('meta')
    const interrupted = parseLine(env({ type: 'user', message: { content: '[Request interrupted by user]' } }))!
    expect(interrupted.entries[0]!.lane).toBe('meta')
  })

  test('tool_result user record → tool lane, capped', () => {
    const big = 'x'.repeat(5000)
    const p = parseLine(
      env({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: big }] }] } }),
    )!
    expect(p.entries[0]!.lane).toBe('tool')
    expect(p.entries[0]!.text.length).toBe(2000)
  })

  test('assistant text + thinking + tool_use → three lanes', () => {
    const p = parseLine(
      env({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm let me reason' },
            { type: 'text', text: 'here is the answer' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    )!
    expect(p.entries.map((e) => e.lane)).toEqual(['thinking', 'text', 'tool'])
    expect(p.entries[2]!.text).toStartWith('Bash ')
  })

  test('system away_summary → event lane, uncapped', () => {
    const body = 'summary '.repeat(1000)
    const p = parseLine(env({ type: 'system', subtype: 'away_summary', content: body }))!
    expect(p.entries[0]!.lane).toBe('event')
    expect(p.entries[0]!.text.length).toBeGreaterThan(2000)
  })

  test('pr-link → event lane with repo#number', () => {
    const p = parseLine(env({ type: 'pr-link', prRepository: 'x/y', prNumber: 42, prUrl: 'https://g/x/y/42' }))!
    expect(p.entries[0]!.text).toBe('pr-link: x/y#42 https://g/x/y/42')
  })

  test('state-stream records → no entries, still typed', () => {
    const p = parseLine(env({ type: 'mode', mode: 'default' }))!
    expect(p.type).toBe('mode')
    expect(p.entries).toEqual([])
  })

  test('garbage and blank lines → null', () => {
    expect(parseLine('')).toBeNull()
    expect(parseLine('not json{')).toBeNull()
  })
})
