// Model identity, one definition (docs/EXPLORER.md §Which model ran this).
//
// Every surface that names a conversation names what RAN it: the roster, the
// recent list, a well's sessions, a search hit, a session's spine. The
// question "which tokens came from which model" is the fleet's standing
// question (CLAUDE.md's fan-out rules), and an explorer that answers it only
// after you open a session answers it too late.
//
// The label is the id with the ceremony removed (`claude-opus-4-8` →
// `opus-4.8`); the COLOUR is the family and only the family. Four families
// fit the categorical palette exactly, so hue stays stable across every page
// and window — blue is opus wherever you see it — and the generation rides
// in the text, where a fifth and sixth hue would have failed anyway. The
// full id is always the chip's `title`.

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other'

// Fixed order: legends, stacks and chip runs all read the same way, whatever
// the window holds.
export const FAMILIES: readonly ModelFamily[] = ['opus', 'fable', 'sonnet', 'haiku', 'other']

// `claude-haiku-4-5-20251001` → `haiku-4-5`; a `[1m]` context tag is kept.
function strip(id: string): { base: string; tag: string } {
  const tag = /\[[^\]]*\]$/.exec(id)?.[0] ?? ''
  const base = (tag ? id.slice(0, -tag.length) : id).replace(/^claude-/, '').replace(/-\d{8}$/, '')
  return { base, tag }
}

export function modelFamily(id: string | null | undefined): ModelFamily {
  if (!id) return 'other'
  const head = strip(id).base.split('-')[0] ?? ''
  return (FAMILIES as readonly string[]).includes(head) && head !== 'other' ? (head as ModelFamily) : 'other'
}

// `claude-opus-4-8` → `opus-4.8`. An id that is not a family-version pair
// (`<synthetic>`, `?`) passes through untouched — never guess at a shape.
export function modelLabel(id: string | null | undefined): string {
  if (!id) return '?'
  const { base, tag } = strip(id)
  const m = /^([a-z]+)-(\d+(?:-\d+)*)$/.exec(base)
  return m ? `${m[1]}-${m[2]!.replace(/-/g, '.')}${tag}` : `${base}${tag}`
}

// The CSS class both marks and swatches wear: `m-opus`, `m-other`.
export function modelClass(id: string | null | undefined): string {
  return `m-${modelFamily(id)}`
}

// The model that did most of the work — by requests, ties broken by id so
// the answer is stable. Used wherever one line has room for one chip.
export function dominantModel(models: { model: string; requests: number }[] | null | undefined): string | null {
  if (!models || models.length === 0) return null
  return models.reduce((a, b) => (b.requests > a.requests || (b.requests === a.requests && b.model < a.model) ? b : a)).model
}

// Distinct models in work order (most requests first) — the mix a list row
// shows as one chip plus a `+n`, and a session header shows in full.
export function orderModels<T extends { model: string; requests: number }>(models: T[]): T[] {
  return models.slice().sort((a, b) => b.requests - a.requests || (a.model < b.model ? -1 : 1))
}

// Count served models over a run of requests, most requests first: the mix
// a session header shows, the dominant a row shows.
export function tallyModels(ids: (string | null | undefined)[]): { model: string; requests: number }[] {
  const n = new Map<string, number>()
  for (const id of ids) if (id) n.set(id, (n.get(id) ?? 0) + 1)
  return orderModels([...n].map(([model, requests]) => ({ model, requests })))
}

// Drift: the model that SERVED a spawn does not contain the alias that was
// requested (asked "sonnet", served fable). Only computable when a model
// parameter was actually passed — one definition, used by the spawn
// observatory and by the session page's fan-out ledger alike.
export function modelDrift(requested: string | null | undefined, served: string | null | undefined): boolean | null {
  if (!requested || !served) return null
  return !served.includes(requested)
}
