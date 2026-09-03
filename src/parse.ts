import { z } from 'zod'

// Transcript records are an event log, not a chat log (see docs/notes/2026-07-17-jsonl-spelunk.md).
// Each raw line yields zero or more indexable entries, split into lanes so FTS
// doesn't drown conversational signal (~3-4% of lines) in tool traffic.

export type Lane = 'prompt' | 'text' | 'thinking' | 'tool' | 'event' | 'meta' | 'relay'

// toolName is the structured hook for the ambient ROI ledger (lore#7): raw
// tool name for tool_use blocks, with two refinements so usage counts answer
// "is this ambient item earning its tokens" — Skill invocations become
// `Skill:<skill>` and slash-command wrappers `command:<name>` (user-invoked
// skills flow through command wrappers, not the Skill tool; without this
// they'd all read as zero-use).
// toolUseId pairs a tool_use block with its tool_result (the instruction and
// its log, in explorer terms — docs/EXPLORER.md); isError is the result's flag.
// peer names the OTHER SESSION that sent a relay-lane entry (origin.name —
// "ccc", "attrition", "site"), so peer traffic is attributable without
// re-reading the prose it arrived wrapped in.
// msgId is the harness's id for a cross-session message — `origin.msg_id` on
// the receiver's record, the ack's `msg_id` on the sender's SendMessage
// result — the same id on both sides, so the two halves pair exactly.
export type Entry = { lane: Lane; text: string; toolName?: string; toolUseId?: string; isError?: boolean; peer?: string; msgId?: string }

