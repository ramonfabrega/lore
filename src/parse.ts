import { z } from 'zod'

// Transcript records are an event log, not a chat log (see docs/notes/2026-07-17-jsonl-spelunk.md).
// Each raw line yields zero or more indexable entries, split into lanes so FTS
// doesn't drown conversational signal (~3-4% of lines) in tool traffic.

export type Lane = 'prompt' | 'text' | 'thinking' | 'tool' | 'event' | 'meta'

// toolName is the structured hook for the ambient ROI ledger (lore#7): raw
// tool name for tool_use blocks, with two refinements so usage counts answer
// "is this ambient item earning its tokens" — Skill invocations become
// `Skill:<skill>` and slash-command wrappers `command:<name>` (user-invoked
// skills flow through command wrappers, not the Skill tool; without this
// they'd all read as zero-use).
export type Entry = { lane: Lane; text: string; toolName?: string }

// One API request's usage envelope, from an assistant record (lore#8, the
// token profile). Assistant records are streaming snapshots — several lines
// per request sharing one `message.id` — so the indexer dedupes by id; this
// is just the per-line reading. thinking is a sub-count of output (billed as
// output), carried so the profile can show how much of the output was
// reasoning.
const RequestUsage = z.object({
  input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
  output_tokens_details: z.object({ thinking_tokens: z.number().nullish() }).nullish(),
})
const RequestRecord = z.object({
  effort: z.string().nullish(),
  message: z.object({
    id: z.string(),
    model: z.string().nullish(),
    stop_reason: z.string().nullish(),
    usage: RequestUsage,
  }),
})

export type Request = {
  id: string
  model: string | null
  effort: string | null
  stopReason: string | null
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  thinking: number
}

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
  // Present on assistant records that carry a message id and a usage block.
  request?: Request
}

// Tool inputs/results are indexed truncated: enough to find "that session where
// we ran X", not enough to bloat the index with full file dumps.
const TOOL_TEXT_CAP = 2_000

// Harness-injected user content (command wrappers, caveats, skill expansions,
// interruption markers) — searchable but not a human prompt.
const META_PROMPT =
  /^\s*(<(local-command|command-name|command-message|system-remind|task-notification)|Base directory for this skill:|\[Request interrupted by user)/

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
        p.entries.push(userTextEntry(content))
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && block.text) {
            p.entries.push(userTextEntry(block.text))
          } else if (block?.type === 'tool_result') {
            const text = toolResultText(block.content)
            if (text) p.entries.push({ lane: 'tool', text: text.slice(0, TOOL_TEXT_CAP) })
          }
        }
      }
      break
    }
    case 'assistant': {
      const req = RequestRecord.safeParse(r)
      // `<synthetic>` is the harness standing in for the model (interruption
      // markers, "no response requested" turns): zero tokens, no API request
      // behind it. Not a request — and not an unpriced model either.
      if (req.success && !req.data.message.model?.startsWith('<')) {
        const { message: m, effort } = req.data
        const u = m.usage
        p.request = {
          id: m.id,
          model: m.model ?? null,
          effort: effort ?? null,
          stopReason: m.stop_reason ?? null,
          input: u.input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          thinking: u.output_tokens_details?.thinking_tokens ?? 0,
        }
      }
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
            toolName:
              block.name === 'Skill' && typeof block.input?.skill === 'string'
                ? `Skill:${block.input.skill}`
                : (block.name ?? undefined),
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

function userTextEntry(text: string): Entry {
  if (!META_PROMPT.test(text)) return { lane: 'prompt', text }
  const command = /<command-name>\/?([\w:-]+)<\/command-name>/.exec(text)?.[1]
  return { lane: 'meta', text, ...(command ? { toolName: `command:${command}` } : {}) }
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
