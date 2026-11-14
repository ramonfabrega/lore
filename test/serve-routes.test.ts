import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { allowsFallthrough } from '../src/web'

// The `serve` description (and so the generated skill) said "Under /cli/ the
// read verbs are routes" while thread, conversation, loop, polls and limits
// answered 404 there (2026-11-14). It now names the routed verbs and the
// unrouted ones; this holds the two lists to web.ts's allowsFallthrough.
const source = await Bun.file(join(import.meta.dir, '..', 'src', 'cli.ts')).text()
const routed = /Under \/cli\/ these verbs are routes with the JSON envelope, and only these: ([^(]+) \(/.exec(source)?.[1]
const unrouted = /the writers \(([^)]+)\) and also ([^:]+):/.exec(source)
const verbs = (list: string) =>
  list
    .replace(/…/g, '')
    .split(/,| and /)
    .map((s) => s.trim())
    .filter(Boolean)
const path = (verb: string) => `http://localhost:4949/cli/${verb.replace(' ', '/')}`

describe('the serve description names exactly the /cli/ routes', () => {
  test('the description carries both lists', () => {
    expect(routed).toBeDefined()
    expect(unrouted).not.toBeNull()
  })
  test('every verb it names as a route is one', () => {
    for (const v of verbs(routed ?? '')) expect([v, allowsFallthrough(new Request(path(v)))]).toEqual([v, true])
  })
  test('every verb it names as unrouted 404s', () => {
    for (const v of [...verbs(unrouted?.[1] ?? ''), ...verbs(unrouted?.[2] ?? '')]) expect([v, allowsFallthrough(new Request(path(v)))]).toEqual([v, false])
  })
})
