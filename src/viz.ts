import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { TZ } from './config'
import { day, dayName, hm, hms, stamp, tok, usd, volatile, when, whenForms, whenShort, zone } from './fmt'
import { modelClass, modelLabel, orderModels } from './model'

// The explorer's marks (dataviz skill): thin bars, 2px surface gaps, per-mark
// <title> tooltips, text in text ink, series hues from the reference
// palette (series-1..4 tokens in style.ts). SVG coordinates are abstract
// and the figure stretches to its panel (`preserveAspectRatio="none"`), so
// no text lives inside an SVG — axis labels are HTML beside it.

type H = HtmlEscapedString | Promise<HtmlEscapedString>

export type Point = { label: string; value: number; title: string; href?: string }

// One series of bars, filling the width of its panel.
export function bars(points: Point[], o: { height?: number } = {}) {
  if (points.length === 0) return html``
  const h = o.height ?? 56
  const W = points.length * 10
  const max = Math.max(...points.map((p) => p.value), 1e-9)
  return html`<figure class="viz">
    <svg viewBox="0 0 ${W} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="${points.map((p) => p.title).join('; ')}">
      ${points.map((p, i) => {
        const bh = Math.max(1, (p.value / max) * h)
        const rect = html`<rect class="mark" x="${i * 10}" y="${(h - bh).toFixed(2)}" width="8" height="${bh.toFixed(2)}"><title>${p.title}</title></rect>`
        return p.href ? html`<a href="${p.href}">${rect}</a>` : rect
      })}
    </svg>
    <div class="axis"><span>${points[0]!.label}</span><span>${points[points.length - 1]!.label}</span></div>
  </figure>`
}

// Stacked bars: one column per point, segments in fixed series order (the
// legend is rendered by the caller in text ink). `series[k].values[i]`.
export type Series = { name: string; cls: string; values: number[] }
export function stackedBars(labels: string[], series: Series[], o: { height?: number; title?: (i: number) => string; href?: (i: number) => string }) {
  const n = labels.length
  if (n === 0 || series.length === 0) return html``
  const h = o.height ?? 72
  const W = n * 10
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0))
  const max = Math.max(...totals, 1e-9)
  const cols: H[] = []
  for (let i = 0; i < n; i++) {
    let y = h
    const segs: H[] = []
    for (const s of series) {
      const v = s.values[i] ?? 0
      if (v <= 0) continue
      const sh = (v / max) * h
      y -= sh
      // a 1-unit gap between segments (the 2px surface gap at stretch)
      segs.push(html`<rect class="mark ${s.cls}" x="${i * 10}" y="${y.toFixed(2)}" width="8" height="${Math.max(0.5, sh - 1).toFixed(2)}"><title>${s.name} ${usd(v)}</title></rect>`)
    }
    const g = html`<g>${o.title ? html`<rect x="${i * 10}" y="0" width="10" height="${h}" fill="transparent"><title>${o.title(i)}</title></rect>` : ''}${segs}</g>`
    cols.push(o.href ? html`<a href="${o.href(i)}">${g}</a>` : g)
  }
  return html`<figure class="viz">
    <svg viewBox="0 0 ${W} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="${labels[0]} to ${labels[n - 1]}">${cols}</svg>
    <div class="axis"><span>${labels[0]}</span><span>${labels[n - 1]}</span></div>
  </figure>`
}

// An inline bar beside a number: the value as a fraction of the largest in
// its list, so the heavy row reads before its digits do. It is a RANK within
// the rows on screen, never a fraction of a budget or a total — filter the
// list and every bar rescales.
//
// `of` names that denominator in the tooltip, because nothing else on the
// page does: unlabelled, the mark reads as a progress bar toward some
// unstated whole. Callers pass the noun for the row ('priciest session
// listed'); `fmt` renders the denominator's value in the column's own unit.
// The mark stays aria-hidden — its number sits beside it in the same cell,
// so a screen reader gets the value, not a redundant bar.
export function ibar(v: number, max: number, o: { of?: string; fmt?: (n: number) => string } = {}) {
  if (!(max > 0)) return html``
  const pct = Math.round((v / max) * 100)
  const shown = (o.fmt ?? usd)(max)
  return html`<span class="ib" aria-hidden="true" title="${pct}% of the ${o.of ?? 'largest row listed'} (${shown})"><i style="width:${Math.max(2, pct)}%"></i></span>`
}

// The list-price fee split by token class as one stacked bar. Dollars, not
// tokens — cache reads are 100× the tokens and a tenth of the money.
export type FeeSplit = { input: number; cacheWrite: number; cacheRead: number; output: number }
export const FEE_PARTS = [
  { key: 'output', label: 'output' },
  { key: 'cache-read', label: 'cache read' },
  { key: 'cache-write', label: 'cache write' },
  { key: 'input', label: 'input' },
] as const
function feeValues(f: FeeSplit) {
  return [f.output, f.cacheRead, f.cacheWrite, f.input]
}
export function feeBar(f: FeeSplit, o: { caption?: boolean; unpriced?: number } = {}) {
  const vals = feeValues(f)
  const total = vals.reduce((a, v) => a + v, 0)
  if (total <= 0) return html``
  return html`<figure class="fee">
    <div class="feebar" role="img" aria-label="${FEE_PARTS.map((p, i) => `${p.label} ${usd(vals[i]!)}`).join(', ')}">
      ${FEE_PARTS.map((p, i) => html`<span class="seg ${p.key}" style="flex-basis:${((vals[i]! / total) * 100).toFixed(2)}%" title="${p.label} ${usd(vals[i]!)} · ${Math.round((vals[i]! / total) * 100)}%"></span>`)}
    </div>
    ${o.caption === false
      ? ''
      : html`<figcaption class="small muted">${FEE_PARTS.map(
          (p, i) => html`<span class="key"><i class="sw ${p.key}"></i>${p.label} <b>${usd(vals[i]!)}</b> <span class="pct">${Math.round((vals[i]! / total) * 100)}%</span></span>`,
        )}${o.unpriced ? html`<span class="key err">${o.unpriced} unpriced</span>` : ''}</figcaption>`}
  </figure>`
}