// One API request's usage envelope, from an assistant record (lore#8, the
// token profile). Assistant records are streaming snapshots — several lines
// per request sharing one `message.id` — so the indexer dedupes by id; this
// is just the per-line reading. thinking is a sub-count of output (billed as
// output), carried so the profile can show how much of the output was
// reasoning.
//
// `cache_creation` splits `cache_creation_input_tokens` by TTL, and the two
// TTLs are priced differently: a 5-minute write is 1.25× base input, a
// 1-hour write is 2×. The fleet writes 1-hour entries exclusively, so
// pricing every write at the 5-minute rate ran the whole ledger ~6% low.
// The field is a later addition — records that predate it carry the total
// and no split, and usage.ts prices that remainder at the 5-minute rate.
const RequestUsage = z.object({
  input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation: z
    .object({
      ephemeral_5m_input_tokens: z.number().nullish(),
      ephemeral_1h_input_tokens: z.number().nullish(),
    })
    .nullish(),
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
  // The TTL split of cacheWrite. Zero on records older than the field —
  // never assume cacheWrite5m + cacheWrite1h === cacheWrite.
  cacheWrite5m: number
  cacheWrite1h: number
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
  // The transaction key: every `user` record (prompts and tool results) carries
  // the id of the prompt it belongs to; assistant records do not and inherit
  // the last one seen in file order (the indexer carries it forward).
  promptId?: string
  // The background job's own id (record-level `session_id`, distinct from
  // `sessionId`): one job spans every /clear'd transcript it produced.
  // Not stable across the job's life: a daemon RESPAWN mints a new root
  // (lore's own job has had two today — 76ca2416 until 06:57, 78c6d5cc from
  // 07:20 — under one daemon id and one socket lineage), so it keys an
  // incarnation, not the job.
  jobSessionId?: string
  // The claude.ai session behind a Remote Control job (`bridge-session`
  // records, `bridgeSessionId: cse_X` — the id commit trailers carry). This
  // one survives /clear AND respawn, which makes it the join that names a
  // session's agent across the whole job (jobs.bridge_key).
  bridgeSessionId?: string
}

// Tool inputs/results are indexed truncated: enough to find "that session where
// we ran X", not enough to bloat the index with full file dumps.
const TOOL_TEXT_CAP = 2_000

// Harness-injected user content (command wrappers, caveats, skill expansions,
// interruption markers) — searchable but not a human prompt. This regex was
// the ONLY test until v15, and a prose sniff can only catch what announces
// itself in its first characters: a skill body pulled in by a Skill call opens
// "Approach this as the design lead…" and sailed straight into the prompt lane
// as if the user had typed it.
const META_PROMPT =
  /^\s*(<(local-command|command-name|command-message|system-remind|task-notification)|Base directory for this skill:|\[Request interrupted by user)/

// Authorship is a FIELD, not a prose shape. The harness labels every user
// record it did not receive from a person, and lore ignored the labels:
// `origin.kind` is `human` for someone typing, `peer` for another Claude
// session's cross-session message, `task-notification` for the harness's own;
// `isMeta` marks content injected into the turn (skill bodies — with
// `sourceToolUseID` pointing back at the Skill call that pulled them in —
// image placeholders, context reports). Measured 2026-09-02 over the whole
// corpus: of 5,899 rows lore called `prompt`, 744 were injected and 114 came
// from a peer — 15% of the rows and 54% of the VOLUME, because injected
// bodies are long. Miners size buckets on that lane and read it as the user's
// voice, so the peer half was a provenance bug on top of a sizing one.
const Authorship = z.object({
  isMeta: z.boolean().nullish(),
  origin: z.object({ kind: z.string().nullish(), name: z.string().nullish(), msg_id: z.string().nullish() }).loose().nullish(),
})
type Authorship = z.infer<typeof Authorship>

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
    ...(typeof r.promptId === 'string' ? { promptId: r.promptId } : {}),
    ...(typeof r.session_id === 'string' && r.session_id !== r.sessionId ? { jobSessionId: r.session_id } : {}),
    ...(r.type === 'bridge-session' && typeof r.bridgeSessionId === 'string' ? { bridgeSessionId: r.bridgeSessionId } : {}),
  }

  switch (p.type) {
    case 'user': {
      const content = r.message?.content
      // Read the labels once per record, at the boundary, and let them decide
      // the lane — the prose is evidence of last resort now.
      const who = Authorship.safeParse(r).data ?? {}
      if (typeof content === 'string') {
        p.entries.push(userTextEntry(content, who))
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && block.text) {
            p.entries.push(userTextEntry(block.text, who))
          } else if (block?.type === 'tool_result') {
            const text = toolResultText(block.content)
            // An empty result still closes its instruction (latency, error).
            // A SendMessage ack names the message it delivered (`msg_id`);
            // that id is the join to the receiver's copy.
            const msgId = text.startsWith('{') ? /"msg_id":\s*"([^"]+)"/.exec(text)?.[1] : undefined
            p.entries.push({
              lane: 'tool',
              text: headTail(text),
              ...(typeof block.tool_use_id === 'string' ? { toolUseId: block.tool_use_id } : {}),
              isError: block.is_error === true,
              ...(msgId ? { msgId } : {}),
            })
          }
        }
      }
      break
    }
    // A message that arrives while the session is mid-turn is NOT a user
    // record. The harness queues it (`queue-operation` enqueue) and, when the
    // running turn next reads its queue, delivers it as an `attachment` of
    // type `queued_command` hung off the tool result it was read after
    // (`parentUuid`) — a peer's message, the user's own words, or a task
    // notification, each carrying the same authorship fields a user record
    // would. Measured on the lore↔ccc thread of 2026-09-02: 14 of lore's 22
    // messages reached ccc this way, and 10 of the 17 things the user typed
    // into ccc's session. Until v16 lore read only `user` and `assistant`, so
    // none of it was in any lane — the user's mid-turn "i think we want to
    // give ghostty a solid shot" was invisible to every miner.
    // The record's `type` stays `attachment` on the row: that is what says
    // "read inside the turn" rather than "opened it".
    case 'attachment': {
      const a = r.attachment
      if (a?.type !== 'queued_command' || typeof a.prompt !== 'string' || !a.prompt.trim()) break
      const who = Authorship.safeParse(a).data ?? {}
      p.entries.push(userTextEntry(a.prompt, who))
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
          cacheWrite5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
          cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
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
            ...(typeof block.id === 'string' ? { toolUseId: block.id } : {}),
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

function userTextEntry(text: string, who: Authorship): Entry {
  // A peer's words are neither the user's nor the harness's — they are another
  // session's, and the routing doctrine calls them an ingest surface, so they
  // get a lane of their own rather than being filed away as noise.
  if (who.origin?.kind === 'peer')
    return { lane: 'relay', text, ...(who.origin.name ? { peer: who.origin.name } : {}), ...(who.origin.msg_id ? { msgId: who.origin.msg_id } : {}) }
  // Injected, either by its own admission or — on transcripts older than the
  // field — by the shape of its prose. Command extraction must survive both
  // paths: `command:<name>` is how the ambient ROI ledger counts slash
  // commands, and a wrapper carries isMeta too.
  if (who.isMeta !== true && !META_PROMPT.test(text)) return { lane: 'prompt', text }
  const command = /<command-name>\/?([\w:-]+)<\/command-name>/.exec(text)?.[1]
  return { lane: 'meta', text, ...(command ? { toolName: `command:${command}` } : {}) }
}

// Tool RESULTS keep head + tail rather than head only: the verdict of a test
// run, a commit's sha line, and the last error all sit at the END of the
// output, and the explorer's annotations (docs/EXPLORER.md) read them there.
const RESULT_HEAD = 1_200
const RESULT_TAIL = 800
function headTail(text: string): string {
  if (text.length <= TOOL_TEXT_CAP) return text
  return `${text.slice(0, RESULT_HEAD)}\n… … …\n${text.slice(-RESULT_TAIL)}`
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
