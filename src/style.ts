// The explorer's stylesheet — one string, inlined into every page (no build
// step, no asset route). A console, not a document: the viewport is the
// frame, `main` is a grid of panels, and panels scroll internally. Tokens
// are the dataviz reference palette; text wears text ink, marks wear
// series hues, status colors are reserved.

export const CSS = `
:root { color-scheme: light dark;
  --surface: #fcfcfb; --surface-2: #f1f1ee; --surface-3: #e6e6e1; --line: #e2e2dd; --ink: #0b0b0b; --ink-2: #52514e; --ink-3: #8a8985;
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100; --crit: #d03b3b; --good: #0ca30c; --warn: #b45309; --err: #b91c1c; --link: #1d5fb3; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --surface: #1a1a19; --surface-2: #232322; --surface-3: #2c2c2a; --line: #34342f; --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #8d8c84;
  --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500; --crit: #d03b3b; --good: #0ca30c; --warn: #f59e0b; --err: #f87171; --link: #7ab3f5; } }
:root[data-theme="dark"] {
  --surface: #1a1a19; --surface-2: #232322; --surface-3: #2c2c2a; --line: #34342f; --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #8d8c84;
  --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500; --crit: #d03b3b; --good: #0ca30c; --warn: #f59e0b; --err: #f87171; --link: #7ab3f5; }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--surface); color: var(--ink); display: flex; flex-direction: column; overflow: hidden;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
h1 { font-size: 16px; margin: 0; } h2 { font-size: 12.5px; margin: 0; font-weight: 600; }
.muted { color: var(--ink-3); } .err { color: var(--err); } .small { font-size: 11.5px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }

/* nav */
.nav { flex: none; display: flex; gap: 14px; align-items: center; padding: 6px 14px; border-bottom: 1px solid var(--line); }
.nav a { color: var(--ink-2); } .nav a:first-child { font-weight: 600; color: var(--ink); } .nav a.on { color: var(--ink); }
.navsearch { margin-left: auto; } .navsearch input, .searchform input[type=search] { font: inherit; padding: 3px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-2); color: var(--ink); min-width: 240px; }
.searchform { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 0 0 8px; } .searchform button { font: inherit; padding: 3px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-2); color: var(--ink); cursor: pointer; }

/* the frame: main is a grid of panels; panels scroll, the page does not */
main { flex: 1; min-height: 0; display: grid; gap: 10px; padding: 10px 14px 12px; }
main.layout-one { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
main.layout-head { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
main.layout-root { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); grid-template-rows: auto minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: "kpi chart" "recent agents" "recent active"; }
main.layout-usage { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); grid-template-rows: auto minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: "chart chart" "models days" "wells days"; }
.area-kpi { grid-area: kpi; } .area-chart { grid-area: chart; } .area-recent { grid-area: recent; } .area-agents { grid-area: agents; } .area-active { grid-area: active; }
.area-models { grid-area: models; } .area-days { grid-area: days; } .area-wells { grid-area: wells; }
.panel { display: flex; flex-direction: column; min-height: 0; min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.panel > header { flex: none; display: flex; align-items: baseline; gap: 8px; padding: 5px 10px; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--ink-3); }
.panel > header h2 { color: var(--ink); } .panel > header .sp { margin-left: auto; }
.panel > .scroll { flex: 1; min-height: 0; overflow: auto; } .panel > .body { padding: 8px 10px; }
.page-head { min-width: 0; } .crumbs { color: var(--ink-3); margin: 0 0 2px; font-size: 12px; }
.kpis { display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; align-items: flex-start; }
.tiles { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px; }
.tile { background: var(--surface-2); border-radius: 6px; padding: 4px 10px; min-width: 84px; }
.tile .v { font-size: 15px; font-variant-numeric: tabular-nums; } .tile .l { font-size: 10.5px; color: var(--ink-3); }
.tile.warn .v { color: var(--warn); } .tile.good .v { color: var(--good); }
.footnote { font-size: 11.5px; color: var(--ink-3); padding: 4px 10px; }

/* tables (the classic surfaces) */
table { border-collapse: collapse; width: 100%; } th, td { padding: 3px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--ink-3); font-weight: 500; font-size: 11.5px; position: sticky; top: 0; background: var(--surface); z-index: 1; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.prompt { max-width: 640px; }
tr.meta td, tr.command td, tr.done td { color: var(--ink-3); }
.kind { font-size: 10.5px; padding: 0 5px; border-radius: 4px; background: var(--surface-2); color: var(--ink-2); white-space: nowrap; }
.kind.err { color: var(--err); }
.kind.st-working { color: var(--series-1); } .kind.st-blocked { color: var(--warn); } .kind.st-failed { color: var(--err); } .kind.st-stopped { color: var(--warn); }

/* dense lists: grid rows, one line each, ellipsis — the console's unit */
.list .row { display: grid; gap: 0 10px; align-items: baseline; padding: 3px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.list .row > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.list .row.head { position: sticky; top: 0; background: var(--surface); color: var(--ink-3); font-size: 11.5px; font-weight: 500; z-index: 1; }
.list .row .num { text-align: right; }
.list .row.done, .list .row.muted { color: var(--ink-3); }
.list.recent .row { grid-template-columns: 42px 200px minmax(0, 1fr) 30px 40px 44px 104px; }
.list.active .row { grid-template-columns: minmax(0, 1fr) 40px 52px 112px; }
.list.agents .row { grid-template-columns: 12px minmax(70px, 1fr) minmax(0, 2fr) 96px 60px; }
.list.roster .row { grid-template-columns: 78px 140px 190px minmax(0, 1fr) 96px 44px 64px 88px 64px 178px; }
.list.models .row { grid-template-columns: minmax(120px, 1fr) 56px 36px 48px 48px 120px 108px; }
.list.wells .row { grid-template-columns: minmax(0, 1fr) 56px 36px 48px 112px; }
.list.days .row { grid-template-columns: 74px 52px 34px 48px 48px 112px; }
.list.sessions .row { grid-template-columns: 84px 92px minmax(0, 1fr) 28px 44px 44px 52px 104px 44px; }
.list.jobs .row { grid-template-columns: 120px 120px minmax(0, 1fr) 44px 48px 48px 104px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ink-3); vertical-align: middle; }
.dot.st-working { background: var(--series-1); } .dot.st-blocked, .dot.st-stopped { background: var(--warn); } .dot.st-failed { background: var(--crit); } .dot.st-done { opacity: .5; }
.list.roster details { display: inline; } .list.roster summary { cursor: pointer; list-style: none; color: var(--link); } .list.roster summary::-webkit-details-marker { display: none; }
.list.roster details[open] { display: block; white-space: normal; }

/* marks */
.viz { margin: 0; } .viz svg { display: block; max-width: 100%; }
.viz .axis { display: flex; justify-content: space-between; font-size: 10px; color: var(--ink-3); font-family: ui-monospace, Menlo, monospace; margin-top: 2px; }
.viz .mark { fill: var(--series-1); } .viz .mark.s2 { fill: var(--series-2); } .viz .mark.s3 { fill: var(--series-3); } .viz .mark.s0 { fill: var(--ink-3); }
.viz a:hover .mark { opacity: .8; }
.legend .key { margin-right: 12px; }
.ib { display: inline-block; width: 40px; height: 5px; margin-right: 6px; vertical-align: middle; background: var(--surface-2); border-radius: 2px; overflow: hidden; }
.ib i { display: block; height: 100%; background: var(--series-1); opacity: .75; }
.sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: middle; background: var(--ink-3); }
.sw.read { background: var(--series-1); } .sw.write { background: var(--series-2); } .sw.run { background: var(--series-3); }
.sw.s1 { background: var(--series-1); } .sw.s2 { background: var(--series-2); } .sw.s3 { background: var(--series-3); } .sw.s0 { background: var(--ink-3); }
.fee { margin: 6px 0 2px; } .feebar { display: flex; gap: 2px; height: 8px; max-width: 720px; }
.feebar .seg { display: block; min-width: 2px; border-radius: 2px; }
.seg.output, .sw.output { background: var(--series-1); } .seg.cache-read, .sw.cache-read { background: var(--series-2); }
.seg.cache-write, .sw.cache-write { background: var(--series-3); } .seg.input, .sw.input { background: var(--series-4); }
.fee figcaption { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 4px; } .fee .key b { font-weight: 500; color: var(--ink-2); } .fee .pct { color: var(--ink-3); }
.list .fee { margin: 0; display: inline-block; width: 100%; vertical-align: middle; } .list .feebar { height: 6px; }

/* the block view (block.ts) */
.tl { margin: 8px 0 0; } .tl svg { display: block; max-width: 100%; height: auto; }
.tl .band { fill: var(--surface-2); } .tl .band.alt { fill: color-mix(in oklab, var(--surface-2) 50%, var(--surface)); } .tl .band.meta, .tl .band.command { fill: transparent; }
.tl a:hover .band { fill: color-mix(in oklab, var(--series-1) 18%, var(--surface-2)); }
.tl .bandn, .tl .lane, .tl .axis { fill: var(--ink-3); font-size: 9px; font-family: ui-monospace, Menlo, monospace; }
.tl .lanel, .tl .tick { stroke: var(--line); stroke-width: 0.5; }
.tl .m { fill: var(--ink-3); rx: 1; } .tl .m.read { fill: var(--series-1); } .tl .m.write { fill: var(--series-2); } .tl .m.run { fill: var(--series-3); }
.tl .m.say { fill: var(--ink-2); } .tl .m.err { fill: var(--crit); }
.spine .row { display: grid; grid-template-columns: 30px 64px minmax(0, 1fr) 48px 48px 36px 56px 112px 100px; gap: 0 8px; align-items: baseline; padding: 4px 8px; border-bottom: 1px solid var(--line); }
.spine .row.head { position: sticky; top: 0; color: var(--ink-3); font-weight: 500; font-size: 11.5px; background: var(--surface); z-index: 1; }
.spine .row .num { text-align: right; } .spine .row .n { text-align: right; }
.spine .row.meta, .spine .txn.meta .row, .spine .txn.command .row { color: var(--ink-3); }
.spine details.txn > summary { cursor: pointer; list-style: none; } .spine details.txn > summary::-webkit-details-marker { display: none; }
.spine .txn .ptext::before { content: '▸ '; color: var(--ink-3); } .spine .txn[open] .ptext::before { content: '▾ '; } .spine .row.txn .ptext::before { content: ''; }
.spine details.txn:not([open]) .ptext { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.spine .txn[open] > summary { background: var(--surface-2); }
.spine .body { padding: 4px 8px 10px 102px; border-bottom: 1px solid var(--line); }
details > summary { cursor: pointer; list-style: none; } summary::-webkit-details-marker { display: none; }
.phase { margin: 4px 0; } .phase > summary { padding: 2px 0; } .phase > summary::before { content: '▸ '; color: var(--ink-3); } .phase[open] > summary::before { content: '▾ '; }
.note { color: var(--ink-2); font-style: italic; } p.note { margin: 6px 0 2px; }
.reply { color: var(--ink-2); margin: 6px 0 2px; } .ann { margin: 2px 0 4px; }
table.ix { margin: 4px 0; } table.ix th { position: static; } table.ix td { border-bottom: 0; } table.ix tr.step td { border-top: 1px solid var(--line); }
table.ix td.t, table.ix td.fee, table.ix td.tool { white-space: nowrap; } table.ix td.in { width: 34%; overflow-wrap: anywhere; } table.ix td.res { width: 40%; overflow-wrap: anywhere; }
tr.err td { color: var(--err); } tr.thought td { padding: 2px 8px; } tr.thought p { margin: 4px 0; }

/* search */
.hit { padding: 6px 0; border-bottom: 1px solid var(--line); } .hit > div { margin: 2px 0; } .hit .mono { margin-right: 8px; }
.snippet { color: var(--ink-2); font-size: 12.5px; padding-left: 8px; } .snippet a { color: inherit; }
mark { background: color-mix(in oklab, var(--series-1) 22%, transparent); color: inherit; border-radius: 2px; padding: 0 1px; }

/* narrow: the page scrolls, panels stack */
@media (max-width: 900px) {
  body { overflow: auto; height: auto; } html { height: auto; }
  main { display: flex; flex-direction: column; } .panel { max-height: 70vh; } .panel > .scroll { max-height: 60vh; }
  .list.recent .row { grid-template-columns: 42px 100px minmax(0, 1fr) 100px; } .list.recent .row > .hide { display: none; }
}
`
