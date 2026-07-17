import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { parseLine } from '../src/parse'
import { listToolUsage } from '../src/tools'

describe('toolName extraction', () => {
  test('tool_use blocks carry the tool name; Skill calls carry the skill', () => {
    const p = parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_use', name: 'mcp__argent__describe', input: {} },
            { type: 'tool_use', name: 'Skill', input: { skill: 'lore-search' } },
            { type: 'text', text: 'done' },
          ],
        },
      }),
    )!
    expect(p.entries.map((e) => e.toolName)).toEqual(['Bash', 'mcp__argent__describe', 'Skill:lore-search', undefined])
  })

  test('slash-command wrappers in the meta lane become command:<name>', () => {
    const p = parseLine(
      JSON.stringify({
        type: 'user',
        message: { content: '<command-name>/reload-plugins</command-name>\n<command-message>x</command-message>' },
      }),
    )!
    expect(p.entries[0]!.lane).toBe('meta')
    expect(p.entries[0]!.toolName).toBe('command:reload-plugins')
    const plain = parseLine(JSON.stringify({ type: 'user', message: { content: 'just a prompt' } }))!
    expect(plain.entries[0]!.toolName).toBeUndefined()
  })
})

function seedDb() {
  const db = openDb(':memory:')
  db.exec(`
    INSERT INTO wells(id, dir, real_path) VALUES (1, '-u-code-a', '/u/code/a'), (2, '-u-code-b', '/u/code/b');
    INSERT INTO sessions(well_id, session_id, size, mtime_ms) VALUES (1, 's1', 0, 0), (2, 's2', 0, 0);
    INSERT INTO messages(session_id, ts, lane, type, tool_name) VALUES
      ('s1', '2026-07-01T10:00:00Z', 'tool', 'assistant', 'Bash'),
      ('s1', '2026-07-02T10:00:00Z', 'tool', 'assistant', 'Bash'),
      ('s2', '2026-07-10T10:00:00Z', 'tool', 'assistant', 'Bash'),
      ('s2', '2026-07-10T11:00:00Z', 'tool', 'assistant', 'mcp__argent__describe'),
      ('s1', '2026-07-03T10:00:00Z', 'meta', 'user', 'command:lore-wiki'),
      ('s1', '2026-07-03T11:00:00Z', 'tool', 'assistant', NULL);
  `)
  return db
}

describe('listToolUsage', () => {
  test('groups by name with session/well spread and date range', () => {
    const rows = listToolUsage(seedDb(), { limit: 100 })
    expect(rows.map((r) => r.tool)).toEqual(['Bash', 'command:lore-wiki', 'mcp__argent__describe'])
    const bash = rows[0]!
    expect(bash.n).toBe(3)
    expect(bash.sessions).toBe(2)
    expect(bash.wells).toBe(2)
    expect(bash.first).toBe('2026-07-01')
    expect(bash.last).toBe('2026-07-10')
  })

  test('prefix, since, and well filters', () => {
    const db = seedDb()
    expect(listToolUsage(db, { prefix: 'mcp__', limit: 100 }).map((r) => r.tool)).toEqual(['mcp__argent__describe'])
    expect(listToolUsage(db, { since: '2026-07-05', limit: 100 }).map((r) => r.tool)).toEqual([
      'Bash',
      'mcp__argent__describe',
    ])
    expect(listToolUsage(db, { well: '-u-code-a', exact: true, limit: 100 }).map((r) => r.tool)).toEqual([
      'Bash',
      'command:lore-wiki',
    ])
  })
})