// The legend for the fee bar, once per page when many bars share it.
export function feeLegend() {
  return html`<span class="legend small muted">${FEE_PARTS.map((p) => html`<span class="key"><i class="sw ${p.key}"></i>${p.label}</span>`)}</span>`
}

export function tokOrBlank(n: number | null | undefined): string {
  return n == null ? '' : tok(n)
}

// A sparkline for a stat tile: the trend behind the number, last bar
// full-strength. No axis, no labels — the tile's label names it.
export function spark(values: number[], o: { height?: number; title?: (i: number) => string } = {}) {
  const n = values.length
  if (n === 0) return html``
  const h = o.height ?? 28
  const W = n * 10
  const max = Math.max(...values, 1e-9)
  return html`<div class="spark"><svg viewBox="0 0 ${W} ${h}" height="${h}" preserveAspectRatio="none" aria-hidden="true">${values.map((v, i) => {
    const bh = Math.max(1, (v / max) * h)
    return html`<rect class="mark ${i === n - 1 ? 'last' : ''}" x="${i * 10}" y="${(h - bh).toFixed(2)}" width="8" height="${bh.toFixed(2)}">${o.title ? html`<title>${o.title(i)}</title>` : ''}</rect>`
  })}</svg></div>`
}

// ---- instants (fmt.ts's ladder) ---------------------------------------

// Every instant the pages show goes through here, and the shape is the one
// every design system lands on: a short readable text, a machine-readable
// `datetime`, and the full absolute — seconds and zone — in the tooltip. The
// pages used to put a raw UTC ISO string in that tooltip while the text beside
// it was local, so hovering "17:45" said "22:45": the localization reached
// the text and not its own tooltip.
//
// A stamp within two days also carries the texts it will read as tomorrow and
// the day after (`whenForms`), which is what style.ts's tick script selects
// among. Server-rendered text stays the truth of the page — the script only
// keeps it current — so a page still reads correctly with no JS at all, and
// the tests still assert on rendered HTML rather than on what a browser
// would have done to it.
export function timeEl(ts: string | null, o: { full?: boolean; title?: string; now?: number } = {}) {
  if (!ts) return html``
  const short = !o.full
  const now = o.now ?? Date.now()
  const text = short ? whenShort(ts, TZ, now) : when(ts, TZ, now)
  const title = o.title ? `${o.title} · ${stamp(ts)}` : stamp(ts)
  if (!volatile(ts, now)) return html`<time datetime="${ts}" title="${title}">${text}</time>`
  return html`<time datetime="${ts}" title="${title}" data-forms="${whenForms(ts, TZ, now, short).join('|')}">${text}</time>`
}

// The wall clock, with the same tooltip and no ladder: for rows that already
// sit under a date — a session's own transactions, a thread's messages, a
// listing grouped by day header — where "2 sep" would repeat what the group
// above it says and a clock is the only thing that varies down the column.
export function clockEl(ts: string | null, o: { sec?: boolean } = {}) {
  if (!ts) return html``
  const t = o.sec ? hms(ts) : hm(ts)
  if (!t) return html``
  return html`<time datetime="${ts}" title="${stamp(ts)}">${t}</time>`
}

// A span — a session, a thread, a job — as its header states it. Both ends
// are absolute and of the SAME kind: a header is identity, not freshness, and
// "28m ago → 23:03" makes a reader do subtraction to learn what the second
// half already told them. The date appears once unless the span crosses one,
// and the zone comes from the FIRST instant rather than from the reading, so
// a July session read in January says EDT.
export function spanEl(a: string | null, b: string | null, o: { sec?: boolean } = {}) {
  if (!a) return html``
  const crossed = day(b) !== day(a)
  return html`${dayName(day(a))} ${clockEl(a, o)} → ${crossed ? html`${dayName(day(b))} ` : ''}${clockEl(b, o)} ${zone(a)}`
}

// ---- model identity (model.ts) ----------------------------------------

// A model chip: the family's hue as a swatch, the short label as text, the
// full id in the title. Identity, not a measurement — it wears the same
// shape in a dense row, a header and a legend, so the eye learns it once.
export function modelChip(id: string | null | undefined, o: { title?: string } = {}) {
  if (!id) return html``
  return html`<span class="mchip" title="${o.title ?? id}"><i class="sw ${modelClass(id)}"></i>${modelLabel(id)}</span>`
}

// A mix, most work first: the leading chips, then `+n` for the tail. One
// line, whatever the session did.
export function modelChips(models: { model: string; requests: number }[] | null | undefined, o: { max?: number } = {}) {
  if (!models || models.length === 0) return html``
  const ordered = orderModels(models)
  const max = o.max ?? 1
  const head = ordered.slice(0, max)
  const rest = ordered.slice(max)
  const all = ordered.map((m) => `${m.model} ×${m.requests}`).join('\n')
  return html`${head.map((m) => modelChip(m.model, { title: all }))}${
    rest.length ? html`<span class="mchip more" title="${all}">+${rest.length}</span>` : ''
  }`
}
