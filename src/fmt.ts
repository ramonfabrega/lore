// Number and text formatters shared by the pages (web.ts) and the block
// view (block.ts). Display only — the JSON surfaces carry raw numbers.

export function tok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return String(n)
}

export function usd(n: number | null): string {
  return n == null ? '—' : `$${n.toFixed(2)}`
}

export function ms(n: number | null): string {
  if (n == null) return ''
  if (n < 1000) return `${n}ms`
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`
  if (n < 3_600_000) return `${Math.round(n / 60_000)}min`
  return `${(n / 3_600_000).toFixed(1)}h`
}

export function cut(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

// "19:51:56" from an ISO timestamp (UTC — every page shows UTC).
export function hms(ts: string | null): string {
  return ts ? ts.slice(11, 19) : ''
}
export function hm(ts: string | null): string {
  return ts ? ts.slice(11, 16) : ''
}
