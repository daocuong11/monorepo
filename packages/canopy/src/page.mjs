// @ts-check

const CSS = `
:root{color-scheme:light dark;--bg:#f7f7f5;--panel:#fff;--line:#e4e4e0;--text:#1d1d1b;--muted:#5f5f5a;--faint:#72726c;
--ok:#2f7d4f;--warn:#a5670a;--err:#b42f2f;--accent:#2f5f9e;--chip:#efefeb;--bar:#dcdcd6;
--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1c1c1a;--line:#2e2e2b;--text:#e6e6e1;--muted:#b0b0aa;--faint:#8a8a84;
--ok:#6cc08b;--warn:#e0a44a;--err:#ec7b7b;--accent:#86aee6;--chip:#262624;--bar:#353532}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
::selection{background:color-mix(in srgb,var(--accent) 28%,transparent)}
a{color:var(--accent);text-decoration:none;text-underline-offset:2px}a:hover{text-decoration:underline}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
#top{position:sticky;top:0;z-index:1}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px var(--s4);padding:10px var(--s4);border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:14px;margin:0;font-weight:600}
.tabs{display:flex;gap:var(--s5);padding:0 var(--s4);border-bottom:1px solid var(--line);background:var(--panel);overflow-x:auto;scrollbar-width:none}
.tab{appearance:none;background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:9px 0 8px;font:inherit;font-weight:500;color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.tab:hover{color:var(--text)}.tab[aria-selected=true]{color:var(--text);border-bottom-color:var(--text);font-weight:600}
.tab:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:3px}
.tab .count{min-width:18px;padding:0 6px;border-radius:9px;background:var(--chip);color:var(--muted);font-size:12px;font-weight:500;text-align:center}
.tab .count.attn{background:color-mix(in srgb,var(--warn) 20%,transparent);color:var(--warn);font-weight:600}
.tab .dot{margin:0}
main{padding:var(--s4) var(--s4) var(--s5);display:grid;gap:var(--s4);max-width:1600px}
.inbox{list-style:none;margin:0;padding:0}
.inbox li{padding:var(--s3) 0;border-top:1px solid var(--line)}.inbox li:first-child{border-top:0;padding-top:var(--s1)}
.inbox .title{font-size:14px;font-weight:500;overflow-wrap:anywhere}.inbox .title .faint{font-weight:400}
.inbox .why{display:inline-block;padding:0 7px;border-radius:9px;font-size:12px;font-weight:600;color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}
.inbox .meta{margin-top:var(--s1);align-items:center}
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
.sp .track i{position:absolute;top:2px;height:8px;border-radius:2px;background:var(--accent);min-width:2px}
.sp .track i.wait{background:var(--faint)}.sp .track i.err{background:var(--err)}
.sp .d{text-align:right;color:var(--muted)}
.attrs{margin:0;padding:var(--s2) 0 var(--s3) var(--s4);display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px var(--s3);font-size:12px}
.attrs dt{color:var(--muted)}.attrs dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
@media (max-width:1100px){.cols{grid-template-columns:repeat(4,minmax(0,1fr))}.detail{grid-template-columns:1fr}
.col.prs{grid-column:1/-1;border-left:0;padding-left:0;border-top:1px solid var(--line);padding-top:var(--s3)}}
@media (max-width:760px){.cols{grid-template-columns:repeat(2,minmax(0,1fr))}
.sp,.wf-axis{grid-template-columns:minmax(0,1fr) 56px}.sp .track,.wf-axis .ticks{grid-column:1/-1;order:3}.wf-axis>span:not(.ticks){display:none}}
@media (max-width:480px){main{padding:var(--s3) var(--s3) var(--s5);gap:var(--s3)}section{padding:var(--s3)}.cols{grid-template-columns:1fr}
.tabs{padding:0 var(--s3);gap:var(--s4)}}
`

