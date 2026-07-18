// FTS5 parses bare hyphens as column-filter syntax ("three-tier" → `no such
// column: tier`) and stray quotes/apostrophes as unterminated strings — the
// queries agents actually type. Valid FTS5 syntax must keep working (phrases,
// prefix*, AND/OR/NOT, col:term), so the raw query always runs first; only a
// query-parse failure retries with every whitespace token quoted as a literal
// phrase (implicit AND). Any other error is real — rethrow.

export function quoteFtsTokens(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(' ')
}

// `no such column` is how FTS5 reports a term misparsed as a column filter;
// the fixed SQL around MATCH contributes no dynamic identifiers, so here it
// can only mean the query.
const FTS_PARSE_ERROR = /fts5|no such column|unterminated string/i

export function ftsMatch<T>(query: string, run: (q: string) => T): T {
  try {
    return run(query)
  } catch (e) {
    if (!(e instanceof Error) || !FTS_PARSE_ERROR.test(e.message)) throw e
    const quoted = quoteFtsTokens(query)
    if (!quoted) throw new Error(`invalid FTS5 query: ${JSON.stringify(query)}`)
    try {
      return run(quoted)
    } catch (e2) {
      if (!(e2 instanceof Error) || !FTS_PARSE_ERROR.test(e2.message)) throw e2
      throw new Error(`invalid FTS5 query: ${JSON.stringify(query)}`)
    }
  }
}
