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

  // Authorship comes off the record's fields now. The shapes below are copied
  // from real transcripts (v2.1.247 / v2.1.258): before v15 all three landed
  // in the prompt lane and read as the user's own words.
  test('an injected skill body → meta lane, however its prose opens', () => {
    // The artifact-design body, pulled in by a Skill call in session 497d1db8.
    // No prefix a regex could catch — it opens like a person talking.
    const p = parseLine(
      env({
        type: 'user',
        isMeta: true,
        turnCompanion: true,
        sourceToolUseID: 'toolu_01UADnDpcVpjAWfexch4AHgX',
        message: { content: 'Approach this as the design lead at a small studio known for their versatility…' },
      }),
    )!
    expect(p.entries[0]!.lane).toBe('meta')
  })

  test('a peer session\'s message → relay lane, attributed', () => {
    const p = parseLine(
      env({
        type: 'user',
        isMeta: true,
        promptSource: 'system',
        origin: { kind: 'peer', name: 'ccc', from: 'uds:/tmp/cc-socks/85001.sock', verifiedPeerPid: 85001 },
        message: { content: 'Another Claude session sent a message: <cross-session-message from-name="ccc">ccc v0 is closed…' },
      }),
    )!
    expect(p.entries[0]!.lane).toBe('relay')
    expect(p.entries[0]!.peer).toBe('ccc')
  })

  test('a typed prompt stays a prompt, and carries no peer', () => {
    const p = parseLine(
      env({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { content: 'ran both, should be good on ccc' } }),
    )!
    expect(p.entries).toEqual([{ lane: 'prompt', text: 'ran both, should be good on ccc' }])
  })

  test('the prose sniff still covers transcripts older than the fields', () => {
    // No isMeta, no origin — the only tell is the wrapper itself, and the
    // command name must survive, since `command:<name>` is how the ambient ROI
    // ledger counts slash commands.
    const p = parseLine(
      env({ type: 'user', message: { content: '<command-name>/lore-agents</command-name>\n<command-message>agents</command-message>' } }),
    )!
    expect(p.entries[0]!.lane).toBe('meta')
    expect(p.entries[0]!.toolName).toBe('command:lore-agents')
  })

  test('a command wrapper that DOES carry isMeta keeps its command name', () => {
    // isMeta is tested before the regex, so extraction has to live past both
    // gates or the ledger silently loses every slash command on new records.
    const p = parseLine(
      env({ type: 'user', isMeta: true, message: { content: '<command-name>/code-review</command-name>' } }),
    )!
    expect(p.entries[0]!.lane).toBe('meta')
    expect(p.entries[0]!.toolName).toBe('command:code-review')
  })

  test('tool_result user record → tool lane, capped', () => {
    const big = 'x'.repeat(5000)
    const p = parseLine(
      env({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: big }] }] } }),
    )!
    expect(p.entries[0]!.lane).toBe('tool')
    // head (1200) + separator + tail (800): the verdict at the END of a tool
    // result survives the cap (docs/EXPLORER.md annotations)
    expect(p.entries[0]!.text.length).toBe(1200 + '\n… … …\n'.length + 800)
    expect(p.entries[0]!.text).toContain('… … …')
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
