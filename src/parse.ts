// Transcript records are an event log, not a chat log (see docs/notes/2026-07-17-jsonl-spelunk.md).
// Each raw line yields zero or more indexable entries, split into lanes so FTS
// doesn't drown conversational signal (~3-4% of lines) in tool traffic.

export type Lane = 'prompt' | 'text' | 'thinking' | 'tool' | 'event' | 'meta'

export type Entry = { lane: Lane; text: string }

export type Parsed = {
  type: string
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  timestamp?: string
  cwd?: string
  gitBranch?: string
  sessionKind?: string
  entries: Entry[]
}

// Tool inputs/results are indexed truncated: enough to find "that session where
// we ran X", not enough to bloat the index with full file dumps.
const TOOL_TEXT_CAP = 2_000

// Harness-injected user content (command wrappers, caveats) — searchable but not a human prompt.
const META_PROMPT = /^\s*<(local-command|command-name|command-message|system-remind|task-notification)/

export function parseLine(line: string): Parsed | null {
  if (!line.trim()) return null
  let r: any
  try {
    r = JSON.parse(line)
  } catch {
    return null
  }
  const p: Parsed = {
    type: r.type ?? 'unknown',
    uuid: r.uuid,
    parentUuid: r.parentUuid,
    sessionId: r.sessionId,
    timestamp: r.timestamp,
    cwd: r.cwd,
    gitBranch: r.gitBranch,
    sessionKind: r.sessionKind,
    entries: [],
  }

  switch (p.type) {
    case 'user': {
      const content = r.message?.content
      if (typeof content === 'string') {
        p.entries.push({ lane: META_PROMPT.test(content) ? 'meta' : 'prompt', text: content })
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && block.text) {
            p.entries.push({ lane: META_PROMPT.test(block.text) ? 'meta' : 'prompt', text: block.text })
          } else if (block?.type === 'tool_result') {
            const text = toolResultText(block.content)
            if (text) p.entries.push({ lane: 'tool', text: text.slice(0, TOOL_TEXT_CAP) })
          }
        }
      }
      break
    }
    case 'assistant': {
      const content = r.message?.content
      if (!Array.isArray(content)) break
      for (const block of content) {
        if (block?.type === 'text' && block.text) p.entries.push({ lane: 'text', text: block.text })
        else if (block?.type === 'thinking' && block.thinking)
          p.entries.push({ lane: 'thinking', text: block.thinking })
        else if (block?.type === 'tool_use')
          p.entries.push({
            lane: 'tool',
            text: `${block.name ?? '?'} ${safeStringify(block.input).slice(0, TOOL_TEXT_CAP)}`,
          })
      }
      break
    }
    case 'system': {
      const subtype = r.subtype ?? 'system'
      const body = typeof r.content === 'string' ? r.content : safeStringify(r.content ?? '')
      // away_summary is a harness-written digest — keep it whole, it's pre-chewed gold.
      const cap = subtype === 'away_summary' ? Number.POSITIVE_INFINITY : TOOL_TEXT_CAP
      p.entries.push({ lane: 'event', text: `${subtype}: ${body}`.slice(0, cap) })
      break
    }
    case 'pr-link': {
      p.entries.push({
        lane: 'event',
        text: `pr-link: ${r.prRepository ?? ''}#${r.prNumber ?? ''} ${r.prUrl ?? ''}`.trim(),
      })
      break
    }
    case 'custom-title':
    case 'ai-title': {
      const title = r.customTitle ?? r.aiTitle ?? r.title
      if (title) p.entries.push({ lane: 'event', text: `title: ${title}` })
      break
    }
    case 'summary': {
      if (r.summary) p.entries.push({ lane: 'event', text: `summary: ${r.summary}` })
      break
    }
    // Structure-only records: counted for stats, nothing worth full-text search.
    // (last-prompt duplicates the prompt lane; mode/worktree-state/etc are state streams.)
    default:
      break
  }
  return p
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((b: any) => (b?.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
  return ''
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}
