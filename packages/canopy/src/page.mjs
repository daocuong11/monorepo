// @ts-check
import { facetsOf, inboxItems, priorityRank, viewOf } from './inbox.mjs'
import { markdown } from './markdown.mjs'

const CSS = `
/* Neutrals carry a trace of canopy green (hue 150); blue is kept for action and selection so green can mean healthy.
   --flow-* is one hue stepping intake to promote; --fam-* tells cambium, claude and mycelium spans apart. */
:root{color-scheme:light dark;--bg:oklch(.975 .005 150);--panel:oklch(.997 .002 150);--line:oklch(.91 .008 150);--text:oklch(.24 .012 150);
--muted:oklch(.46 .014 150);--faint:oklch(.53 .014 150);--chip:oklch(.948 .008 150);--bar:oklch(.875 .01 150);
--ok:oklch(.52 .12 152);--warn:oklch(.52 .125 62);--err:oklch(.53 .17 26);--accent:oklch(.49 .13 256);
--flow-1:oklch(.8 .06 256);--flow-2:oklch(.68 .1 256);--flow-3:oklch(.56 .13 256);--flow-4:oklch(.43 .12 256);
--fam-cambium:oklch(.58 .12 256);--fam-claude:oklch(.57 .15 305);--fam-mycelium:oklch(.6 .1 190);--health:var(--faint);
--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px}
@media (prefers-color-scheme:dark){:root{--bg:oklch(.175 .007 150);--panel:oklch(.215 .008 150);--line:oklch(.3 .009 150);--text:oklch(.925 .007 150);
--muted:oklch(.77 .012 150);--faint:oklch(.65 .012 150);--chip:oklch(.26 .009 150);--bar:oklch(.34 .01 150);
--ok:oklch(.76 .13 152);--warn:oklch(.79 .12 72);--err:oklch(.73 .14 22);--accent:oklch(.77 .1 256);
--flow-1:oklch(.42 .06 256);--flow-2:oklch(.54 .09 256);--flow-3:oklch(.66 .11 256);--flow-4:oklch(.8 .1 256);
--fam-cambium:oklch(.71 .11 256);--fam-claude:oklch(.71 .13 305);--fam-mycelium:oklch(.75 .09 190)}}
body[data-health=ok]{--health:var(--ok)}body[data-health=warn]{--health:var(--warn)}body[data-health=err]{--health:var(--err)}body.down{--health:var(--faint)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
::selection{background:color-mix(in srgb,var(--accent) 28%,transparent)}
a{color:var(--accent);text-decoration:none;text-underline-offset:2px}a:hover{text-decoration:underline}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
#top{position:sticky;top:0;z-index:1;border-top:3px solid var(--health);transition:border-color .4s ease-out}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px var(--s4);padding:10px var(--s4);border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:14px;margin:0;font-weight:600}
.tabs{display:flex;gap:var(--s5);padding:0 var(--s4);border-bottom:1px solid var(--line);background:var(--panel);overflow-x:auto;scrollbar-width:none}
.tab{appearance:none;background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:9px 0 8px;font:inherit;font-weight:500;color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.tab:hover{color:var(--text)}.tab[aria-selected=true]{color:var(--text);border-bottom-color:var(--accent);font-weight:600}
.tab:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:3px}
.tab .count{min-width:18px;padding:0 6px;border-radius:9px;background:var(--chip);color:var(--muted);font-size:12px;font-weight:500;text-align:center}
.tab .count.attn{background:color-mix(in srgb,var(--warn) 20%,transparent);color:var(--warn);font-weight:600}
.tab .dot{margin:0}
main{padding:var(--s4) var(--s4) var(--s5);display:grid;gap:var(--s4);max-width:1600px}
.ib{display:grid;grid-template-columns:minmax(300px,420px) minmax(0,1fr);gap:var(--s3) var(--s4);align-items:start}
.ib-tools{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2) var(--s4)}
.seg{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:2px}
.seg button,.chip{appearance:none;font:inherit;font-size:12px;color:var(--muted);cursor:pointer;white-space:nowrap}
.seg button{background:none;border:0;border-radius:4px;padding:2px 10px}
.seg button:hover,.chip:hover{color:var(--text)}
.seg button[aria-pressed=true]{background:var(--chip);color:var(--text);font-weight:600}
.facets{flex-basis:100%;order:3;display:flex;flex-wrap:wrap;align-items:center;gap:6px}.facet{display:contents}
.facet+.facet>.chip:first-child{margin-left:var(--s2)}
.chip{display:inline-flex;align-items:center;gap:6px;padding:1px 9px;border:1px solid var(--line);border-radius:999px;background:var(--panel)}
.chip .n{color:var(--faint)}
.chip[aria-pressed=true]{color:var(--text);font-weight:600;border-color:color-mix(in srgb,var(--accent) 55%,var(--line));background:color-mix(in srgb,var(--accent) 12%,var(--panel))}
.chip[aria-pressed=true] .n{color:var(--muted)}
.seg button:focus-visible,.chip:focus-visible,.btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.ib-count{margin-left:auto;font-size:12px}
.ib-side{min-width:0}
.ib-list{padding:0;overflow:hidden}
.ib-list ul{list-style:none;margin:0;padding:0}
.row{display:grid;gap:3px;padding:10px var(--s3);border-top:1px solid var(--line);cursor:pointer;outline:none}
.row:first-child{border-top:0}
.row:hover{background:color-mix(in srgb,var(--chip) 70%,transparent)}
.row[aria-selected=true]{background:color-mix(in srgb,var(--accent) 11%,var(--panel))}
.row:focus-visible{box-shadow:inset 0 0 0 2px var(--accent)}
.row-t{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;font-weight:500}
.row[aria-selected=true] .row-t{font-weight:600}
.row .meta{align-items:center}.row .age{margin-left:auto}
.why{display:inline-block;padding:0 7px;border-radius:9px;font-size:12px;font-weight:600;color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}
.prio-critical{color:var(--err);font-weight:600}.prio-high{color:var(--warn);font-weight:600}
.keys{margin-top:var(--s2);font-size:12px;color:var(--faint)}
kbd{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 4px;border:1px solid var(--line);border-bottom-width:2px;border-radius:3px;color:var(--muted);background:var(--panel)}
.ib-pane{position:sticky;top:calc(var(--top-h,90px) + var(--s4));max-height:calc(100vh - var(--top-h,90px) - var(--s4) * 2);overflow:auto;padding:var(--s4) var(--s5) var(--s5);scrollbar-width:thin;scrollbar-color:var(--bar) transparent;outline:none}
.ib-pane:focus-visible{box-shadow:0 0 0 2px var(--accent)}
.pane-head{display:grid;gap:var(--s2);padding-bottom:var(--s3);border-bottom:1px solid var(--line)}
h2.pane-title{font-size:17px;line-height:1.3;text-transform:none;letter-spacing:0;color:var(--text);margin:0;overflow-wrap:anywhere;text-wrap:balance}
.pane-title .faint{font-weight:400}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s1) var(--s3)}
.btn{display:inline-block;padding:3px 10px;border-radius:5px;border:1px solid color-mix(in srgb,var(--accent) 40%,var(--line));background:color-mix(in srgb,var(--accent) 8%,var(--panel));font-weight:500}
.btn:hover{text-decoration:none;background:color-mix(in srgb,var(--accent) 15%,var(--panel))}
.back{display:none;justify-self:start}
.part{margin-top:var(--s4)}.part>h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 var(--s2);font-weight:600;display:flex;gap:var(--s2);align-items:baseline}
.part>h3 span{text-transform:none;letter-spacing:0;font-weight:400;color:var(--faint)}
.part .banner{margin-bottom:var(--s2)}
.cmt{padding:var(--s3) 0;border-top:1px solid var(--line)}.cmt:first-of-type{border-top:0;padding-top:0}
.cmt-head{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;font-size:12px;margin-bottom:var(--s1)}.cmt-head b{font-size:13px}
.status{padding:var(--s3);border-radius:6px;background:color-mix(in srgb,var(--chip) 60%,transparent)}
.md{font-size:13.5px;line-height:1.55;overflow-wrap:anywhere;max-width:78ch}
.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md p,.md ul,.md ol,.md pre,.md blockquote,.md .md-table,.md details{margin:0 0 var(--s2)}
.md h3,.md h4,.md h5,.md h6{margin:var(--s4) 0 var(--s1);font-weight:600;line-height:1.3}.md h3{font-size:15px}.md h4{font-size:14px}.md h5,.md h6{font-size:13px}
.md ul,.md ol{padding-left:22px}.md li>p{margin:0}.md li+li{margin-top:2px}.md li>ul,.md li>ol{margin:2px 0 0}
.md li.task{list-style:none}.md li.task>input{margin:0 6px 0 -20px;vertical-align:-1px;accent-color:var(--ok)}.md li.task>p:first-of-type{display:inline}
.md code{font-size:12px;background:var(--chip);padding:1px 4px;border-radius:3px}
.md pre{background:var(--chip);padding:var(--s2) var(--s3);border-radius:4px;overflow:auto;scrollbar-width:thin}
.md pre code{background:none;padding:0;white-space:pre;overflow-wrap:normal}
.md blockquote{margin-left:0;padding-left:var(--s3);border-left:2px solid var(--bar);color:var(--muted)}
.md hr{border:0;border-top:1px solid var(--line);margin:var(--s3) 0}
.md .md-table{overflow-x:auto;scrollbar-width:thin}.md table{width:auto;overflow-wrap:normal}.md th,.md td{font-size:12px;padding:3px 12px 3px 0}
.md td:last-child{white-space:normal;min-width:18ch}
.md summary{cursor:pointer;color:var(--muted)}.md summary:hover{color:var(--text)}.md details[open]>summary{margin-bottom:var(--s1)}
.md summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
.calm{padding:var(--s5) 0;text-align:center}.calm p{margin:0}.calm p+p{margin-top:var(--s1)}.calm b{font-size:14px;font-weight:600}
.lane-label{font-weight:400;text-transform:none;letter-spacing:0;color:var(--faint);margin-left:6px}
.linkish{appearance:none;background:none;border:0;padding:0;font:inherit;color:var(--accent);cursor:pointer}.linkish:hover{text-decoration:underline}
.linkish:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
section{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:var(--s3) var(--s4);min-width:0}
section.attn{border-color:color-mix(in srgb,var(--warn) 45%,var(--line))}section.attn>h2 .n{color:var(--warn)}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 var(--s2);font-weight:600}
h2 .n{color:var(--faint);margin-left:4px}
.muted{color:var(--muted)}.faint{color:var(--faint)}.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}
.pill{display:inline-block;padding:0 7px;border-radius:9px;background:var(--chip);font-size:12px}
.pill.ok{background:color-mix(in srgb,var(--ok) 16%,transparent)}.pill.warn{background:color-mix(in srgb,var(--warn) 18%,transparent)}
.pill.err{background:color-mix(in srgb,var(--err) 16%,transparent)}.pill .faint{color:var(--muted)}
.banner{padding:var(--s2) var(--s3);border-radius:6px;border:1px solid var(--line);background:var(--panel)}
.banner.err{border-color:color-mix(in srgb,var(--err) 45%,var(--line))}.banner.warn{border-color:color-mix(in srgb,var(--warn) 45%,var(--line))}
.detail{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:var(--s4);align-items:start}
.stats{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);margin-top:var(--s3);padding-top:var(--s3);border-top:1px solid var(--line)}.stat b{font-size:16px;font-weight:600;margin-right:var(--s1)}
.steps{display:flex;flex-wrap:wrap;gap:var(--s1)}.steps+.err{margin-top:var(--s1)}
.cols{display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) minmax(0,1.35fr);gap:var(--s4)}
.col.prs{border-left:1px solid var(--line);padding-left:var(--s4)}
.col{min-width:0}.col ul{list-style:none;margin:0;padding:0}
.col>h2{padding-top:var(--s2);border-top:3px solid var(--line)}.col.prs>h2{border-top-color:transparent}
.col.l-intake>h2{border-top-color:var(--flow-1)}.col.l-task>h2{border-top-color:var(--flow-2)}.col.l-running>h2{border-top-color:var(--flow-3)}.col.l-promote>h2{border-top-color:var(--flow-4)}
.col li>a{color:var(--text)}.col li>a:hover{color:var(--accent);text-decoration:none}.col li>a:hover .t{text-decoration:underline}
.col li{padding:6px 0;border-top:1px solid var(--line)}.col li:first-child{border-top:0}
.t{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.col .t{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.meta{font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:2px 8px}
.empty{color:var(--faint);font-size:12px}
table{border-collapse:collapse;width:100%}th{text-align:left;font-weight:500;color:var(--muted);font-size:12px}
td,th{padding:4px 10px 4px 0;border-top:1px solid var(--line);vertical-align:top;white-space:nowrap}tr.logs td{border-top:0;padding-top:0;white-space:normal;overflow-wrap:anywhere}.scroll{overflow-x:auto}thead th{border-top:0}
.bar{display:inline-block;width:80px;height:6px;background:var(--bar);border-radius:3px;vertical-align:middle;overflow:hidden;margin-right:6px}
.bar i{display:block;height:100%;background:var(--ok)}.bar i.warn{background:var(--warn)}.bar i.err{background:var(--err)}
.events,.scroll{scrollbar-width:thin;scrollbar-color:var(--bar) transparent}
.events:focus-visible,.scroll:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
body.down #top,body.down main>:not(#down){opacity:.5;transition:opacity .3s ease-out}
.events{max-height:320px;overflow:auto}.events div{display:grid;grid-template-columns:62px 40px minmax(0,1fr);gap:8px;padding:2px 0}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--faint);margin-right:5px}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.err{background:var(--err)}
a.row-link{color:inherit}a.row-link:hover{text-decoration:none}tr.run:hover td{background:var(--chip)}
.trace-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--s1) var(--s3)}.trace-head .title{font-size:14px;font-weight:600}.trace-head .mono{overflow-wrap:anywhere}
.wf{margin-top:var(--s3)}
.wf-axis{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr) 64px;gap:var(--s3);font-size:12px;color:var(--faint);padding-bottom:2px}
.wf-axis .ticks{display:flex;justify-content:space-between}
.sp{appearance:none;background:none;border:0;border-top:1px solid var(--line);width:100%;display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr) 64px;gap:var(--s3);align-items:center;padding:3px 0;font:inherit;color:inherit;text-align:left;cursor:pointer}
.sp:hover{background:var(--chip)}.sp:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:3px}
.sp .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sp .nm .faint{margin-left:6px}
.sp .track{position:relative;height:12px;background:color-mix(in srgb,var(--bar) 35%,transparent);border-radius:2px}
.sp .track i{position:absolute;top:2px;height:8px;border-radius:2px;background:var(--fam,var(--muted));min-width:2px}
.f-cambium{--fam:var(--fam-cambium)}.f-claude{--fam:var(--fam-claude)}.f-mycelium{--fam:var(--fam-mycelium)}
.sp .track i.wait{background:repeating-linear-gradient(135deg,var(--bar) 0 3px,transparent 3px 6px);box-shadow:inset 0 0 0 1px var(--bar)}.sp .track i.err{background:var(--err)}
.legend{display:flex;flex-wrap:wrap;gap:2px var(--s3);margin-bottom:var(--s3);font-size:12px;color:var(--muted)}.legend span{display:inline-flex;align-items:center;gap:5px}
.legend i{width:10px;height:8px;border-radius:2px;background:var(--fam,var(--muted))}.legend i.wait{background:repeating-linear-gradient(135deg,var(--bar) 0 3px,transparent 3px 6px);box-shadow:inset 0 0 0 1px var(--bar)}.legend i.err{background:var(--err)}
.sp .d{text-align:right;color:var(--muted)}
.attrs{margin:0;padding:var(--s2) 0 var(--s3) var(--s4);display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px var(--s3);font-size:12px}
.attrs dt{color:var(--muted)}.attrs dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
@media (max-width:900px){.ib{grid-template-columns:minmax(0,1fr)}.ib.open>.ib-tools,.ib.open>.ib-side,.ib:not(.open)>.ib-pane{display:none}
.ib-pane{position:static;max-height:none;padding:var(--s3) var(--s4) var(--s4)}.back{display:inline-block}
.facets{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;padding:2px 0}.chip{flex:none}}
@media (max-width:1100px){.cols{grid-template-columns:repeat(4,minmax(0,1fr))}.detail{grid-template-columns:1fr}
.col.prs{grid-column:1/-1;border-left:0;padding-left:0;border-top:1px solid var(--line);padding-top:var(--s3)}}
@media (max-width:760px){.cols{grid-template-columns:repeat(2,minmax(0,1fr))}
.sp,.wf-axis{grid-template-columns:minmax(0,1fr) 56px}.sp .track,.wf-axis .ticks{grid-column:1/-1;order:3}.wf-axis>span:not(.ticks){display:none}}
@media (max-width:480px){main{padding:var(--s3) var(--s3) var(--s5);gap:var(--s3)}section{padding:var(--s3)}.cols{grid-template-columns:1fr}
.tabs{padding:0 var(--s3);gap:var(--s4)}}
`

