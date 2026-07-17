import type { Database } from 'bun:sqlite'
import { z } from 'zod'

const Row = z.object({
  tool: z.string(),
  n: z.number(),
  sessions: z.number(),
  wells: z.number(),
  first: z.string().nullable(),
  last: z.string().nullable(),
})
export type ToolUsageRow = z.infer<typeof Row>

// The evidence half of the ambient ROI ledger (lore#7): how often each
// invocable — tool, `mcp__<server>__*`, `Skill:<name>`, `command:<name>` —
// was ACTUALLY used, over which wells and when. The scoring half (ambient
// cost × scope vs this usage; zero-use flags, detach candidates) is a
// judgment-layer read over this table plus the current rosters.
export function listToolUsage(
  db: Database,
  opts: { well?: string; exact?: boolean; since?: string; prefix?: string; limit: number },
): ToolUsageRow[] {
  const where: string[] = ['m.tool_name IS NOT NULL']
  const params: (string | number)[] = []
  if (opts.well) {
    where.push(opts.exact ? '(w.dir = ? OR w.real_path = ?)' : '(w.dir LIKE ? OR w.real_path LIKE ?)')
    const v = opts.exact ? opts.well : `%${opts.well}%`
    params.push(v, v)
  }
  if (opts.since) {
    where.push('m.ts >= ?')
    params.push(opts.since)
  }
  if (opts.prefix) {
    where.push('m.tool_name LIKE ?')
    params.push(`${opts.prefix}%`)
  }
  const sql = `
    SELECT m.tool_name AS tool, COUNT(*) AS n,
           COUNT(DISTINCT m.session_id) AS sessions,
           COUNT(DISTINCT w.dir) AS wells,
           MIN(m.ts) AS first, MAX(m.ts) AS last
    FROM messages m
    JOIN sessions s ON s.session_id = m.session_id
    JOIN wells w ON w.id = s.well_id
    WHERE ${where.join(' AND ')}
    GROUP BY m.tool_name ORDER BY n DESC LIMIT ?`
  return z
    .array(Row)
    .parse(db.prepare(sql).all(...params, opts.limit))
    .map((r) => ({ ...r, first: r.first?.slice(0, 10) ?? null, last: r.last?.slice(0, 10) ?? null }))
}
