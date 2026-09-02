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

// A message that arrives while the session is mid-turn is never a user
// record: the harness queues it and delivers it as an `attachment` of type
// `queued_command` hung off the tool result it was read after. Shapes
// verbatim from ccc's 2026-09-02 session, where 14 of lore's 22 messages
// and 10 of the user's 17 arrived this way — and none of it was indexed.
describe('parseLine: messages read mid-turn (attachment / queued_command)', () => {
  const queued = (a: object) =>
    env({
      type: 'attachment',
      parentUuid: '8d17b080-edbb-4fe2-904d-1cf0aa467703',
      isSidechain: false,
      attachment: { type: 'queued_command', source_uuid: '83591e5a', commandMode: 'prompt', timestamp: '2026-09-02T07:11:43.722Z', ...a },
    })

  test('the user typing while the agent works → prompt lane, on an attachment row', () => {
    const p = parseLine(queued({ prompt: 'i think we want to give ghostty/libghostty a solid shot..', origin: { kind: 'human' } }))!
    expect(p.type).toBe('attachment')
    expect(p.entries).toEqual([{ lane: 'prompt', text: 'i think we want to give ghostty/libghostty a solid shot..' }])
    // No promptId of its own — the indexer carries the running turn's forward.
    expect(p.promptId).toBeUndefined()
  })

  test('a peer message read mid-turn → relay lane, attributed, with its envelope intact', () => {
    const text = '<cross-session-message from="uds:/tmp/cc-socks/61989.sock" from-name="lore" from-mode="prompting">\nLedger banked. Three corrections back.'
    const p = parseLine(
      queued({
        prompt: text,
        isMeta: true,
        origin: { kind: 'peer', from: 'uds:/tmp/cc-socks/61989.sock', verifiedPeerPid: 61989, name: 'lore', fromMode: 'prompting', body: 'Ledger banked. Three corrections back.' },
      }),
    )!
    expect(p.entries).toEqual([{ lane: 'relay', text, peer: 'lore' }])
  })

  test('a task notification read mid-turn → meta lane', () => {
    const p = parseLine(queued({ commandMode: 'task-notification', prompt: '<task-notification>\n<task-id>a101bb5563f1a0309</task-id>\n<status>completed</status>\n</task-notification>' }))!
    expect(p.entries[0]!.lane).toBe('meta')
  })

  test('every other attachment kind indexes nothing', () => {
    for (const type of ['total_tokens_reminder', 'task_reminder', 'batching_reminder_sent', 'peer_mention', 'edited_text_file']) {
      const p = parseLine(env({ type: 'attachment', attachment: { type, text: 'x', prompt: 'y' } }))!
      expect(p.entries).toEqual([])
    }
  })

  test('a bridge-session record names the claude.ai session behind the job', () => {
    const p = parseLine(env({ type: 'bridge-session', bridgeSessionId: 'cse_01RGFNuvyhAq1Mzs6ZcVX7r2', lastSequenceNum: 0 }))!
    expect(p.bridgeSessionId).toBe('cse_01RGFNuvyhAq1Mzs6ZcVX7r2')
    expect(p.entries).toEqual([])
  })
})