const JS = `
${[inboxItems, priorityRank, facetsOf, viewOf, markdown].map(String).join('\n')}
const $ = (id) => document.getElementById(id)
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v)
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k))
  return el
}
const link = (url, text) => (/^https:\\/\\//.test(url || '') ? h('a', { href: url, target: '_blank', rel: 'noopener' }, text) : h('span', {}, text))
function dur(ms) {
  if (ms == null || !isFinite(ms)) return '–'
  if (Math.abs(ms) < 1000) return Math.round(Math.abs(ms)) + 'ms'
  const s = Math.round(Math.abs(ms) / 1000)
  if (s < 90) return s + 's'
  const m = Math.round(s / 60)
  if (m < 90) return m + 'm'
  const hr = Math.floor(m / 60)
  return hr < 48 ? hr + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') : Math.round(hr / 24) + 'd'
}
const ago = (iso, now) => (!iso ? '–' : now - Date.parse(iso) < 1000 ? 'just now' : dur(now - Date.parse(iso)) + ' ago')
const section = (title, n, ...kids) => h('section', {}, h('h2', {}, title, n == null ? null : h('span', { class: 'n' }, n)), ...kids)
const MODE = { running: 'ok', draining: 'warn', paused: 'warn' }
const CHECK = { SUCCESS: ['ok', 'checks pass'], FAILURE: ['err', 'checks fail'], ERROR: ['err', 'checks errored'], PENDING: ['warn', 'checks running'], EXPECTED: ['warn', 'checks expected'] }
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many)
let traceIdx = {}
const traceLink = (repo, issue) => {
  const id = repo && issue ? traceIdx[repo + '#' + issue] : null
  return id ? h('a', { href: '#traces/' + id, title: 'Open the newest trace for this issue' }, 'trace') : null
}

function header(s, now) {
  const hb = s.heartbeat, d = hb.data
  const kids = [h('h1', {}, 'canopy')]
  if (d) {
    kids.push(h('span', { class: 'pill ' + (MODE[d.mode] || '') }, d.mode))
    kids.push(h('span', { class: 'muted' }, d.host || '?', d.pid ? ' · pid ' + d.pid : ''))
    kids.push(h('span', { class: hb.stale ? 'warn' : 'muted' }, 'tick ', d.tick.n ?? '–', ' · ', ago(d.tick.finishedAt, now), d.tick.durationMs != null ? ' · took ' + dur(d.tick.durationMs) : ''))
    if (d.tick.nextAt && !hb.stale) {
      const left = Date.parse(d.tick.nextAt) - now
      kids.push(h('span', { class: 'faint' }, left > 0 ? 'next in ' + dur(left) : 'next tick due now'))
    }
  }
  const gh = s.github
  kids.push(h('span', { class: 'faint', style: 'margin-left:auto', title: s.cacheMs ? 'Each repo is re-read from GitHub at most every ' + dur(s.cacheMs) : null },
    gh.fetchedAt ? 'GitHub read ' + ago(gh.fetchedAt, now) : 'GitHub not read yet'))
  return h('header', {}, kids)
}

const HB_TITLE = { missing: 'No heartbeat yet', unreadable: "Can't read the heartbeat", 'unknown-version': 'Heartbeat version mismatch' }

function banners(s, now) {
  const out = []
  const hb = s.heartbeat
  if (hb.status !== 'ok') out.push(h('div', { class: 'banner err' }, h('b', {}, (HB_TITLE[hb.status] || 'Heartbeat ' + hb.status) + ': '), hb.message))
  else if (hb.stale) out.push(h('div', { class: 'banner warn' }, h('b', {}, 'cambium may have stopped: '), hb.message))
  for (const r of s.github.repos) if (!r.ok) out.push(h('div', { class: 'banner err' }, h('b', {}, 'GitHub read failed for ' + r.slug + ': '), r.error,
    r.fetchedAt ? '. Showing what it returned ' + ago(r.fetchedAt, now) + '.' : ". Its issues and PRs aren't shown."))
  for (const r of (hb.data && hb.data.repos) || []) if (!r.ok) out.push(h('div', { class: 'banner warn' }, h('b', {}, 'cambium could not read ' + r.slug + ': '), r.error || 'no reason given'))
  for (const n of s.notes || []) out.push(h('div', { class: 'banner' }, n))
  return out
}

function summary(d) {
  const c = d.counts, caps = d.caps
  const stat = (label, v, extra) => h('span', { class: 'stat' }, h('b', {}, v ?? '–'), h('span', { class: 'muted' }, label), extra ? h('span', { class: 'faint' }, ' ' + extra) : null)
  const live = d.workers.filter((w) => w.alive && w.phase === 'task').length
  const stats = h('div', { class: 'stats' },
    stat('intake', c.intake), stat('task', c.task), stat('running', c.running), stat('human', c.human),
    stat('promote', c.promote), stat('review', c.review), stat('workers', c.workers, caps.task != null ? '(' + live + ' of ' + caps.task + ' task slots in use' + (caps.dispatch ? ', dispatch cap ' + caps.dispatch : '') + ')' : null))
  const steps = h('div', { class: 'steps' }, d.steps.length ? d.steps.map((st) =>
    h('span', { class: 'pill ' + (st.ok ? 'ok' : 'err'), title: st.error || '' }, st.name, ' ', h('span', { class: 'faint' }, st.ms != null ? dur(st.ms) : ''))) : h('span', { class: 'empty' }, 'no steps recorded for this tick'))
  const errs = d.steps.filter((st) => !st.ok && st.error).map((st) => h('div', { class: 'err mono' }, st.name + ': ' + st.error))
  return section('Last tick', null, steps, errs, stats)
}

function item(i, multi, now) {
  return h('li', {},
    link(i.url, h('span', { class: 't', title: i.title }, h('span', { class: 'faint' }, '#' + i.number + ' '), i.title)),
    h('div', { class: 'meta' },
      multi ? h('span', {}, i.repo) : null,
      i.why ? h('span', { class: 'warn' }, 'why:' + i.why) : null,
      i.priority ? h('span', {}, 'priority:' + i.priority) : null,
      h('span', { class: 'faint' }, ago(i.updatedAt || i.createdAt, now)),
      traceLink(i.repo, i.number)))
}

function pr(p, multi, now) {
  const [cls, word] = CHECK[p.checks] || ['', 'no checks']
  return h('li', {},
    link(p.url, h('span', { class: 't', title: p.title }, h('span', { class: 'faint' }, '#' + p.number + ' '), p.title)),
    h('div', { class: 'meta' },
      h('span', {}, h('span', { class: 'dot ' + cls }), word),
      p.inMergeQueue ? h('span', { class: 'ok' }, 'in merge queue') : p.autoMerge ? h('span', {}, 'auto-merge') : null,
      p.draft ? h('span', { class: 'faint' }, 'draft') : null,
      p.closes.length ? h('span', {}, 'closes ' + p.closes.map((n) => '#' + n).join(' ')) : null,
      multi ? h('span', {}, p.repo) : null,
      h('span', { class: 'faint mono' }, p.branch)))
}

const isMulti = (gh) => new Set(gh.repos.map((r) => r.slug)).size > 1
const list = (xs, render, multi, now) => xs.length ? h('ul', {}, xs.map((x) => render(x, multi, now))) : h('div', { class: 'empty' }, 'empty')

const LANES = [['intake', 'Intake', 'q:intake'], ['task', 'Task', 'q:task'], ['running', 'Running', 'running'], ['promote', 'Promote', 'q:promote']]
const inFlight = (gh) => LANES.reduce((n, [k]) => n + gh.columns[k].length, 0)

const strandedOf = (gh) => gh.stranded || []
const needsYou = (gh) => gh.columns.human.length + strandedOf(gh).length

function inbox(s, now) {
  const gh = s.github, xs = gh.columns.human, st = strandedOf(gh), multi = isMulti(gh)
  const failed = gh.repos.filter((r) => !r.ok).map((r) => r.slug)
  const calm = (title, ...rest) => h('section', { class: 'calm' }, h('p', {}, h('b', {}, title)), h('p', { class: 'muted' }, ...rest))
  if (!xs.length && !st.length && !gh.repos.length) return [calm('No repositories to read.', "Pass --repo owner/name to canopy, or list repos in cambium's config.")]
  if (!xs.length && !st.length && failed.length) return [calm('The inbox may be incomplete.', 'GitHub read failed for ' + failed.join(', ') + '; see the error above.')]
  if (!xs.length && !st.length) return [calm('Nothing needs you.',
    plural(inFlight(gh), 'issue', 'issues') + ' queued · ' + plural(gh.prs.length, 'agent PR', 'agent PRs') + ' open · ',
    h('button', { class: 'linkish', type: 'button', 'data-go': 'queue' }, 'see the queue'))]
  return [inboxSplit(gh, multi, now)]
}

// Inbox reading pane. The list is the inbox model (inbox.mjs); the pane reads one issue through /api/issue,
// prefetching the rest of the list one at a time so moving through it rarely waits.
const store = {
  get(k, dflt) { try { const v = localStorage.getItem('canopy.' + k); return v == null ? dflt : JSON.parse(v) } catch { return dflt } },
  set(k, v) { try { localStorage.setItem('canopy.' + k, JSON.stringify(v)) } catch {} },
}
const SORTS = [['newest', 'Newest'], ['oldest', 'Oldest'], ['priority', 'Priority']]
let ibSort = SORTS.some(([k]) => k === store.get('inbox.sort')) ? store.get('inbox.sort') : 'newest'
let ibTags = new Set([].concat(store.get('inbox.tags', [])).filter((t) => typeof t === 'string'))
let ibSel = null, ibOpen = false, ibShown = []
const details = new Map()
const ibHash = (key) => '#inbox/' + key.replace('#', '/')
const DETAIL_FRESH_MS = 60000, DETAIL_RETRY_MS = 30000
const versionOf = (it) => it.updatedAt || it.at

function wantDetail(it) {
  const d = details.get(it.key)
  if (!d) return true
  if (d.loading) return false
  if (d.error && !d.data) return Date.now() - d.at > DETAIL_RETRY_MS
  return d.forV !== versionOf(it) || Date.now() - d.at > DETAIL_FRESH_MS
}

async function loadDetail(it, force) {
  if (!force && !wantDetail(it)) return
  const prev = details.get(it.key) || {}
  details.set(it.key, { ...prev, loading: true })
  if (force && last) render(last)
  const [repo, n] = it.key.split('#')
  let next
  try {
    const r = await fetch('/api/issue/' + repo + '/' + n, { cache: 'no-store' })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
    next = { data: j.issue, fetchedAt: j.fetchedAt, stale: j.error, error: null }
  } catch (err) {
    next = { data: prev.data || null, fetchedAt: prev.fetchedAt, stale: null, error: (err && err.message) || 'no answer' }
  }
  details.set(it.key, { ...next, loading: false, at: Date.now(), forV: versionOf(it) })
  if (last && tab === 'inbox') render(last)
}

let pumping = false
async function pump() {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const sel = ibShown.find((x) => x.key === ibSel)
      const next = tab === 'inbox' ? [sel, ...ibShown].find((it) => it && wantDetail(it)) : null
      if (!next) break
      await loadDetail(next)
    }
  } finally { pumping = false }
}

function select(key, how) {
  ibSel = key
  if (how && how.open) ibOpen = true
  history.replaceState(null, '', ibHash(key))
  if (last) render(last)
  if (how && how.focus) focusRow(key)
  if (how && how.open && how.focusPane) $('ib-pane')?.focus({ preventScroll: true })
  const it = ibShown.find((x) => x.key === key)
  if (it) loadDetail(it)
}
const focusRow = (key) => document.querySelector('[data-key="' + CSS.escape(key) + '"]')?.focus({ preventScroll: false })
function move(step, focus) {
  if (!ibShown.length) return
  const at = ibShown.findIndex((x) => x.key === ibSel)
  const i = at < 0 ? 0 : Math.max(0, Math.min(ibShown.length - 1, at + step))
  if (ibShown[i].key !== ibSel || focus) select(ibShown[i].key, { focus })
}
const selectedUrl = () => {
  const it = ibShown.find((x) => x.key === ibSel)
  return (it && it.url) || (details.get(ibSel) && details.get(ibSel).data && details.get(ibSel).data.url) || null
}

const PRIO = { critical: 'prio-critical', high: 'prio-high' }
const prio = (p) => (p ? h('span', { class: PRIO[p] || null }, 'priority:' + p) : null)
const whyOf = (it) => (it.kind === 'stranded' ? h('span', { class: 'why' }, 'PR closed') : it.why ? h('span', { class: 'why' }, 'why:' + it.why) : h('span', { class: 'faint' }, 'no why: label'))
const tagText = (t) => (t.id === 'kind:human' ? 'q:human' : t.id === 'kind:stranded' ? 'stranded' : t.id.startsWith('label:') || t.id.startsWith('repo:') ? t.value : t.id)
const TAG_TITLE = { 'kind:human': 'In the Human Queue (q:human)', 'kind:stranded': 'Agent PR closed unmerged; no queue label' }

function inboxSplit(gh, multi, now) {
  const all = inboxItems(gh)
  const shown = viewOf(all, { sort: ibSort, tags: ibTags })
  ibShown = shown
  // Keep the selection while it is in the list; an issue that has left the inbox stays open (marked as gone)
  // if it was already read, rather than jumping away while someone is reading it.
  let sel = shown.find((x) => x.key === ibSel) || null, gone = null
  if (!sel && ibSel && !all.some((x) => x.key === ibSel) && details.get(ibSel) && details.get(ibSel).data) gone = details.get(ibSel).data
  if (!sel && !gone) {
    sel = shown[0] || null
    ibSel = sel ? sel.key : null
    if (tab === 'inbox') history.replaceState(null, '', ibSel ? ibHash(ibSel) : '#inbox')
  }

  const tools = h('div', { class: 'ib-tools' },
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Sort the inbox' },
      SORTS.map(([k, label]) => h('button', { type: 'button', 'data-sort': k, 'data-fk': 'sort:' + k, 'aria-pressed': String(ibSort === k) }, label))),
    h('div', { class: 'facets', role: 'group', 'aria-label': 'Filter by tag' },
      facetsOf(all, ibTags).map((f) => h('span', { class: 'facet' }, f.tags.map((t) =>
        h('button', { type: 'button', class: 'chip', 'data-tag': t.id, 'data-fk': 'tag:' + t.id, 'aria-pressed': String(t.on), title: TAG_TITLE[t.id] || null },
          tagText(t), h('span', { class: 'n' }, t.n)))))),
    h('span', { class: 'ib-count faint', 'aria-live': 'polite' }, ibTags.size
      ? [shown.length + ' of ' + all.length + ' shown · ', h('button', { class: 'linkish', type: 'button', 'data-clear': '', 'data-fk': 'clear' }, 'Clear filters')]
      : plural(all.length, 'item', 'items')))

  const focusable = sel ? sel.key : shown[0] && shown[0].key
  const rows = shown.map((it) => h('li', { class: 'row', role: 'option', 'data-key': it.key, 'data-fk': 'row:' + it.key,
      'aria-selected': String(it.key === ibSel), tabindex: it.key === focusable ? 0 : -1 },
    h('span', { class: 'row-t', title: it.title }, h('span', { class: 'faint' }, '#' + it.number + ' '), it.title),
    h('span', { class: 'meta' }, whyOf(it), prio(it.priority), multi ? h('span', {}, it.repo.split('/')[1]) : null,
      h('span', { class: 'faint age', title: it.at || '' }, ago(it.at, now)))))
  const side = h('div', { class: 'ib-side' },
    h('section', { class: 'ib-list attn' }, rows.length
      ? h('ul', { role: 'listbox', 'aria-label': 'Inbox' }, rows)
      : h('div', { class: 'calm' }, h('p', {}, h('b', {}, 'Nothing matches these tags.')),
          h('p', {}, h('button', { class: 'linkish', type: 'button', 'data-clear': '', 'data-fk': 'clear-empty' }, 'Clear filters')))),
    rows.length ? h('div', { class: 'keys' }, h('kbd', {}, 'j'), ' ', h('kbd', {}, 'k'), ' move · ', h('kbd', {}, 'o'), ' open on GitHub') : null)

  const d = sel || gone ? details.get(sel ? sel.key : ibSel) : null
  const sig = JSON.stringify([ibSel, sel, gone && gone.updatedAt, traceIdx[ibSel], ago(sel && sel.at, now),
    d && [d.loading && !d.data, d.error, d.stale, d.data,
      d.data && [ago(d.data.createdAt, now), d.data.status && ago(d.data.status.updatedAt, now), d.data.comments.map((c) => ago(c.createdAt, now))]]])
  const old = $('ib-pane')
  const pane = sel || gone ? (old && old.dataset.sig === sig ? null : issuePane(sel, gone, d, multi, now, sig)) : h('section', { class: 'ib-pane calm', id: 'ib-pane' }, h('p', { class: 'muted' }, 'Pick an item to read it here.'))
  return { ib: h('div', { class: 'ib' + (ibOpen ? ' open' : ''), id: 'ib' }, tools, side, pane), tools, side, pane }
}

function issuePane(sel, gone, d, multi, now, sig) {
  const base = sel || gone, repo = base.repo, data = d && d.data
  const url = (sel && sel.url) || gone.url
  const md = (src) => h('div', { class: 'md' }, markdown(src, h, { repo }))
  const comment = (c, extra) => h('article', { class: 'cmt' },
    h('div', { class: 'cmt-head' }, h('b', {}, c.author || 'ghost'), link(c.url, h('span', { title: c.createdAt || '' }, ago(c.createdAt, now))), extra), md(c.body))
  const edited = (c) => (c.updatedAt && c.updatedAt !== c.createdAt ? h('span', { class: 'faint', title: c.updatedAt }, 'edited ' + ago(c.updatedAt, now)) : null)

  const head = h('div', { class: 'pane-head' },
    h('button', { class: 'linkish back', type: 'button', 'data-back': '', 'data-fk': 'back' }, 'Back to the inbox'),
    h('h2', { class: 'pane-title', id: 'pane-title' }, h('span', { class: 'faint' }, '#' + base.number + ' '), base.title),
    h('div', { class: 'meta' },
      sel ? whyOf(sel) : h('span', { class: 'why' }, 'left the inbox'), prio(sel ? sel.priority : null),
      multi ? h('span', {}, repo) : null,
      data && data.author ? h('span', {}, 'opened by ', h('b', {}, data.author), ' ', h('span', { class: 'faint', title: data.createdAt || '' }, ago(data.createdAt, now))) : null,
      sel ? h('span', { class: 'faint', title: sel.at || '' }, (sel.kind === 'stranded' ? 'PR closed ' : 'updated ') + ago(sel.at, now)) : null),
    h('div', { class: 'actions' },
      /^https:\\/\\//.test(url || '') ? h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, 'Open on GitHub') : null,
      sel && sel.pr ? h('span', { class: 'muted' }, 'closed PR ', link(sel.pr.url, '#' + sel.pr.number), ' ', h('span', { class: 'faint mono' }, sel.pr.branch)) : null,
      traceLink(repo, base.number)))

  const parts = []
  if (gone) parts.push(h('div', { class: 'banner warn part' }, h('b', {}, 'No longer in the inbox. '), "It has left q:human (or is no longer stranded). Showing it as last read; it won't refresh here."))
  if (sel && sel.kind === 'stranded') parts.push(h('div', { class: 'banner warn part' }, h('b', {}, 'Stranded: '),
    'agent PR #' + sel.pr.number + ' closed unmerged ' + ago(sel.pr.closedAt, now) + ' and no open agent PR replaces it. With no queue label, cambium will not pick this issue up again. Add a queue label to send it back, or close it.'))
  if (d && d.error) parts.push(h('div', { class: 'banner err part' }, h('b', {}, data ? "Couldn't refresh this issue: " : "Couldn't read this issue from GitHub: "), d.error,
    data ? '. Showing what canopy read ' + ago(d.fetchedAt, now) + '. ' : '. ', h('button', { class: 'linkish', type: 'button', 'data-retry': '', 'data-fk': 'retry' }, 'Try again')))
  else if (d && d.stale) parts.push(h('div', { class: 'banner warn part' }, h('b', {}, 'GitHub refresh failed: '), d.stale, '. Showing what it returned ' + ago(d.fetchedAt, now) + '.'))
  if (!data) {
    if (!d || d.loading || !d.error) parts.push(h('p', { class: 'faint part' }, 'Reading #' + base.number + ' from GitHub…'))
  } else {
    if (data.status) parts.push(h('div', { class: 'part' }, h('h3', {}, 'cambium status', edited(data.status) || h('span', { title: data.status.createdAt || '' }, ago(data.status.createdAt, now))),
      h('div', { class: 'status' }, md(data.status.body))))
    parts.push(h('div', { class: 'part' }, h('h3', {}, 'Description'), data.body.trim() ? md(data.body) : h('p', { class: 'faint' }, 'No description.')))
    const n = data.comments.length
    parts.push(h('div', { class: 'part' }, h('h3', {}, 'Comments', h('span', {}, n ? (data.earlier ? 'latest ' + n + ' of ' + (n + data.earlier) : String(n)) : 'none')),
      data.earlier ? h('p', { class: 'faint' }, link(url, plural(data.earlier, 'earlier comment', 'earlier comments') + ' on GitHub')) : null,
      data.comments.map((c) => comment(c, edited(c)))))
  }
  return h('section', { class: 'ib-pane', id: 'ib-pane', tabindex: -1, 'aria-labelledby': 'pane-title', 'data-sig': sig, 'data-key': base.repo + '#' + base.number }, head, parts)
}

function queues(s, now) {
  const gh = s.github, multi = isMulti(gh)
  const col = (title, label, xs, render, cls) => h('div', { class: 'col' + (cls ? ' ' + cls : '') },
    h('h2', {}, title, h('span', { class: 'n' }, xs.length), label ? h('span', { class: 'lane-label mono' }, label) : null), list(xs, render, multi, now))
  return h('section', {}, h('div', { class: 'cols' },
    LANES.map(([k, title, label]) => col(title, label, gh.columns[k], item, 'l-' + k)), col('Agent PRs', 'agent/*', gh.prs, pr, 'prs')))
}

function healthOf(s) {
  const hb = s.heartbeat, d = hb.data
  if (hb.status !== 'ok' || !d) return ['err', 'no readable heartbeat']
  const failedSteps = d.steps.filter((st) => !st.ok).map((st) => st.name)
  if (failedSteps.length) return ['err', failedSteps.join(', ') + ' failed in the last tick']
  if (d.workers.some((w) => w.killedReason)) return ['err', 'a worker was killed']
  if (hb.stale) return ['warn', 'no recent tick']
  if (d.mode !== 'running') return ['warn', 'cambium is ' + d.mode]
  return ['ok', 'healthy']
}

function workers(d, ageMs) {
  if (!d.workers.length) return section('Workers', 0, h('div', { class: 'empty' }, 'no workers on this host'))
  const rows = d.workers.map((w) => {
    const elapsed = (w.elapsedMs || 0) + (w.alive && ageMs ? ageMs : 0)
    const frac = w.wallClockMs ? Math.min(1, elapsed / w.wallClockMs) : 0
    const tone = frac >= 1 ? 'err' : frac > 0.8 ? 'warn' : ''
    const issueUrl = w.repo && w.issue ? 'https://github.com/' + w.repo + '/issues/' + w.issue : null
    const logs = [w.logs.stdout, w.logs.stderr].filter(Boolean)
    return [h('tr', {},
      h('td', {}, link(issueUrl, (w.repo || '') + '#' + (w.issue ?? '?')), traceLink(w.repo, w.issue) ? [' · ', traceLink(w.repo, w.issue)] : null),
      h('td', {}, w.phase || '–'), h('td', {}, w.attempt ?? '–'),
      h('td', {}, h('span', { class: 'dot ' + (w.alive ? 'ok' : 'err') }), w.pid ?? '–', w.killedReason ? h('span', { class: 'err' }, ' killed: ' + w.killedReason) : null),
      h('td', {}, h('span', { class: 'bar' }, h('i', { class: tone, style: 'width:' + Math.round(frac * 100) + '%' })), dur(elapsed), h('span', { class: 'faint' }, ' / ' + dur(w.wallClockMs))),
      h('td', { class: 'mono' }, w.branch || '–')),
      logs.length ? h('tr', { class: 'logs' }, h('td', { colspan: 6, class: 'mono faint' }, logs.map((l) => h('div', {}, l)))) : null]
  })
  return section('Workers', d.workers.length, h('div', { class: 'scroll', tabindex: 0, 'aria-label': 'Workers table' }, h('table', {},
    h('thead', {}, h('tr', {}, ['issue', 'phase', 'attempt', 'pid', 'elapsed / cap', 'branch'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows))))
}

function events(d) {
  const list = d.events.slice(-60).reverse()
  return section('Recent events', d.events.length, list.length ? h('div', { class: 'events mono', tabindex: 0, 'aria-label': 'Recent events' }, list.map((e) => {
    const t = e.at ? new Date(e.at) : null
    return h('div', {}, h('span', { class: 'faint', title: e.at || '' }, t ? t.toLocaleTimeString([], { hour12: false }) : '–'),
      h('span', { class: e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : 'faint' }, e.level || ''),
      h('span', {}, e.repo && e.issue ? h('span', { class: 'faint' }, e.repo.split('/')[1] + '#' + e.issue + ' ') : null, e.msg || ''))
  })) : h('div', { class: 'empty' }, 'no events recorded yet'))
}

const usd = (n) => (n == null ? '–' : '$' + (n < 10 ? n.toFixed(2) : Math.round(n)))
const runName = (t) => (t.repo && t.issue ? t.repo.split('/')[1] + '#' + t.issue : t.root)
const runUrl = (t) => (t.repo && t.issue ? 'https://github.com/' + t.repo + '/issues/' + t.issue : null)
const OUTCOME = { ok: 'ok', merged: 'ok', error: 'err', failed: 'err', stalled: 'warn', budgetSpent: 'warn' }
const calmBox = (title, ...rest) => h('section', { class: 'calm' }, h('p', {}, h('b', {}, title)), h('p', { class: 'muted' }, ...rest))

function traceFileNote(f) {
  const bits = []
  if (f.malformed) bits.push(plural(f.malformed, 'line', 'lines') + " couldn't be parsed and were skipped")
  if (f.files > 1) bits.push('read from ' + f.files + ' files (the current one and its rotated backups)')
  return bits.length ? h('div', { class: 'faint', style: 'margin-top:var(--s2)' }, 'Spans ' + bits.join('; ') + '.') : null
}

function runsView(f, now) {
  if (f.status !== 'ok') return calmBox(f.status === 'missing' ? 'No traces yet.' : "Can't read the trace file.", f.message)
  if (!f.traces.length) return calmBox('No workflow runs traced yet.', h('code', {}, f.path), ' has no spans. Runs appear once cambium moves an issue through a graph with tracing on.')
  const rows = f.traces.map((t) => {
    const open = (kid) => h('a', { class: 'row-link', href: '#traces/' + t.id }, kid)
    return h('tr', { class: 'run' },
      h('td', {}, open([h('span', { class: 'dot ' + (t.errors ? 'err' : 'ok') }), runName(t)])),
      h('td', {}, t.graph || h('span', { class: 'faint' }, t.services.join(', ') || '–')),
      h('td', { class: 'mono' }, t.node || '–'),
      h('td', {}, t.outcome ? h('span', { class: 'pill ' + (OUTCOME[t.outcome] || '') }, t.outcome) : '–'),
      h('td', { title: new Date(t.start).toISOString() }, ago(new Date(t.start).toISOString(), now)),
      h('td', {}, dur(t.durationMs)),
      h('td', {}, t.spans, t.errors ? h('span', { class: 'err' }, ' · ' + t.errors + ' failed') : null),
      h('td', {}, usd(t.costUsd)))
  })
  return h('section', {}, h('h2', {}, 'Workflow runs', h('span', { class: 'n' }, f.total > f.traces.length ? f.traces.length + ' of ' + f.total : f.total)),
    h('div', { class: 'scroll', tabindex: 0, 'aria-label': 'Workflow runs' }, h('table', {},
      h('thead', {}, h('tr', {}, ['run', 'graph', 'last node', 'outcome', 'started', 'took', 'spans', 'cost'].map((x) => h('th', {}, x)))),
      h('tbody', {}, rows))),
    traceFileNote(f))
}

function spanDetail(sp) {
  const a = sp.attrs
  if (a['cambium.node']) return [a['cambium.node'], a['cambium.edge'] ? '→ ' + a['cambium.edge'] : null, a['cambium.attempt'] != null ? 'attempt ' + a['cambium.attempt'] : null]
  if (a['claude.tool.name']) return [a['claude.tool.name'], a['claude.tool.command']]
  if (a['claude.task.description']) return [a['claude.task.description']]
  if (a['claude.thinking'] || a['claude.text']) return [a['claude.turn.tools'] || null, preview(a['claude.thinking'] || a['claude.text'])]
  if (a['claude.model']) return [a['claude.model'], a['claude.cost_usd'] != null ? usd(a['claude.cost_usd']) : null]
  if (a['mycelium.source']) return [a['mycelium.source'], a['mycelium.action']]
  if (a['cambium.graph']) return [a['cambium.graph']]
  return []
}
const preview = (v) => { const t = String(v).replace(/\\s+/g, ' ').trim(); return t.length > 120 ? t.slice(0, 119) + '…' : t }
const showValue = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
let openSpans = new Set()
// Bars are colored by the span name's prefix: which part of the stack did this work.
const FAMILIES = ['cambium', 'claude', 'mycelium']
const familyOf = (name) => { const f = String(name).split('.')[0]; return FAMILIES.includes(f) ? f : null }
function legend(spans) {
  const fams = FAMILIES.filter((f) => spans.some((sp) => familyOf(sp.name) === f))
  const key = (cls, label) => h('span', {}, h('i', { class: cls }), label)
  return h('div', { class: 'legend', 'aria-hidden': 'true' }, fams.map((f) => key('f-' + f, f + '.*')),
    spans.some((sp) => familyOf(sp.name) === null) ? key('', 'other') : null,
    spans.some((sp) => sp.name === 'cambium.wait') ? key('wait', 'waiting') : null,
    spans.some((sp) => sp.status === 'error') ? key('err', 'failed') : null)
}

function traceView(d) {
  const t = d.summary, span = Math.max(1, t.end - t.start)
  const head = h('div', { class: 'trace-head' },
    h('a', { href: '#traces' }, '← all runs'),
    h('span', { class: 'title' }, link(runUrl(t), runName(t))),
    t.graph ? h('span', { class: 'pill' }, t.graph) : null,
    t.node ? h('span', { class: 'muted' }, 'last at ', h('span', { class: 'mono' }, t.node), t.outcome ? ' · ' + t.outcome : '') : null,
    h('span', { class: t.errors ? 'err' : 'faint' }, plural(t.spans, 'span', 'spans'), t.errors ? ' · ' + t.errors + ' failed' : ''),
    h('span', { class: 'faint', title: new Date(t.start).toISOString() }, 'started ', new Date(t.start).toLocaleString(), ' · took ', dur(t.durationMs)),
    t.costUsd != null ? h('span', { class: 'faint' }, usd(t.costUsd)) : null,
    h('span', { class: 'faint mono', style: 'margin-left:auto' }, t.id))
  const axis = h('div', { class: 'wf-axis', 'aria-hidden': 'true' }, h('span', {}, 'span'),
    h('span', { class: 'ticks' }, [0, 0.25, 0.5, 0.75, 1].map((f) => h('span', {}, f ? '+' + dur(span * f) : '0'))), h('span', { style: 'text-align:right' }, 'took'))
  const rows = d.spans.map((sp) => {
    const left = ((sp.start - t.start) / span) * 100, width = ((sp.end - sp.start) / span) * 100
    const open = openSpans.has(sp.spanId)
    const detail = spanDetail(sp).filter((x) => x != null && x !== '')
    const fam = familyOf(sp.name)
    const bar = [fam ? 'f-' + fam : '', sp.name === 'cambium.wait' ? 'wait' : '', sp.status === 'error' ? 'err' : ''].join(' ').trim()
    const row = h('button', { type: 'button', class: 'sp', 'data-span': sp.spanId, 'aria-expanded': String(open),
        title: sp.name + ' · at +' + dur(sp.start - t.start) + ' · took ' + dur(sp.end - sp.start) },
      h('span', { class: 'nm', style: 'padding-left:' + sp.depth * 14 + 'px' },
        sp.status === 'error' ? h('span', { class: 'dot err' }) : null, sp.name, detail.length ? h('span', { class: 'faint' }, detail.join(' · ')) : null),
      h('span', { class: 'track' }, h('i', { class: bar || null, style: 'left:' + left.toFixed(3) + '%;width:' + width.toFixed(3) + '%' })),
      h('span', { class: 'd' }, dur(sp.end - sp.start)))
    if (!open) return row
    const kv = [['service', sp.service], ['status', sp.status + (sp.statusMessage ? ': ' + sp.statusMessage : '')],
      ['started', new Date(sp.start).toISOString()], ['span id', sp.spanId], ...Object.entries(sp.attrs)].filter(([, v]) => v != null)
    for (const e of sp.events) kv.push(['event · ' + e.name, (isFinite(e.at) ? '+' + dur(e.at - sp.start) + ' ' : '') + Object.entries(e.attrs).map(([k, v]) => k + '=' + showValue(v)).join(' ')])
    return [row, h('dl', { class: 'attrs mono' }, kv.map(([k, v]) => [h('dt', {}, k), h('dd', {}, showValue(v))]))]
  })
  return h('section', {}, head, h('div', { class: 'wf' }, legend(d.spans), axis, rows), traceFileNote(d))
}

function tracesTab(now) {
  if (!traceState || traceState.key !== traceKey()) return section('Traces', null, h('div', { class: 'empty' }, 'reading traces…'))
  if (traceState.error) return h('div', { class: 'banner err' }, h('b', {}, traceSel ? "Can't load this trace: " : "Can't load traces: "), traceState.error,
    traceSel ? [' · ', h('a', { href: '#traces' }, 'all runs')] : null)
  return traceSel ? traceView(traceState.data) : runsView(traceState.data, now)
}

const TABS = ['inbox', 'queue', 'traces', 'health']
// #inbox/<owner>/<name>/<n> selects an inbox item; #traces/<id> opens a trace.
const parseHash = () => {
  const [t, id, name, n] = location.hash.slice(1).split('/')
  if (!TABS.includes(t)) return ['inbox', null, null]
  return [t, t === 'traces' && /^[0-9a-f]{32}$/.test(id || '') ? id : null, t === 'inbox' && name && /^[1-9][0-9]*$/.test(n || '') ? id + '/' + name + '#' + n : null]
}
let [tab, traceSel, hashSel] = parseHash(), last = null, traceState = null
if (hashSel) { ibSel = hashSel; ibOpen = true }
const traceKey = () => (traceSel ? '/api/traces/' + traceSel : '/api/traces')
async function loadTraces() {
  if (tab !== 'traces') return
  const key = traceKey()
  try {
    const r = await fetch(key, { cache: 'no-store' })
    const j = await r.json()
    traceState = { key, data: r.ok ? j : null, error: r.ok ? null : j.error || 'HTTP ' + r.status }
  } catch (err) {
    traceState = { key, data: null, error: (err && err.message) || 'no answer' }
  }
}

// The browser tab carries health too, by color and shape: a disc when healthy, a triangle on a warning,
// a square on a failure, a hollow ring when the canopy server is unreachable.
const ICON = {
  ok: ['#2f9a5c', (g) => g.arc(16, 16, 13, 0, 2 * Math.PI)],
  warn: ['#d08a1c', (g) => { g.moveTo(16, 3); g.lineTo(30, 29); g.lineTo(2, 29); g.closePath() }],
  err: ['#d64040', (g) => g.roundRect(3, 3, 26, 26, 4)],
  down: ['#8a8f8a', (g) => g.arc(16, 16, 11, 0, 2 * Math.PI)],
}
let iconTone = null
function setIcon(tone) {
  if (tone === iconTone || !ICON[tone]) return
  const cv = Object.assign(document.createElement('canvas'), { width: 32, height: 32 }), g = cv.getContext('2d')
  if (!g) return
  iconTone = tone
  const [c, shape] = ICON[tone]
  g.beginPath()
  shape(g)
  if (tone === 'down') Object.assign(g, { strokeStyle: c, lineWidth: 5 }).stroke()
  else Object.assign(g, { fillStyle: c }).fill()
  let el = document.querySelector('link[rel=icon]')
  if (!el) document.head.append((el = Object.assign(document.createElement('link'), { rel: 'icon' })))
  el.href = cv.toDataURL('image/png')
}

function tabs(s) {
  const human = needsYou(s.github), queued = inFlight(s.github), [tone, why] = healthOf(s)
  document.body.dataset.health = tone
  setIcon(tone)
  $('n-inbox').textContent = human
  $('n-inbox').className = 'count' + (human ? ' attn' : '')
  $('tab-inbox').setAttribute('aria-label', 'Inbox: ' + plural(human, 'issue needs', 'issues need') + ' you')
  $('n-queue').textContent = queued
  $('tab-queue').setAttribute('aria-label', 'Queue: ' + plural(queued, 'issue', 'issues') + ' queued')
  $('d-health').className = 'dot ' + tone
  $('d-health').title = why
  $('tab-health').setAttribute('aria-label', 'Health: ' + why)
  const tr = s.traces, traced = tr && tr.status === 'ok'
  const tWhy = traced ? plural(tr.total, 'run', 'runs') + ' traced' + (tr.errored ? ', ' + tr.errored + ' with a failed span' : '') : (tr && tr.message) || 'tracing is off'
  $('n-traces').textContent = traced ? tr.total : '–'
  $('n-traces').className = 'count' + (traced && tr.errored ? ' attn' : '')
  $('tab-traces').title = tWhy
  $('tab-traces').setAttribute('aria-label', 'Traces: ' + tWhy)
  for (const t of TABS) {
    const b = $('tab-' + t), on = t === tab
    b.setAttribute('aria-selected', on)
    b.tabIndex = on ? 0 : -1
  }
  $('main').setAttribute('aria-labelledby', 'tab-' + tab)
}

async function go(t, focus) {
  if (!TABS.includes(t)) return
  tab = t
  traceSel = null
  history.replaceState(null, '', t === 'inbox' && ibSel ? ibHash(ibSel) : '#' + t)
  window.scrollTo(0, 0)
  if (last) render(last)
  if (focus) $('tab-' + t).focus()
  if (t === 'traces') {
    await loadTraces()
    if (last) render(last)
  }
}

$('tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab) })
$('tabs').addEventListener('keydown', (e) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
  if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); return go(e.key === 'Home' ? TABS[0] : TABS[TABS.length - 1], true) }
  if (!step) return
  e.preventDefault()
  go(TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length], true)
})
$('main').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]')
  if (b) return go(b.dataset.go, true)
  const ctl = e.target.closest('[data-sort],[data-tag],[data-clear],[data-key],[data-back],[data-retry]')
  if (ctl) {
    const ds = ctl.dataset
    if (ds.key) return select(ds.key, { open: true, focus: true })
    if (ds.back != null) { ibOpen = false; if (last) render(last); return ibSel && focusRow(ibSel) }
    if (ds.retry != null) { const it = ibShown.find((x) => x.key === ibSel); return it && loadDetail(it, true) }
    if (ds.sort) ibSort = ds.sort
    else if (ds.tag) ibTags.has(ds.tag) ? ibTags.delete(ds.tag) : ibTags.add(ds.tag)
    else ibTags.clear()
    store.set('inbox.sort', ibSort)
    store.set('inbox.tags', [...ibTags])
    if (last) render(last)
    if (ds.clear != null) document.querySelector('.seg [aria-pressed=true]')?.focus()
    return pump()
  }
  const sp = e.target.closest('[data-span]')
  if (!sp) return
  const id = sp.dataset.span
  if (openSpans.has(id)) openSpans.delete(id)
  else openSpans.add(id)
  if (last) render(last)
  document.querySelector('[data-span="' + id + '"]')?.focus({ preventScroll: true })
})
// Inbox keys: j/k (and arrows in the list) move, Enter reads, o opens on GitHub, Escape goes back on narrow screens.
document.addEventListener('keydown', (e) => {
  if (tab !== 'inbox' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
  const t = e.target
  if (t.closest && t.closest('input,textarea,select,[contenteditable],#tabs')) return
  const inList = !!(t.closest && t.closest('[role=listbox]'))
  const step = { j: 1, k: -1 }[e.key] || (inList ? { ArrowDown: 1, ArrowUp: -1 }[e.key] : 0)
  if (step) { e.preventDefault(); return move(step, inList) }
  if (inList && (e.key === 'Home' || e.key === 'End')) {
    e.preventDefault()
    const it = e.key === 'Home' ? ibShown[0] : ibShown[ibShown.length - 1]
    return it && select(it.key, { focus: true })
  }
  if (inList && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); return ibSel && select(ibSel, { open: true, focusPane: true }) }
  if (e.key === 'o' && !t.closest('a,button')) { const u = selectedUrl(); if (/^https:/.test(u || '')) { e.preventDefault(); window.open(u, '_blank', 'noopener') } return }
  if (e.key === 'Escape' && ibOpen && matchMedia('(max-width:900px)').matches) { ibOpen = false; if (last) render(last); if (ibSel) focusRow(ibSel) }
})
addEventListener('hashchange', async () => {
  const before = traceSel
  let sel
  ;[tab, traceSel, sel] = parseHash()
  if (sel) { ibSel = sel; ibOpen = true }
  if (traceSel !== before) { openSpans = new Set(); window.scrollTo(0, 0) }
  if (last) render(last)
  await loadTraces()
  if (last) render(last)
})

function render(s) {
  last = s
  traceIdx = (s.traces && s.traces.byIssue) || {}
  const now = Date.parse(s.now) || Date.now()
  const d = s.heartbeat.data
  const body = [...banners(s, now)]
  let split = null
  if (tab === 'inbox') for (const x of inbox(s, now)) if (x instanceof Node) body.push(x); else body.push((split = x).ib)
  if (tab === 'queue') body.push(queues(s, now))
  if (tab === 'traces') body.push(tracesTab(now))
  if (tab === 'health') {
    if (d) body.push(summary(d), h('div', { class: 'detail' }, workers(d, s.heartbeat.ageMs), events(d)))
    else body.push(section('Health', null, h('div', { class: 'empty' }, 'Ticks, workers and events appear once cambium writes a readable heartbeat; see the message above.')))
  }
  tabs(s)
  const focused = document.activeElement, href = focused && focused.getAttribute && focused.getAttribute('href')
  const fk = focused && focused.dataset && focused.dataset.fk
  const scrolled = [...document.querySelectorAll('.events,.scroll')].map((el) => [el.className, el.scrollTop, el.scrollLeft])
  $('head').replaceChildren(header(s, now))
  const ib = $('ib'), oldPane = $('ib-pane')
  const paneWas = oldPane && { key: oldPane.dataset.key, top: oldPane.scrollTop, open: [...oldPane.querySelectorAll('details')].map((x) => x.open) }
  if (split && !split.pane && ib && $('ib-pane')) {
    // The pane hasn't changed: patch around it so a selection, scroll position or open <details> in it survive the poll.
    ib.className = split.ib.className
    ib.querySelector(':scope > .ib-tools').replaceWith(split.tools)
    ib.querySelector(':scope > .ib-side').replaceWith(split.side)
    for (const c of [...$('main').children]) if (c !== ib) c.remove()
    ib.before(...body.filter((x) => x !== split.ib))
  } else {
    $('main').replaceChildren(...body)
    const p = $('ib-pane')
    if (p && paneWas && p.dataset.key === paneWas.key) {
      p.querySelectorAll('details').forEach((x, i) => { if (paneWas.open[i]) x.open = true })
      p.scrollTop = paneWas.top
    }
  }
  document.documentElement.style.setProperty('--top-h', $('top').offsetHeight + 'px')
  document.body.classList.remove('down')
  for (const [cls, top, left] of scrolled) {
    const el = document.getElementsByClassName(cls)[0]
    if (el) Object.assign(el, { scrollTop: top, scrollLeft: left })
  }
  if (fk) document.querySelector('[data-fk="' + CSS.escape(fk) + '"]')?.focus({ preventScroll: true })
  else if (href) [...document.querySelectorAll('a')].find((a) => a.getAttribute('href') === href)?.focus({ preventScroll: true })
  else if (focused && focused.classList && (focused.classList.contains('events') || focused.classList.contains('scroll'))) document.getElementsByClassName(focused.className)[0]?.focus({ preventScroll: true })
  if (tab === 'inbox') pump()
  const human = needsYou(s.github)
  document.title = (human ? '(' + human + ') ' : '') + 'canopy' + (d ? ' · ' + d.mode : '') + (s.heartbeat.stale ? ' · stale' : '')
}

let pollMs = 5000
async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' })
    const s = await r.json()
    if (!r.ok) throw new Error(s.error || r.status)
    pollMs = s.pollMs || pollMs
    await loadTraces()
    render(s)
  } catch (err) {
    $('down')?.remove()
    document.body.classList.add('down')
    setIcon('down')
    document.title = 'canopy · unreachable'
    $('main').prepend(h('div', { id: 'down', class: 'banner err' }, h('b', {}, "Can't reach the canopy server: "), (err && err.message) || 'no answer',
      '. Showing the last data it sent; retrying every ' + dur(pollMs) + '. Is canopy still running?'))
  }
  setTimeout(poll, pollMs)
}
poll()
`

/** The whole page: inline CSS and JS, no external requests, no build step. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>canopy</title>
<style>${CSS}</style>
</head>
<body>
<div id="top"><div id="head"><header><h1>canopy</h1><span class="faint">reading cambium and GitHub…</span></header></div>
<nav class="tabs" id="tabs" role="tablist" aria-label="Views">
<button class="tab" role="tab" type="button" id="tab-inbox" data-tab="inbox" aria-controls="main">Inbox <span class="count" id="n-inbox">–</span></button>
<button class="tab" role="tab" type="button" id="tab-queue" data-tab="queue" aria-controls="main" tabindex="-1">Queue <span class="count" id="n-queue">–</span></button>
<button class="tab" role="tab" type="button" id="tab-traces" data-tab="traces" aria-controls="main" tabindex="-1">Traces <span class="count" id="n-traces">–</span></button>
<button class="tab" role="tab" type="button" id="tab-health" data-tab="health" aria-controls="main" tabindex="-1">Health <span class="dot" id="d-health"></span></button>
</nav></div>
<main id="main" role="tabpanel" aria-labelledby="tab-inbox"></main>
<script>${JS}</script>
</body>
</html>
`
