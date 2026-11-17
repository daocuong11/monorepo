// @ts-check

const CSS = `
:root{color-scheme:light dark;--bg:#f7f7f5;--panel:#fff;--line:#e4e4e0;--text:#1d1d1b;--muted:#6b6b66;--faint:#9a9a94;
--ok:#2f7d4f;--warn:#a5670a;--err:#b42f2f;--accent:#2f5f9e;--chip:#efefeb;--bar:#dcdcd6}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1c1c1a;--line:#2e2e2b;--text:#e6e6e1;--muted:#a0a09a;--faint:#6f6f69;
--ok:#6cc08b;--warn:#e0a44a;--err:#ec7b7b;--accent:#86aee6;--chip:#262624;--bar:#353532}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 16px;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:14px;margin:0;font-weight:600}
main{padding:12px 16px;display:grid;gap:12px;max-width:1600px}
section{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px 12px;min-width:0}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 6px;font-weight:600}
h2 .n{color:var(--faint);margin-left:4px}
.muted{color:var(--muted)}.faint{color:var(--faint)}.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}
.pill{display:inline-block;padding:0 7px;border-radius:9px;background:var(--chip);font-size:12px}
.pill.ok{background:color-mix(in srgb,var(--ok) 16%,transparent)}.pill.warn{background:color-mix(in srgb,var(--warn) 18%,transparent)}
.pill.err{background:color-mix(in srgb,var(--err) 16%,transparent)}
.banner{padding:8px 12px;border-radius:6px;border:1px solid var(--line);background:var(--panel)}
.banner.err{border-color:color-mix(in srgb,var(--err) 45%,var(--line))}.banner.warn{border-color:color-mix(in srgb,var(--warn) 45%,var(--line))}
.row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
.stats{display:flex;flex-wrap:wrap;gap:4px 18px}.stat b{font-size:16px;font-weight:600;margin-right:4px}
.steps{display:flex;flex-wrap:wrap;gap:4px}
.cols{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}
.col{min-width:0}.col ul{list-style:none;margin:0;padding:0}
.col li{padding:5px 0;border-top:1px solid var(--line)}.col li:first-child{border-top:0}
.t{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:2px 8px}
.empty{color:var(--faint);font-size:12px}
table{border-collapse:collapse;width:100%}th{text-align:left;font-weight:500;color:var(--muted);font-size:12px}
td,th{padding:4px 10px 4px 0;border-top:1px solid var(--line);vertical-align:top;white-space:nowrap}tr.logs td{border-top:0;padding-top:0;white-space:normal;overflow-wrap:anywhere}.scroll{overflow-x:auto}thead th{border-top:0}
.bar{display:inline-block;width:80px;height:6px;background:var(--bar);border-radius:3px;vertical-align:middle;overflow:hidden;margin-right:6px}
.bar i{display:block;height:100%;background:var(--ok)}.bar i.warn{background:var(--warn)}.bar i.err{background:var(--err)}
.events{max-height:320px;overflow:auto}.events div{display:grid;grid-template-columns:62px 40px minmax(0,1fr);gap:8px;padding:2px 0}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--faint);margin-right:5px}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.err{background:var(--err)}
@media (max-width:1100px){.cols{grid-template-columns:repeat(3,minmax(0,1fr))}.row{grid-template-columns:1fr}}
@media (max-width:640px){.cols{grid-template-columns:1fr}}
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
const CHECK = { SUCCESS: ['ok', 'green'], FAILURE: ['err', 'red'], ERROR: ['err', 'error'], PENDING: ['warn', 'pending'], EXPECTED: ['warn', 'expected'] }

function header(s, now) {
  const hb = s.heartbeat, d = hb.data
  const kids = [h('h1', {}, 'canopy')]
  if (d) {
    kids.push(h('span', { class: 'pill ' + (MODE[d.mode] || '') }, d.mode))
    kids.push(h('span', { class: 'muted' }, d.host || '?', d.pid ? ' · pid ' + d.pid : ''))
    kids.push(h('span', { class: hb.stale ? 'warn' : 'muted' }, 'tick ', d.tick.n ?? '–', ' · ', ago(d.tick.finishedAt, now), d.tick.durationMs != null ? ' · took ' + dur(d.tick.durationMs) : ''))
    if (d.tick.nextAt && !hb.stale) {
    const left = Date.parse(d.tick.nextAt) - now
    kids.push(h('span', { class: 'faint' }, left > 0 ? 'next in ' + dur(left) : 'next tick due'))
  }
  }
  const gh = s.github
  kids.push(h('span', { class: 'faint', style: 'margin-left:auto' }, 'GitHub ', gh.fetchedAt ? ago(gh.fetchedAt, now) : '–', s.cacheMs ? ' (cached ' + dur(s.cacheMs) + ')' : ''))
  return h('header', {}, kids)
}

function banners(s) {
  const out = []
  const hb = s.heartbeat
  if (hb.status !== 'ok') out.push(h('div', { class: 'banner err' }, h('b', {}, 'Heartbeat ' + hb.status + ': '), hb.message))
  else if (hb.stale) out.push(h('div', { class: 'banner warn' }, h('b', {}, 'Stale: '), hb.message))
  for (const r of s.github.repos) if (!r.ok) out.push(h('div', { class: 'banner err' }, h('b', {}, r.slug + ': '), r.error))
  for (const r of (hb.data && hb.data.repos) || []) if (!r.ok) out.push(h('div', { class: 'banner warn' }, h('b', {}, 'cambium read ' + r.slug + ': '), r.error || 'failed'))
  for (const n of s.notes || []) out.push(h('div', { class: 'banner' }, n))
  return out
}

function summary(d) {
  const c = d.counts, caps = d.caps
  const stat = (label, v, extra) => h('span', { class: 'stat' }, h('b', {}, v ?? '–'), h('span', { class: 'muted' }, label), extra ? h('span', { class: 'faint' }, ' ' + extra) : null)
  const live = d.workers.filter((w) => w.alive && w.phase === 'task').length
  const stats = h('div', { class: 'stats' },
    stat('intake', c.intake), stat('task', c.task), stat('running', c.running), stat('human', c.human),
    stat('promote', c.promote), stat('review', c.review), stat('workers', c.workers, caps.task != null ? '(task ' + live + '/' + caps.task + (caps.dispatch ? ', dispatch cap ' + caps.dispatch : '') + ')' : null))
  const steps = h('div', { class: 'steps' }, d.steps.length ? d.steps.map((st) =>
    h('span', { class: 'pill ' + (st.ok ? 'ok' : 'err'), title: st.error || '' }, st.name, ' ', h('span', { class: 'faint' }, st.ms != null ? st.ms + 'ms' : ''))) : h('span', { class: 'empty' }, 'no steps recorded'))
  const errs = d.steps.filter((st) => !st.ok && st.error).map((st) => h('div', { class: 'err mono' }, st.name + ': ' + st.error))
  return h('div', { class: 'row' }, section('Counts', null, stats), section('Last tick steps', null, steps, errs))
}

function item(i, multi, now) {
  return h('li', {},
    link(i.url, h('span', { class: 't', title: i.title }, h('span', { class: 'faint' }, '#' + i.number + ' '), i.title)),
    h('div', { class: 'meta' },
      multi ? h('span', {}, i.repo) : null,
      i.why ? h('span', { class: 'warn' }, 'why:' + i.why) : null,
      i.priority ? h('span', {}, i.priority) : null,
      h('span', { class: 'faint' }, ago(i.updatedAt || i.createdAt, now))))
}

function pr(p, multi, now) {
  const [cls, word] = CHECK[p.checks] || ['', 'no checks']
  return h('li', {},
    link(p.url, h('span', { class: 't', title: p.title }, h('span', { class: 'faint' }, '#' + p.number + ' '), p.title)),
    h('div', { class: 'meta' },
      h('span', {}, h('span', { class: 'dot ' + cls }), word),
      p.inMergeQueue ? h('span', { class: 'ok' }, 'in queue') : p.autoMerge ? h('span', {}, 'auto-merge') : null,
      p.draft ? h('span', { class: 'faint' }, 'draft') : null,
      p.closes.length ? h('span', {}, 'closes ' + p.closes.map((n) => '#' + n).join(' ')) : null,
      multi ? h('span', {}, p.repo) : null,
      h('span', { class: 'faint mono' }, p.branch)))
}

function queues(s, now) {
  const gh = s.github, multi = new Set(gh.repos.map((r) => r.slug)).size > 1
  const col = (title, list, render) => h('div', { class: 'col' }, h('h2', {}, title, h('span', { class: 'n' }, list.length)),
    list.length ? h('ul', {}, list.map((x) => render(x, multi, now))) : h('div', { class: 'empty' }, 'empty'))
  return h('section', {}, h('div', { class: 'cols' },
    col('Intake', gh.columns.intake, item), col('Task', gh.columns.task, item), col('Running', gh.columns.running, item),
    col('Human', gh.columns.human, item), col('Promote', gh.columns.promote, item), col('Agent PRs', gh.prs, pr)))
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
      h('td', {}, link(issueUrl, (w.repo || '') + '#' + (w.issue ?? '?'))),
      h('td', {}, w.phase || '–'), h('td', {}, w.attempt ?? '–'),
      h('td', {}, h('span', { class: 'dot ' + (w.alive ? 'ok' : 'err') }), w.pid ?? '–', w.killedReason ? h('span', { class: 'err' }, ' killed: ' + w.killedReason) : null),
      h('td', {}, h('span', { class: 'bar' }, h('i', { class: tone, style: 'width:' + Math.round(frac * 100) + '%' })), dur(elapsed), h('span', { class: 'faint' }, ' / ' + dur(w.wallClockMs))),
      h('td', { class: 'mono' }, w.branch || '–')),
      logs.length ? h('tr', { class: 'logs' }, h('td', { colspan: 6, class: 'mono faint' }, logs.map((l) => h('div', {}, l)))) : null]
  })
  return section('Workers', d.workers.length, h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, ['issue', 'phase', 'attempt', 'pid', 'elapsed / cap', 'branch'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows))))
}

function events(d) {
  const list = d.events.slice(-60).reverse()
  return section('Recent events', d.events.length, list.length ? h('div', { class: 'events mono' }, list.map((e) => {
    const t = e.at ? new Date(e.at) : null
    return h('div', {}, h('span', { class: 'faint', title: e.at || '' }, t ? t.toLocaleTimeString([], { hour12: false }) : '–'),
      h('span', { class: e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : 'faint' }, e.level || ''),
      h('span', {}, e.repo && e.issue ? h('span', { class: 'faint' }, e.repo.split('/')[1] + '#' + e.issue + ' ') : null, e.msg || ''))
  })) : h('div', { class: 'empty' }, 'no events'))
}

function render(s) {
  const now = Date.parse(s.now) || Date.now()
  const d = s.heartbeat.data
  const body = [...banners(s)]
  if (d) body.push(summary(d))
  body.push(queues(s, now))
  if (d) body.push(h('div', { class: 'row' }, workers(d, s.heartbeat.ageMs), events(d)))
  $('top').replaceChildren(header(s, now))
  $('main').replaceChildren(...body)
  document.title = 'canopy' + (d ? ' · ' + d.mode : '') + (s.heartbeat.stale ? ' · stale' : '')
}

let pollMs = 5000
async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' })
    const s = await r.json()
    if (!r.ok) throw new Error(s.error || r.status)
    pollMs = s.pollMs || pollMs
    render(s)
  } catch (err) {
    $('down')?.remove()
    $('main').prepend(h('div', { id: 'down', class: 'banner err' },'canopy server unreachable: ' + (err && err.message)))
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
<div id="top"><header><h1>canopy</h1><span class="faint">loading…</span></header></div>
<main id="main"></main>
<script>${JS}</script>
</body>
</html>
`