const JS = `
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

function inbox(s, now) {
  const gh = s.github, xs = gh.columns.human, multi = isMulti(gh)
  const failed = gh.repos.filter((r) => !r.ok).map((r) => r.slug)
  const calm = (title, ...rest) => h('section', { class: 'calm' }, h('p', {}, h('b', {}, title)), h('p', { class: 'muted' }, ...rest))
  if (!xs.length && !gh.repos.length) return calm('No repositories to read.', "Pass --repo owner/name to canopy, or list repos in cambium's config.")
  if (!xs.length && failed.length) return calm('The inbox may be incomplete.', 'GitHub read failed for ' + failed.join(', ') + '; see the error above.')
  if (!xs.length) return calm('Nothing needs you.',
    plural(inFlight(gh), 'issue', 'issues') + ' queued · ' + plural(gh.prs.length, 'agent PR', 'agent PRs') + ' open · ',
    h('button', { class: 'linkish', type: 'button', 'data-go': 'queue' }, 'see the queue'))
  return h('section', { class: 'attn' }, h('h2', {}, 'Needs you', h('span', { class: 'n' }, xs.length), h('span', { class: 'lane-label mono' }, 'q:human')),
    h('ul', { class: 'inbox' }, xs.map((i) => h('li', {},
      link(i.url, h('span', { class: 'title', title: i.title }, h('span', { class: 'faint' }, '#' + i.number + ' '), i.title)),
      h('div', { class: 'meta' },
        i.why ? h('span', { class: 'why' }, 'why:' + i.why) : h('span', { class: 'faint' }, 'no why: label'),
        i.priority ? h('span', {}, 'priority:' + i.priority) : null,
        multi ? h('span', {}, i.repo) : null,
        h('span', { class: 'faint', title: i.updatedAt || i.createdAt || '' }, ago(i.updatedAt || i.createdAt, now)),
        traceLink(i.repo, i.number))))))
}

function queues(s, now) {
  const gh = s.github, multi = isMulti(gh)
  const col = (title, label, xs, render, cls) => h('div', { class: 'col' + (cls ? ' ' + cls : '') },
    h('h2', {}, title, h('span', { class: 'n' }, xs.length), label ? h('span', { class: 'lane-label mono' }, label) : null), list(xs, render, multi, now))
  return h('section', {}, h('div', { class: 'cols' },
    LANES.map(([k, title, label]) => col(title, label, gh.columns[k], item)), col('Agent PRs', 'agent/*', gh.prs, pr, 'prs')))
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
  if (a['claude.model']) return [a['claude.model'], a['claude.cost_usd'] != null ? usd(a['claude.cost_usd']) : null]
  if (a['mycelium.source']) return [a['mycelium.source'], a['mycelium.action']]
  if (a['cambium.graph']) return [a['cambium.graph']]
  return []
}
const showValue = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
let openSpans = new Set()

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
    const bar = [sp.name === 'cambium.wait' ? 'wait' : '', sp.status === 'error' ? 'err' : ''].join(' ').trim()
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
  return h('section', {}, head, h('div', { class: 'wf' }, axis, rows), traceFileNote(d))
}

function tracesTab(now) {
  if (!traceState || traceState.key !== traceKey()) return section('Traces', null, h('div', { class: 'empty' }, 'reading traces…'))
  if (traceState.error) return h('div', { class: 'banner err' }, h('b', {}, traceSel ? "Can't load this trace: " : "Can't load traces: "), traceState.error,
    traceSel ? [' · ', h('a', { href: '#traces' }, 'all runs')] : null)
  return traceSel ? traceView(traceState.data) : runsView(traceState.data, now)
}

const TABS = ['inbox', 'queue', 'traces', 'health']
const parseHash = () => {
  const [t, id] = location.hash.slice(1).split('/')
  return TABS.includes(t) ? [t, t === 'traces' && /^[0-9a-f]{32}$/.test(id || '') ? id : null] : ['inbox', null]
}
let [tab, traceSel] = parseHash(), last = null, traceState = null
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

function tabs(s) {
  const human = s.github.columns.human.length, queued = inFlight(s.github), [tone, why] = healthOf(s)
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
  history.replaceState(null, '', '#' + t)
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
  const sp = e.target.closest('[data-span]')
  if (!sp) return
  const id = sp.dataset.span
  if (openSpans.has(id)) openSpans.delete(id)
  else openSpans.add(id)
  if (last) render(last)
  document.querySelector('[data-span="' + id + '"]')?.focus({ preventScroll: true })
})
addEventListener('hashchange', async () => {
  const before = traceSel
  ;[tab, traceSel] = parseHash()
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
  if (tab === 'inbox') body.push(inbox(s, now))
  if (tab === 'queue') body.push(queues(s, now))
  if (tab === 'traces') body.push(tracesTab(now))
  if (tab === 'health') {
    if (d) body.push(summary(d), h('div', { class: 'detail' }, workers(d, s.heartbeat.ageMs), events(d)))
    else body.push(section('Health', null, h('div', { class: 'empty' }, 'Ticks, workers and events appear once cambium writes a readable heartbeat; see the message above.')))
  }
  tabs(s)
  const focused = document.activeElement, href = focused && focused.getAttribute && focused.getAttribute('href')
  const scrolled = [...document.querySelectorAll('.events,.scroll')].map((el) => [el.className, el.scrollTop, el.scrollLeft])
  $('head').replaceChildren(header(s, now))
  $('main').replaceChildren(...body)
  document.body.classList.remove('down')
  for (const [cls, top, left] of scrolled) {
    const el = document.getElementsByClassName(cls)[0]
    if (el) Object.assign(el, { scrollTop: top, scrollLeft: left })
  }
  if (href) [...document.querySelectorAll('a')].find((a) => a.getAttribute('href') === href)?.focus({ preventScroll: true })
  else if (focused && focused.classList && (focused.classList.contains('events') || focused.classList.contains('scroll'))) document.getElementsByClassName(focused.className)[0]?.focus({ preventScroll: true })
  const human = s.github.columns.human.length
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
