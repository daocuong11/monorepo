// @ts-check
import { facetsOf, inboxItems, inboxStats, priorityRank, viewOf } from './inbox.mjs'
import { autoApproved, flameFrames, flameTree } from './flame.mjs'
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
.ib{display:grid;grid-template-columns:minmax(320px,440px) minmax(0,1fr);gap:var(--s3) var(--s4);align-items:start}
/* Figures: the stats bands over the Inbox and Queue tabs. Parts keep a fixed order and color as counts move;
   labels and values wear text colors, the swatch beside them carries identity. */
.figs{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:var(--s3) var(--s5);padding:var(--s3) var(--s4) var(--s4)}
.fig{flex:1 1 200px;min-width:0;display:grid;align-content:start;gap:6px}
.fig>h3,.ranked-h{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0;font-weight:600;display:flex;flex-wrap:wrap;gap:0 var(--s2);align-items:baseline}
.fig>h3 span{text-transform:none;letter-spacing:0;font-weight:400;color:var(--faint)}
.fig-total{flex:0 1 auto;min-width:120px}.fig-total .big{font-size:26px;font-weight:600;line-height:1.1;letter-spacing:-.01em}
.fig-total .big.attn{color:var(--warn)}.fig-sub{font-size:12px;color:var(--muted)}.fig-sub+.fig-sub{margin-top:-4px}
.stack{display:flex;gap:2px;height:8px;margin-top:4px}.stack i{flex:var(--n) 1 0;min-width:3px;background:var(--c);border-radius:2px}
.stack i:first-child{border-radius:4px 2px 2px 4px}.stack i:last-child{border-radius:2px 4px 4px 2px}.stack i:only-child{border-radius:4px}
.stack.none{background:var(--chip);border-radius:4px}
.key{display:flex;flex-wrap:wrap;gap:2px var(--s3);font-size:12px;color:var(--muted)}
.key>span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.key i{width:8px;height:8px;border-radius:2px;background:var(--c)}
.key b{font-weight:600;color:var(--text)}
.hist{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;font-size:11px;text-align:center}
.hcol{display:grid;gap:2px;min-width:0}.hcol b{font-size:12px;font-weight:600}.hcol b.zero{color:var(--faint);font-weight:400}
.hb{height:30px;display:flex;align-items:flex-end;border-bottom:1px solid var(--line)}
.hb i{flex:1;border-radius:3px 3px 0 0;background:color-mix(in oklch,var(--muted) 55%,var(--panel))}
.hcol span{color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* Queue figures: where every issue in the loop sits, then what the loop did in the last day. */
.stage-cells{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:var(--s2) var(--s3);margin-top:2px}
.stage-cell{display:grid;gap:1px;min-width:0;font-size:12px;color:var(--muted)}
.stage-cell .nm{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.stage-cell .nm i{width:8px;height:8px;border-radius:2px;background:var(--c);flex:none}
.stage-cell b{font-size:18px;font-weight:600;color:var(--text);line-height:1.25}.stage-cell b.zero{color:var(--faint);font-weight:500}
.stage-cell .sub{color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stage-cell.go{appearance:none;background:none;border:0;padding:0;margin:0;font:inherit;text-align:left;cursor:pointer;border-radius:3px}
.stage-cell.go:hover b{color:var(--warn)}.stage-cell.go:hover .nm{color:var(--text)}.stage-cell.go:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.fig-flow{flex:3 1 420px}.fig-day{flex:2 1 260px}
.ranked{list-style:none;margin:2px 0 0;padding:0;display:grid;gap:3px;font-size:12px}
.ranked li{display:grid;grid-template-columns:minmax(0,9.5em) minmax(0,1fr) 3.5ch;gap:var(--s2);align-items:center}
.ranked .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.ranked .tr{height:6px}.ranked .tr i{display:block;height:100%;min-width:3px;border-radius:0 3px 3px 0;background:var(--flow-2)}
.ranked b{text-align:right;font-weight:600}
.day-foot{display:flex;flex-wrap:wrap;gap:2px var(--s3);font-size:12px;color:var(--muted)}
/* Inbox toolbar: filters and sort sit on the list they change. Each facet is a disclosure holding its tags. */
.ib-tools{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:var(--s2) var(--s3);border-bottom:1px solid var(--line)}
.ib-tools .sep-sort{margin-left:auto}
.dd{position:relative}
.dd-btn{appearance:none;font:inherit;font-size:12px;color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:2px 8px 2px 9px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.dd-btn::after{content:"";width:5px;height:5px;margin:-3px 1px 0 2px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(45deg);opacity:.7;transition:transform .15s ease-out}
.dd-btn[aria-expanded=true]::after{transform:translateY(3px) rotate(-135deg)}
.dd-btn:hover{color:var(--text);border-color:color-mix(in srgb,var(--text) 22%,var(--line))}
.dd-btn[aria-expanded=true]{color:var(--text);background:var(--chip)}
.dd-btn.on{color:var(--text);border-color:color-mix(in srgb,var(--accent) 55%,var(--line));background:color-mix(in srgb,var(--accent) 12%,var(--panel))}
.dd-btn b{font-weight:600;color:var(--text);max-width:12ch;overflow:hidden;text-overflow:ellipsis}.dd-btn .q{color:var(--faint)}
.menu{position:absolute;z-index:3;top:calc(100% + 4px);left:0;min-width:220px;max-width:min(320px,calc(100vw - 32px));max-height:min(340px,60vh);overflow:auto;padding:4px;
background:var(--panel);border:1px solid var(--line);border-radius:7px;box-shadow:0 8px 24px -6px rgb(0 0 0 / .22),0 2px 6px -2px rgb(0 0 0 / .12);scrollbar-width:thin;scrollbar-color:var(--bar) transparent}
.dd-sort .menu{left:auto;right:0;min-width:150px}
.opt{appearance:none;width:100%;display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:8px;align-items:center;padding:4px 8px;border:0;border-radius:4px;background:none;font:inherit;font-size:12.5px;color:var(--text);text-align:left;cursor:pointer}
.opt:hover{background:var(--chip)}.opt:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.opt .bx{width:13px;height:13px;border:1px solid color-mix(in srgb,var(--text) 35%,var(--line));border-radius:3px;display:grid;place-items:center}
.opt[aria-pressed=true] .bx{background:var(--accent);border-color:var(--accent)}
.opt[aria-pressed=true] .bx::after{content:"";width:3px;height:7px;margin-top:-2px;border:solid var(--panel);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.opt.radio .bx{border-radius:50%}.opt.radio[aria-pressed=true] .bx{background:var(--panel);border:4px solid var(--accent)}.opt.radio[aria-pressed=true] .bx::after{content:none}
.opt .lb{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.opt .n{color:var(--faint)}
.ib-active{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px var(--s3);border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--accent) 5%,var(--panel));font-size:12px}
.chip{appearance:none;font:inherit;font-size:12px;display:inline-flex;align-items:center;gap:6px;padding:1px 6px 1px 9px;border-radius:999px;cursor:pointer;white-space:nowrap;
color:var(--text);font-weight:500;border:1px solid color-mix(in srgb,var(--accent) 55%,var(--line));background:color-mix(in srgb,var(--accent) 12%,var(--panel))}
.chip .x{position:relative;width:10px;height:10px;opacity:.6}.chip .x::before,.chip .x::after{content:"";position:absolute;left:4px;top:0;width:1.5px;height:10px;background:currentColor;transform:rotate(45deg)}.chip .x::after{transform:rotate(-45deg)}
.chip:hover .x{opacity:1}.chip:hover{background:color-mix(in srgb,var(--accent) 20%,var(--panel))}
.dd-btn:focus-visible,.chip:focus-visible,.btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.ib-count{margin-left:auto;color:var(--muted);white-space:nowrap}
.ib-side{min-width:0}
.ib-list{padding:0}
.ib-list .row:last-child{border-radius:0 0 5px 5px}
.ib-list ul{list-style:none;margin:0;padding:0}
.row{display:grid;gap:3px;padding:10px var(--s3);border-top:1px solid var(--line);cursor:pointer;outline:none}

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
/* cambium's status comment: its "Last failure" is prose in a code fence, and its history table carries long reasons.
   Both fill the pane and wrap instead of scrolling sideways. */
.status .md{max-width:none}.status .md pre{max-height:40vh}.status .md pre code{white-space:pre-wrap;overflow-wrap:anywhere}
.status .md table{width:100%}.status .md th:last-child,.status .md td:last-child{width:100%;min-width:24ch}
.status .md td code{overflow-wrap:anywhere}
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
.md td:last-child{white-space:normal;min-width:18ch;overflow-wrap:anywhere}
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
/* Queue tab: work in hand over the queues it came from. One column template for both rows, so Triage sits over Intake,
   Running over Task and Pull requests over Promote. The queues sit on the page, the active row is lifted onto a panel. */
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr) minmax(0,1.3fr);gap:var(--s4) var(--s5)}
.active:not(.has-triage)>.l-running{grid-column:span 2}
section.lanes{background:none;border-color:transparent}
.col{min-width:0}.col ul{list-style:none;margin:0;padding:0}
.col>h2{display:flex;flex-wrap:wrap;align-items:baseline;padding-top:var(--s2);border-top:3px solid var(--line)}.col>h2 .lane-label:first-of-type{margin-left:auto}
.col.l-intake>h2,.col.l-triage>h2{border-top-color:var(--flow-1)}.col.l-task>h2{border-top-color:var(--flow-2)}.col.l-running>h2{border-top-color:var(--flow-3)}
.col.l-prs>h2{border-top-color:color-mix(in oklch,var(--flow-3),var(--flow-4))}.col.l-promote>h2{border-top-color:var(--flow-4)}
.col li.work{display:grid;gap:5px;padding:10px 0}.col li.work:first-child{padding-top:var(--s1)}
.work-head{display:flex;align-items:baseline;gap:var(--s3)}.work-head>a{min-width:0;flex:1}
.closes{flex:none;font-size:12px}
.trail{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 6px;font-size:12px;overflow-wrap:anywhere}.trail b{font-weight:600;color:var(--text)}.trail .sep{color:var(--faint)}
.prog{display:flex;align-items:center;gap:6px;font-size:12px}.prog .muted{margin-left:auto;padding-left:var(--s2)}
.prog .bar{flex:1;width:auto;min-width:48px;margin:0}
.stages{list-style:none;margin:3px 0 1px;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px}
.col li.stg{padding:0;border-top:0;display:grid;gap:3px;min-width:0;font-size:11px;color:var(--faint)}
.stg span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stg i{display:block;height:4px;border-radius:2px;background:var(--bar)}
.stg.done{color:var(--muted)}.stg.done i{background:var(--ok)}
.stg.now{color:var(--text);font-weight:600}.stg.fail{color:var(--err);font-weight:600}.stg.fail i{background:var(--err)}
.work.draft .stg i{opacity:.5}
/* In flight: a slow sheen runs along a stage in progress and a running worker's clock. The page re-renders on every poll,
   so each one is started at the shared clock's phase (inline animation-delay) and the motion never jumps. */
.stg.now i,.prog .bar i.moving{background:linear-gradient(90deg,var(--flow-3) 0 35%,color-mix(in oklch,var(--flow-3) 40%,var(--panel)) 50%,var(--flow-3) 65% 100%) 0 0/300% 100%;animation:sheen 2.4s linear infinite}
@keyframes sheen{from{background-position:100% 0}to{background-position:0 0}}
@media (prefers-reduced-motion:reduce){.stg.now i,.prog .bar i.moving{animation:none;background:var(--flow-3)}}
.col li>a,.work-head>a{color:var(--text)}.col li>a:hover,.work-head>a:hover{color:var(--accent);text-decoration:none}.col li>a:hover .t,.work-head>a:hover .t{text-decoration:underline}
.col li{padding:6px 0;border-top:1px solid var(--line)}.col li:first-child{border-top:0}
.t{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.col .t{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.meta{font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:2px 8px}
.empty{color:var(--faint);font-size:12px}
table{border-collapse:collapse;width:100%}th{text-align:left;font-weight:500;color:var(--muted);font-size:12px}
td,th{padding:4px 10px 4px 0;border-top:1px solid var(--line);vertical-align:top;white-space:nowrap}tr.logs td{border-top:0;padding-top:0;white-space:normal;overflow-wrap:anywhere}td.br{white-space:normal;overflow-wrap:anywhere;min-width:16ch}.scroll{overflow-x:auto}thead th{border-top:0}
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
.sp .nm .pill{margin-left:6px}
main:has(.flame){max-width:none}
.quiet-note{display:flex;flex-wrap:wrap;gap:2px var(--s2);margin-bottom:var(--s2);font-size:12px;color:var(--faint)}
.flame{margin-top:var(--s3);padding-bottom:var(--s3);border-bottom:1px solid var(--line);max-height:60vh;overflow:hidden auto;scrollbar-width:thin;scrollbar-color:var(--bar) transparent}
.flame h2{margin-bottom:var(--s1)}.crumbs{display:flex;flex-wrap:wrap;gap:2px 6px;font-size:12px;color:var(--faint);margin-bottom:var(--s2);overflow-wrap:anywhere}
.fl{position:relative}
.fr{appearance:none;position:absolute;height:18px;min-width:0;padding:0;border:0;border-radius:2px;box-shadow:inset 0 0 0 1px var(--panel);font:11px/18px ui-monospace,SFMono-Regular,Menlo,monospace;text-align:left;overflow:hidden;cursor:pointer;
color:var(--text);background:color-mix(in srgb,var(--fam,var(--muted)) 32%,var(--panel))}
.fr:hover{background:color-mix(in srgb,var(--fam,var(--muted)) 55%,var(--panel))}.fr:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.fr.err{box-shadow:inset 0 -2px 0 var(--err),inset 0 0 0 1px var(--panel)}
.fr>span{display:block;padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fl-note{font-size:12px;color:var(--faint);margin-top:var(--s2)}
.attrs{margin:0;padding:var(--s2) 0 var(--s3) var(--s4);display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px var(--s3);font-size:12px}
.attrs dt{color:var(--muted)}.attrs dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
@media (max-width:900px){.ib{grid-template-columns:minmax(0,1fr)}.ib.open>.figs,.ib.open>.ib-side,.ib:not(.open)>.ib-pane{display:none}
.ib-pane{position:static;max-height:none;padding:var(--s3) var(--s4) var(--s4)}.back{display:inline-block}
.dd{position:static}.menu{left:var(--s3);right:var(--s3);max-width:none}.dd-sort .menu{left:auto}}
@media (max-width:640px){.stage-cells{grid-template-columns:repeat(3,minmax(0,1fr))}.fig-total{flex-basis:100%}.fig{flex-basis:140px}.fig:has(.hist){flex-basis:100%}}
@media (max-width:1100px){.active{grid-template-columns:repeat(2,minmax(0,1fr))}.active>.col{grid-column:auto}.active.has-triage>.l-prs{grid-column:1/-1}.detail{grid-template-columns:1fr}}
/* Narrow: the status header wraps to three lines, so it scrolls away and only the tabs (which carry the health dot) stay put. */
@media (max-width:760px){#top{display:contents}header{border-top:3px solid var(--health);transition:border-color .4s ease-out}
.tabs{position:sticky;top:0;z-index:1}body.down header,body.down .tabs{opacity:.5;transition:opacity .3s ease-out}
td.br{white-space:nowrap}.grid,.active{grid-template-columns:minmax(0,1fr)}.active>.col,.active.has-triage>.l-prs{grid-column:auto}
.sp,.wf-axis{grid-template-columns:minmax(0,1fr) 56px}.sp .track,.wf-axis .ticks{grid-column:1/-1;order:3}.wf-axis>span:not(.ticks){display:none}}
@media (max-width:480px){main{padding:var(--s3) var(--s3) var(--s5);gap:var(--s3)}section{padding:var(--s3)}
.tabs{padding:0 var(--s3);gap:var(--s4)}}
`

const JS = `
${[inboxItems, priorityRank, facetsOf, viewOf, inboxStats, markdown, autoApproved, flameTree, flameFrames].map(String).join('\n')}
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

const isMulti = (gh) => new Set(gh.repos.map((r) => r.slug)).size > 1
const list = (xs, render, multi, now) => xs.length ? h('ul', {}, xs.map((x) => render(x, multi, now))) : h('div', { class: 'empty' }, 'empty')


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
let ibSel = null, ibOpen = false, ibShown = [], ibMenu = null
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
const FACET_NAME = { kind: 'Kind', why: 'Reason', priority: 'Priority', repo: 'Repo', label: 'Label' }
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

  const facets = facetsOf(all, ibTags)
  const menu = (id, label, summary, on, opts) => h('div', { class: 'dd' + (id === 'sort' ? ' dd-sort' : '') },
    h('button', { type: 'button', class: 'dd-btn' + (on ? ' on' : ''), 'data-menu': id, 'data-fk': 'menu:' + id,
      'aria-expanded': String(ibMenu === id), 'aria-controls': ibMenu === id ? 'menu-' + id : null,
      'aria-label': id === 'sort' ? 'Sort: ' + summary.textContent : null, title: id === 'sort' ? 'Sort order' : null }, id === 'sort' ? null : label, summary),
    ibMenu === id ? h('div', { class: 'menu', id: 'menu-' + id, role: 'group', 'aria-label': label }, opts) : null)
  const filters = facets.map((f) => {
    const on = f.tags.filter((t) => t.on)
    const summary = on.length === 1 ? h('b', {}, f.facet === 'kind' ? tagText(on[0]) : on[0].value) : on.length ? h('b', {}, on.length) : null
    return menu(f.facet, FACET_NAME[f.facet] || f.facet, summary, on.length > 0, f.tags.map((t) =>
      h('button', { type: 'button', class: 'opt', 'data-tag': t.id, 'data-fk': 'tag:' + t.id, 'aria-pressed': String(t.on), title: TAG_TITLE[t.id] || null },
        h('span', { class: 'bx', 'aria-hidden': 'true' }), h('span', { class: 'lb' }, tagText(t)), h('span', { class: 'n' }, t.n))))
  })
  const sortLabel = (SORTS.find(([k]) => k === ibSort) || SORTS[0])[1]
  const tools = h('div', { class: 'ib-tools', role: 'toolbar', 'aria-label': 'Filter and sort the inbox' },
    filters.length ? filters : h('span', { class: 'faint' }, 'Nothing to filter by'),
    h('span', { class: 'sep-sort' }),
    menu('sort', 'Sort', h('b', {}, sortLabel), false, SORTS.map(([k, label]) =>
      h('button', { type: 'button', class: 'opt radio', 'data-sort': k, 'data-fk': 'sort:' + k, 'aria-pressed': String(ibSort === k) },
        h('span', { class: 'bx', 'aria-hidden': 'true' }), h('span', { class: 'lb' }, label), h('span')))))
  const chosen = [...ibTags].map((id) => facets.flatMap((f) => f.tags).find((t) => t.id === id) || { id, value: id.slice(id.indexOf(':') + 1) })
  const active = ibTags.size ? h('div', { class: 'ib-active' },
    chosen.map((t) => h('button', { type: 'button', class: 'chip', 'data-tag': t.id, 'data-fk': 'chip:' + t.id, 'aria-label': 'Remove filter ' + tagText(t) },
      tagText(t), h('span', { class: 'x', 'aria-hidden': 'true' }))),
    h('span', { class: 'ib-count', 'aria-live': 'polite' }, shown.length + ' of ' + all.length + ' · ',
      h('button', { class: 'linkish', type: 'button', 'data-clear': '', 'data-fk': 'clear' }, 'Clear'))) : null

  const focusable = sel ? sel.key : shown[0] && shown[0].key
  const rows = shown.map((it) => h('li', { class: 'row', role: 'option', 'data-key': it.key, 'data-fk': 'row:' + it.key,
      'aria-selected': String(it.key === ibSel), tabindex: it.key === focusable ? 0 : -1 },
    h('span', { class: 'row-t', title: it.title }, h('span', { class: 'faint' }, '#' + it.number + ' '), it.title),
    h('span', { class: 'meta' }, whyOf(it), prio(it.priority), multi ? h('span', {}, it.repo.split('/')[1]) : null,
      h('span', { class: 'faint age', title: it.at || '' }, ago(it.at, now)))))
  const side = h('div', { class: 'ib-side' },
    h('section', { class: 'ib-list attn' }, tools, active, rows.length
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
  const stats = inboxFigures(inboxStats(all, now), multi, now)
  return { ib: h('div', { class: 'ib' + (ibOpen ? ' open' : ''), id: 'ib' }, stats, side, pane), stats, side, pane }
}

// Figures. A stacked bar is a part-to-whole; its key below names every part with its count.
const pct = (n, total) => Math.round((n / Math.max(1, total)) * 100) + '%'
function stack(parts, colorOf, total, what) {
  if (!total) return h('div', { class: 'stack none', role: 'img', 'aria-label': what + ': none' })
  return h('div', { class: 'stack', role: 'img', 'aria-label': what + ': ' + parts.map((p) => p.label + ' ' + p.n).join(', ') },
    parts.map((p, i) => h('i', { style: '--n:' + p.n + ';--c:' + colorOf(p, i), title: p.label + ': ' + p.n + ' of ' + total + ' (' + pct(p.n, total) + ')' })))
}
const key = (parts, colorOf) => h('div', { class: 'key', 'aria-hidden': 'true' },
  parts.map((p, i) => h('span', {}, h('i', { style: '--c:' + colorOf(p, i) }), p.label, h('b', {}, p.n))))
const WARN_STEPS = ['var(--warn)', 'color-mix(in srgb,var(--warn) 58%,var(--panel))', 'color-mix(in srgb,var(--warn) 30%,var(--panel))']
const reasonColor = (p, i) => (p.key === 'why:~stranded' ? 'var(--err)' : p.key === 'why:~none' ? 'var(--bar)' : WARN_STEPS[Math.min(i, 2)])
const PRIO_COLOR = { critical: 'var(--err)', high: 'var(--warn)', medium: WARN_STEPS[1] }
const prioColor = (p) => (p.key === 'priority:~none' ? 'var(--bar)' : PRIO_COLOR[p.label] || WARN_STEPS[2])

function inboxFigures(st, multi, now) {
  const max = Math.max(1, ...st.opened.map((p) => p.n))
  return h('section', { class: 'figs', 'aria-label': 'Inbox at a glance' },
    h('div', { class: 'fig fig-total' }, h('h3', {}, 'Needs you'),
      h('div', { class: 'big' + (st.total ? ' attn' : '') }, st.total),
      st.oldest ? h('div', { class: 'fig-sub', title: 'Oldest issue in the inbox was opened ' + st.oldest }, 'oldest opened ' + ago(st.oldest, now)) : null,
      multi ? h('div', { class: 'fig-sub' }, st.repos.map((r, i) => [i ? ' · ' : '', h('b', {}, r.n), ' ' + r.label.split('/')[0]])) : null),
    h('div', { class: 'fig' }, h('h3', {}, 'Reason'), stack(st.reasons, reasonColor, st.total, 'Reasons'), key(st.reasons, reasonColor)),
    h('div', { class: 'fig' }, h('h3', {}, 'Priority'), stack(st.priorities, prioColor, st.total, 'Priorities'), key(st.priorities, prioColor)),
    h('div', { class: 'fig' }, h('h3', { title: "By when the issue was opened: GitHub doesn't say when it entered the inbox" }, 'Opened', h('span', {}, 'issue age')),
      h('div', { class: 'hist', role: 'img', 'aria-label': 'Issue age: ' + st.opened.map((p) => p.label + ' ' + p.n).join(', ') },
        st.opened.map((p) => h('div', { class: 'hcol', title: p.label + ': ' + p.n + ' of ' + st.total },
          h('b', { class: p.n ? null : 'zero' }, p.n),
          h('span', { class: 'hb' }, p.n ? h('i', { style: 'height:' + Math.max(3, Math.round((p.n / max) * 30)) + 'px' }) : null),
          h('span', {}, p.label))))))
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

// Queue tab. The top row is work cambium has in hand (triage, task workers, agent PRs) with how far each has got;
// the row under it is the three queues waiting on it. Both rows share one grid so Triage sits over Intake,
// Running over Task and PRs over Promote: each piece of live work is above the queue it came from.
const LANES = [['intake', 'Intake', 'q:intake'], ['task', 'Task', 'q:task'], ['running', 'Running', 'running'], ['promote', 'Promote', 'q:promote']]
const inFlight = (gh) => LANES.reduce((n, [k]) => n + gh.columns[k].length, 0)
const issueKey = (repo, n) => repo + '#' + n
let traceProg = {}
const SHEEN_MS = 2400
const sheenPhase = () => 'animation-delay:-' + (Date.now() % SHEEN_MS) + 'ms'

function activeWork(s) {
  const gh = s.github, d = s.heartbeat.data
  const workers = new Map((d ? d.workers : []).map((w) => [issueKey(w.repo, w.issue), w]))
  const triage = [], running = []
  for (const i of gh.columns.running) (i.labels.includes('q:intake') ? triage : running).push(i)
  // A worker this host runs whose issue GitHub doesn't show as running (yet, or any more) still shows: truth over comfort.
  const listed = new Set(gh.columns.running.map((i) => issueKey(i.repo, i.number)))
  for (const w of workers.values()) {
    if (listed.has(issueKey(w.repo, w.issue))) continue
    const orphan = { repo: w.repo, number: w.issue, title: 'not labelled running on GitHub', url: 'https://github.com/' + w.repo + '/issues/' + w.issue, labels: [], orphan: true }
    ;(w.phase === 'dispatch' ? triage : running).push(orphan)
  }
  return { triage, running, workers, caps: (d && d.caps) || {} }
}

function trail(p) {
  if (!p || !p.trail || !p.trail.length) return null
  const last = p.trail.length - 1
  return h('div', { class: 'trail mono', title: (p.graph ? p.graph + ' graph: ' : '') + p.trail.join(' › ') },
    p.trail.map((n, i) => [i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '›') : null, i === last ? h('b', {}, n) : h('span', { class: 'faint' }, n)]))
}

function clock(w, ageMs) {
  if (!w) return h('div', { class: 'prog faint' }, 'no worker on this host')
  const elapsed = (w.elapsedMs || 0) + (w.alive && ageMs ? ageMs : 0)
  const frac = w.wallClockMs ? Math.min(1, elapsed / w.wallClockMs) : 0
  const tone = frac >= 1 ? 'err' : frac > 0.8 ? 'warn' : ''
  return h('div', { class: 'prog', title: 'Wall clock: ' + dur(elapsed) + ' of the ' + dur(w.wallClockMs) + ' a worker may run' },
    h('span', { class: 'bar', role: 'meter', 'aria-label': 'wall clock used', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(frac * 100) },
      h('i', { class: tone || (w.alive ? 'moving' : null), style: 'width:' + Math.round(frac * 100) + '%;' + sheenPhase() })),
    h('span', { class: tone || null }, dur(elapsed)), h('span', { class: 'faint' }, '/ ' + dur(w.wallClockMs)),
    h('span', { class: 'muted' }, 'attempt ' + (w.attempt ?? '–')))
}

function workCard(i, multi, now, w, ageMs) {
  const p = traceProg[issueKey(i.repo, i.number)]
  return h('li', { class: 'work' },
    link(i.url, h('span', { class: 't', title: i.title }, h('span', { class: 'faint' }, '#' + i.number + ' '), i.orphan ? h('span', { class: 'warn' }, i.title) : i.title)),
    trail(p) || h('div', { class: 'trail faint' }, 'no trace for this run yet'),
    clock(w, ageMs),
    w && w.killedReason ? h('div', { class: 'err' }, 'killed: ' + w.killedReason) : w && !w.alive ? h('div', { class: 'err' }, 'worker exited; cambium reconciles it next tick') : null,
    h('div', { class: 'meta' },
      p && p.errors ? h('span', { class: 'err' }, plural(p.errors, 'failed span', 'failed spans')) : null,
      p && p.costUsd != null ? h('span', {}, usd(p.costUsd)) : null,
      p ? h('span', { class: 'faint', title: new Date(p.end).toISOString() }, 'active ' + ago(new Date(p.end).toISOString(), now)) : null,
      prio(i.priority),
      multi ? h('span', {}, i.repo) : null,
      traceLink(i.repo, i.number)))
}

// Where an agent PR is on its way in: checks, auto-merge, the merge queue, merged. A merged PR leaves this list,
// so the last stage only ever shows as next.
const RED = { FAILURE: 1, ERROR: 1 }
function stages(p) {
  const passed = p.checks === 'SUCCESS'
  const reported = p.checks || (p.tally && p.tally.passed + p.tally.failed + p.tally.pending)
  const checks = RED[p.checks] ? 'fail' : passed ? 'done' : reported || !p.draft ? 'now' : 'todo'
  const auto = p.inMergeQueue || p.autoMerge ? 'done' : p.mergeState === 'DIRTY' ? 'fail' : passed ? 'now' : 'todo'
  const pos = p.inMergeQueue && p.queue && p.queue.position != null ? ' #' + p.queue.position : ''
  return [['checks', checks], ['auto-merge', auto], ['queue' + pos, p.inMergeQueue ? 'now' : 'todo'], ['merged', 'todo']]
}
const STAGE_WORD = { done: 'done', now: 'in progress', fail: 'stuck', todo: 'not yet' }
const MERGE_STATE = { DIRTY: ['err', 'merge conflicts'], BEHIND: ['warn', 'behind base'] }

function tallyText(p) {
  const t = p.tally, total = t ? t.passed + t.failed + t.pending : 0
  if (!total) { const [cls, word] = CHECK[p.checks] || ['faint', 'no checks reported']; return h('span', { class: cls }, word) }
  // Nothing finished yet: "0 of 2 checks pass" reads as failure, so say what is happening.
  if (!t.passed && !t.failed) return h('span', { class: 'muted' }, plural(t.pending, 'check', 'checks') + ' running')
  return [h('span', { class: t.failed ? null : t.pending ? null : 'ok' }, t.passed + ' of ' + total + ' checks pass'),
    t.pending ? h('span', { class: 'muted' }, t.pending + ' running') : null,
    t.failed ? h('span', { class: 'err' }, t.failed + ' failing') : null]
}

function prCard(p, multi, now) {
  const issue = p.closes[0], prog = issue ? traceProg[issueKey(p.repo, issue)] : null
  const [msCls, msWord] = MERGE_STATE[p.mergeState] || []
  return h('li', { class: 'work' + (p.draft ? ' draft' : '') },
    h('div', { class: 'work-head' },
      link(p.url, h('span', { class: 't', title: p.title }, h('span', { class: 'faint' }, '#' + p.number + ' '), p.title)),
      p.closes.length ? h('span', { class: 'closes faint' }, 'closes', p.closes.map((n) => [' ', link('https://github.com/' + p.repo + '/issues/' + n, '#' + n)])) : null),
    h('ol', { class: 'stages', 'aria-label': 'Progress to merge' },
      stages(p).map(([label, state]) => h('li', { class: 'stg ' + state, title: label + ': ' + STAGE_WORD[state] }, h('i', { style: state === 'now' ? sheenPhase() : null }), h('span', {}, label)))),
    h('div', { class: 'meta' },
      p.draft ? h('span', { class: 'pill' }, 'draft') : null,
      tallyText(p),
      msWord ? h('span', { class: msCls }, msWord) : null,
      prog && prog.node ? h('span', { class: 'muted', title: 'Last node cambium recorded' + (prog.graph ? ' in the ' + prog.graph + ' graph' : '') }, 'cambium at ', h('span', { class: 'mono' }, prog.node)) : null),
    h('div', { class: 'meta' },
      p.additions != null ? [h('span', { class: 'ok' }, '+' + p.additions), h('span', { class: 'err' }, '−' + p.deletions)] : null,
      p.files != null ? h('span', { class: 'faint' }, plural(p.files, 'file', 'files')) : null,
      h('span', { class: 'faint', title: p.createdAt || '' }, 'opened ' + ago(p.createdAt || p.updatedAt, now)),
      multi ? h('span', {}, p.repo) : null,
      h('span', { class: 'faint mono' }, p.branch),
      issue ? traceLink(p.repo, issue) : null))
}

// Queue figures. Every issue in the loop by where it sits now, q:human included, since that is often where
// work piles up; then what the loop did over the last day, from the traces: where each active issue ended up.
const STAGES = [['intake', 'Intake', 'var(--flow-1)'], ['task', 'Task', 'var(--flow-2)'], ['running', 'Running', 'var(--flow-3)'],
  ['human', 'Human', 'var(--warn)'], ['promote', 'Promote', 'var(--flow-4)']]
const oldestOpened = (xs) => xs.reduce((m, i) => { const t = Date.parse(i.createdAt || ''); return isFinite(t) && (m == null || t < m) ? t : m }, null)
const DAY_SHOWN = 5

function queueFigures(s, a, liveTask, now) {
  const gh = s.github
  const cells = STAGES.map(([k, label, c]) => {
    const xs = k === 'running' ? [...a.triage, ...a.running] : gh.columns[k]
    const old = oldestOpened(xs)
    const sub = k === 'running' && a.caps.task ? liveTask + ' of ' + a.caps.task + ' slots' : old != null ? 'oldest ' + dur(now - old) : '–'
    return { k, label, c, n: xs.length, sub, title: old != null ? 'Oldest issue here was opened ' + new Date(old).toISOString() : null }
  })
  const total = cells.reduce((n, x) => n + x.n, 0)
  const parts = cells.filter((x) => x.n).map((x) => ({ label: x.label, n: x.n, c: x.c }))
  const flow = h('div', { class: 'fig fig-flow' },
    h('h3', {}, 'In the loop', h('span', {}, plural(total, 'issue', 'issues'))),
    stack(parts, (p) => p.c, total, 'Issues by stage'),
    h('div', { class: 'stage-cells' }, cells.map((x) => {
      const kids = [h('span', { class: 'nm' }, h('i', { style: '--c:' + x.c }), x.label), h('b', { class: x.n ? null : 'zero' }, x.n), h('span', { class: 'sub', title: x.title }, x.sub)]
      return x.k === 'human'
        ? h('button', { type: 'button', class: 'stage-cell go', 'data-go': 'inbox', title: 'Open the Inbox' }, kids)
        : h('div', { class: 'stage-cell' }, kids)
    })))
  const tr = s.traces, r = tr && tr.status === 'ok' ? tr.recent : null
  let day
  if (!r) day = h('div', { class: 'fig fig-day' }, h('h3', {}, 'Last 24 hours'),
    h('p', { class: 'fig-sub', style: 'margin:0' }, !tr ? 'Tracing is off, so there is no throughput to show.'
      : tr.status !== 'ok' ? tr.message : 'This canopy server sends no throughput figures; restart it to pick up the new version.'))
  else {
    const top = r.byNode.slice(0, DAY_SHOWN), rest = r.byNode.slice(DAY_SHOWN).reduce((n, x) => n + x.n, 0)
    const max = Math.max(1, ...top.map((x) => x.n))
    const name = (node) => (node == null ? h('span', { class: 'faint' }, 'no cambium step') : h('span', { class: 'mono' }, node))
    day = h('div', { class: 'fig fig-day' },
      h('h3', { title: 'Traces with a span in the last ' + dur(r.sinceMs) + ', by the last cambium node each reached' }, 'Last 24 hours',
        h('span', {}, plural(r.runs, 'issue', 'issues') + ' active · where each ended up')),
      r.runs ? h('ul', { class: 'ranked' }, top.map((x) => h('li', { title: (x.node || 'no cambium step') + ': ' + x.n + ' of ' + r.runs },
        h('span', { class: 'nm' }, name(x.node)), h('span', { class: 'tr' }, h('i', { style: 'width:' + Math.round((x.n / max) * 100) + '%' })), h('b', {}, x.n))),
        rest ? h('li', {}, h('span', { class: 'nm faint' }, 'other steps'), h('span'), h('b', { class: 'faint' }, rest)) : null)
        : h('p', { class: 'fig-sub', style: 'margin:0' }, 'No traced activity in the last day.'),
      h('div', { class: 'day-foot' },
        r.costUsd != null ? h('span', {}, h('b', { style: 'color:var(--text)' }, usd(r.costUsd)), ' spent') : null,
        r.errored ? h('button', { type: 'button', class: 'linkish', 'data-go': 'traces' }, h('span', { class: 'err' }, plural(r.errored, 'run', 'runs') + ' with a failed span')) : h('span', { class: 'faint' }, 'no failed spans')))
  }
  return h('section', { class: 'figs', 'aria-label': 'Queue at a glance' }, flow, day)
}

const slots = (n, cap) => (cap ? h('span', { class: 'lane-label' }, n + ' of ' + cap + ' slots') : null)
const heading = (title, n, ...extra) => h('h2', {}, title, h('span', { class: 'n' }, n), extra)

function queues(s, now) {
  const gh = s.github, multi = isMulti(gh), ageMs = s.heartbeat.ageMs
  traceProg = (s.traces && s.traces.progress) || {}
  const a = activeWork(s)
  const workerOf = (i) => a.workers.get(issueKey(i.repo, i.number))
  const live = (xs, phase) => xs.filter((i) => { const w = workerOf(i); return w && w.alive && w.phase === phase }).length
  const cards = (xs, empty) => (xs.length ? h('ul', {}, xs.map((i) => workCard(i, multi, now, workerOf(i), ageMs))) : h('div', { class: 'empty' }, empty))
  const waiting = gh.columns.task.length
  const green = gh.prs.filter((p) => p.checks === 'SUCCESS').length, red = gh.prs.filter((p) => RED[p.checks]).length
  const prSum = [green ? h('span', { class: 'ok' }, green + ' green') : null, red ? h('span', { class: 'err' }, red + ' failing') : null]
  const active = h('section', { class: 'grid active' + (a.triage.length ? ' has-triage' : ''), 'aria-label': 'Work in progress' },
    a.triage.length ? h('div', { class: 'col l-triage' }, heading('Triage', a.triage.length, slots(live(a.triage, 'dispatch'), a.caps.dispatch)), cards(a.triage)) : null,
    h('div', { class: 'col l-running' }, heading('Running', a.running.length, slots(live(a.running, 'task'), a.caps.task)),
      cards(a.running, waiting ? 'No worker running; ' + plural(waiting, 'issue waits', 'issues wait') + ' in q:task.' : 'No worker running.')),
    h('div', { class: 'col l-prs' }, heading('Pull requests', gh.prs.length, h('span', { class: 'lane-label mono' }, 'agent/*'), h('span', { class: 'lane-label' }, prSum[0], prSum[0] && prSum[1] ? ' · ' : null, prSum[1])),
      gh.prs.length ? h('ul', {}, gh.prs.map((p) => prCard(p, multi, now))) : h('div', { class: 'empty' }, 'No open agent PRs.')))
  const lane = ([k, title, label]) => h('div', { class: 'col l-' + k },
    heading(title, gh.columns[k].length, h('span', { class: 'lane-label mono' }, label)), list(gh.columns[k], item, multi, now))
  const queued = h('section', { class: 'grid lanes', 'aria-label': 'Queues' }, LANES.filter(([k]) => k !== 'running').map(lane))
  return [queueFigures(s, a, live(a.running, 'task'), now), active, queued]
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

// Log paths sit under the user's home; ~ keeps them pasteable into a shell at a third of the width.
const homeless = (p) => String(p).replace(/^\\/(?:Users|home)\\/[^/]+(?=\\/)/, '~')

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
      h('td', { class: 'mono br' }, w.branch || '–')),
      logs.length ? h('tr', { class: 'logs' }, h('td', { colspan: 6, class: 'mono faint' }, logs.map((l) => h('div', { title: l }, homeless(l))))) : null]
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
  if (sp.name === 'claude_code.tool.blocked_on_user') return [a.decision === 'reject' ? 'rejected' : 'accepted', a.source ? 'by ' + a.source : null]
  if (a.tool_name) return [a.tool_name]
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
let openSpans = new Set(), showQuiet = false, flameKey = ''
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
  const quiet = d.spans.filter(autoApproved)
  const shown = showQuiet ? d.spans : d.spans.filter((sp) => !autoApproved(sp))
  const rows = shown.map((sp) => {
    const left = ((sp.start - t.start) / span) * 100, width = ((sp.end - sp.start) / span) * 100
    const open = openSpans.has(sp.spanId)
    const detail = spanDetail(sp).filter((x) => x != null && x !== '')
    const fam = familyOf(sp.name)
    const bar = [fam ? 'f-' + fam : '', sp.name === 'cambium.wait' ? 'wait' : '', sp.status === 'error' ? 'err' : ''].join(' ').trim()
    const row = h('button', { type: 'button', class: 'sp', 'data-span': sp.spanId, 'aria-expanded': String(open),
        title: sp.name + ' · at +' + dur(sp.start - t.start) + ' · took ' + dur(sp.end - sp.start) },
      h('span', { class: 'nm', style: 'padding-left:' + sp.depth * 14 + 'px' },
        sp.status === 'error' ? h('span', { class: 'dot err' }) : null, sp.name, detail.length ? h('span', { class: 'faint' }, detail.join(' · ')) : null, askPill(sp)),
      h('span', { class: 'track' }, h('i', { class: bar || null, style: 'left:' + left.toFixed(3) + '%;width:' + width.toFixed(3) + '%' })),
      h('span', { class: 'd' }, dur(sp.end - sp.start)))
    if (!open) return row
    const kv = [['service', sp.service], ['status', sp.status + (sp.statusMessage ? ': ' + sp.statusMessage : '')],
      ['started', new Date(sp.start).toISOString()], ['span id', sp.spanId], ...Object.entries(sp.attrs)].filter(([, v]) => v != null)
    for (const e of sp.events) kv.push(['event · ' + e.name, (isFinite(e.at) ? '+' + dur(e.at - sp.start) + ' ' : '') + Object.entries(e.attrs).map(([k, v]) => k + '=' + showValue(v)).join(' ')])
    return [row, h('dl', { class: 'attrs mono' }, kv.map(([k, v]) => [h('dt', {}, k), h('dd', {}, showValue(v))]))]
  })
  const note = quiet.length ? h('div', { class: 'quiet-note' },
    h('span', {}, plural(quiet.length, 'permission check', 'permission checks'), ' approved by config or a hook, with nobody asked, ', showQuiet ? 'shown' : 'hidden', '.'),
    h('button', { type: 'button', class: 'linkish', 'data-quiet': '' }, showQuiet ? 'hide them' : 'show them')) : null
  return h('section', {}, head, flameView(d.spans), h('div', { class: 'wf' }, legend(d.spans), note, axis, rows), traceFileNote(d))
}

// A permission check a person answered, or one that was refused, is the one worth seeing.
function askPill(sp) {
  if (sp.name !== 'claude_code.tool.blocked_on_user' || autoApproved(sp)) return null
  if (sp.attrs.decision === 'reject') return h('span', { class: 'pill err' }, 'refused')
  return h('span', { class: 'pill warn' }, 'asked you · ' + dur(sp.end - sp.start))
}

// Where the time went: spans with the same path of names fold into one frame, as wide as their summed time.
function flameView(spans) {
  const tree = flameTree(spans)
  const { top, frames } = flameFrames(tree, flameKey)
  const ROW = 20
  const levels = frames.reduce((n, f) => Math.max(n, f.level), 0) + 1
  const crumbs = [h('button', { type: 'button', class: 'linkish', 'data-frame': '' }, 'all spans')]
  let at = tree
  for (const part of top.key.split('/').slice(1)) {
    at = at.kids.find((k) => k.label === part)
    if (!at) break
    crumbs.push(' › ', at === top ? h('span', {}, part) : h('button', { type: 'button', class: 'linkish', 'data-frame': at.key }, part))
  }
  const share = (f) => (top.ms ? Math.round((f.ms / top.ms) * 1000) / 10 : 0) + '%'
  const boxes = frames.map((f) => {
    const fam = familyOf(f.label)
    const up = f === frames[0] && top !== tree ? top.key.slice(0, top.key.lastIndexOf('/')) : f.key
    return h('button', { type: 'button', class: ['fr', fam ? 'f-' + fam : '', f.errors ? 'err' : ''].join(' ').trim(), 'data-frame': up,
      style: 'left:' + (f.left * 100).toFixed(3) + '%;width:' + (f.width * 100).toFixed(3) + '%;top:' + f.level * ROW + 'px',
      title: f.label + '\\n' + dur(f.ms) + ' · ' + share(f) + ' · ' + plural(f.count, 'span', 'spans') + (f.errors ? ' · ' + f.errors + ' failed' : '') +
        (f === frames[0] && top !== tree ? '\\nclick to zoom out' : '') },
      h('span', {}, f.label + ' · ' + dur(f.ms)))
  })
  return h('aside', { class: 'flame', 'aria-label': 'Flame graph' }, h('h2', {}, 'Where time went'),
    h('div', { class: 'crumbs' }, crumbs),
    h('div', { class: 'fl', style: 'height:' + levels * ROW + 'px' }, boxes),
    h('div', { class: 'fl-note' }, 'Width is time summed over every span on that path, so parallel work adds up. Click a frame to zoom in.'))
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
  const mb = e.target.closest('[data-menu]')
  if (mb) { ibMenu = ibMenu === mb.dataset.menu ? null : mb.dataset.menu; if (last) render(last); return }
  const ctl = e.target.closest('[data-sort],[data-tag],[data-clear],[data-key],[data-back],[data-retry]')
  if (ctl) {
    const ds = ctl.dataset
    if (ds.key) return select(ds.key, { open: true, focus: true })
    if (ds.back != null) { ibOpen = false; if (last) render(last); return ibSel && focusRow(ibSel) }
    if (ds.retry != null) { const it = ibShown.find((x) => x.key === ibSel); return it && loadDetail(it, true) }
    const chip = ctl.classList.contains('chip')
    if (ds.sort) { ibSort = ds.sort; ibMenu = null }
    else if (ds.tag) ibTags.has(ds.tag) ? ibTags.delete(ds.tag) : ibTags.add(ds.tag)
    else { ibTags.clear(); ibMenu = null }
    store.set('inbox.sort', ibSort)
    store.set('inbox.tags', [...ibTags])
    if (last) render(last)
    if (ds.sort) $('ib')?.querySelector('[data-menu=sort]')?.focus()
    // A removed chip or a clear takes its button away: land on the next chip, else the first filter.
    if (chip || ds.clear != null) ($('ib')?.querySelector('.ib-active .chip') || $('ib')?.querySelector('[data-menu]'))?.focus()
    return pump()
  }
  const fr = e.target.closest('[data-frame]')
  if (fr) {
    flameKey = fr.dataset.frame
    if (last) render(last)
    return document.querySelector('.fr[data-frame="' + CSS.escape(flameKey) + '"],.crumbs [data-frame="' + CSS.escape(flameKey) + '"]')?.focus({ preventScroll: true })
  }
  if (e.target.closest('[data-quiet]')) {
    showQuiet = !showQuiet
    if (last) render(last)
    return document.querySelector('[data-quiet]')?.focus({ preventScroll: true })
  }
  const sp = e.target.closest('[data-span]')
  if (!sp) return
  const id = sp.dataset.span
  if (openSpans.has(id)) openSpans.delete(id)
  else openSpans.add(id)
  if (last) render(last)
  document.querySelector('[data-span="' + id + '"]')?.focus({ preventScroll: true })
})
// An open filter or sort menu closes on a click anywhere outside it.
document.addEventListener('click', (e) => {
  if (!ibMenu || e.target.closest('.dd')) return
  ibMenu = null
  if (last) render(last)
})
// Inbox keys: j/k (and arrows in the list) move, Enter reads, o opens on GitHub, Escape goes back on narrow screens.
document.addEventListener('keydown', (e) => {
  if (tab !== 'inbox' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
  const t = e.target
  if (ibMenu && e.key === 'Escape') {
    e.preventDefault()
    const id = ibMenu
    ibMenu = null
    if (last) render(last)
    return $('ib')?.querySelector('[data-menu="' + CSS.escape(id) + '"]')?.focus()
  }
  if (t.closest && t.closest('.dd')) {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key]
    const opts = [...($('ib')?.querySelectorAll('.menu .opt') || [])]
    if (step && opts.length) {
      e.preventDefault()
      const i = opts.indexOf(t)
      opts[i < 0 ? (step > 0 ? 0 : opts.length - 1) : (i + step + opts.length) % opts.length].focus()
    }
    return
  }
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
  if (traceSel !== before) { openSpans = new Set(); flameKey = ''; window.scrollTo(0, 0) }
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
  if (tab === 'queue') body.push(...queues(s, now))
  if (tab === 'traces') body.push(tracesTab(now))
  if (tab === 'health') {
    if (d) body.push(summary(d), h('div', { class: 'detail' }, workers(d, s.heartbeat.ageMs), events(d)))
    else body.push(section('Health', null, h('div', { class: 'empty' }, 'Ticks, workers and events appear once cambium writes a readable heartbeat; see the message above.')))
  }
  tabs(s)
  const focused = document.activeElement, href = focused && focused.getAttribute && focused.getAttribute('href')
  const fk = focused && focused.dataset && focused.dataset.fk
  const scrolled = [...document.querySelectorAll('.events,.scroll,.menu')].map((el) => [el.className, el.scrollTop, el.scrollLeft])
  $('head').replaceChildren(header(s, now))
  const ib = $('ib'), oldPane = $('ib-pane')
  const paneWas = oldPane && { key: oldPane.dataset.key, top: oldPane.scrollTop, open: [...oldPane.querySelectorAll('details')].map((x) => x.open) }
  if (split && !split.pane && ib && $('ib-pane')) {
    // The pane hasn't changed: patch around it so a selection, scroll position or open <details> in it survive the poll.
    ib.className = split.ib.className
    ib.querySelector(':scope > .figs').replaceWith(split.stats)
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
    const banner = h('div', { id: 'down', class: 'banner err' }, h('b', {}, "Can't reach the canopy server: "), (err && err.message) || 'no answer',
      (last ? '. Showing the last data it sent; retrying' : '. Nothing read yet; retrying') + ' every ' + dur(pollMs) + '. Is canopy still running?')
    if (last) $('main').prepend(banner)
    else $('main').replaceChildren(banner)
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
<div id="top"><div id="head"><header><h1>canopy</h1></header></div>
<nav class="tabs" id="tabs" role="tablist" aria-label="Views">
<button class="tab" role="tab" type="button" id="tab-inbox" data-tab="inbox" aria-controls="main">Inbox <span class="count" id="n-inbox">–</span></button>
<button class="tab" role="tab" type="button" id="tab-queue" data-tab="queue" aria-controls="main" tabindex="-1">Queue <span class="count" id="n-queue">–</span></button>
<button class="tab" role="tab" type="button" id="tab-traces" data-tab="traces" aria-controls="main" tabindex="-1">Traces <span class="count" id="n-traces">–</span></button>
<button class="tab" role="tab" type="button" id="tab-health" data-tab="health" aria-controls="main" tabindex="-1">Health <span class="dot" id="d-health"></span></button>
</nav></div>
<main id="main" role="tabpanel" aria-labelledby="tab-inbox"><section class="calm"><p><b>Reading cambium and GitHub…</b></p><p class="muted">The first read of each repo's queues can take a few seconds.</p></section></main>
<script>${JS}</script>
</body>
</html>
`
