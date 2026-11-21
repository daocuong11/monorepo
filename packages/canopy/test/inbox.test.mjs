// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cachedIssues } from '../src/github.mjs'
import { facetsOf, groupOf, inboxGroups, inboxItems, inboxStats, priorityRank, viewOf } from '../src/inbox.mjs'
import { issueDetail } from '../src/issue.mjs'
import { markdown } from '../src/markdown.mjs'
import { iso, T0 } from './fixtures.mjs'

const REPO = 'oakgreencc/monorepo'

const item = (/** @type {number} */ number, /** @type {string[]} */ labels, /** @type {number} */ agoMin) => ({
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/${REPO}/issues/${number}`,
  createdAt: iso(T0 - 86_400_000),
  updatedAt: iso(T0 - agoMin * 60_000),
  labels,
  why: labels.find((l) => l.startsWith('why:'))?.slice(4) ?? null,
  priority: labels.find((l) => l.startsWith('priority:'))?.slice(9) ?? null,
})

const gh = () => ({
  columns: {
    human: [
      item(1, ['q:human', 'why:budget', 'priority:low'], 5),
      item(2, ['q:human', 'why:triage', 'priority:critical', 'bug'], 50),
      item(3, ['q:human', 'why:budget', 'priority:high'], 30),
      item(4, ['q:human', 'why:approve'], 1),
    ],
  },
  stranded: [
    {
      ...item(9, ['priority:high'], 999),
      pr: { number: 90, title: 'x', url: '', branch: 'agent/issue-9', closedAt: iso(T0 - 10 * 60_000) },
    },
  ],
})

const keys = (/** @type {{ number: number }[]} */ xs) => xs.map((x) => x.number)

test('inboxItems: q:human and stranded as one list, tagged by facet; stranded dated by the PR close', () => {
  const xs = inboxItems(gh())
  assert.deepEqual(keys(xs), [1, 2, 3, 4, 9])
  assert.deepEqual(xs[1].tags, ['kind:human', 'why:triage', 'priority:critical', `repo:${REPO}`, 'label:bug'])
  const s = /** @type {any} */ (xs[4])
  assert.equal(s.kind, 'stranded')
  assert.equal(s.key, `${REPO}#9`)
  assert.equal(s.at, s.pr.closedAt)
})

test('inboxGroups: by what answering takes, in a fixed order; items with no ask still show', () => {
  const xs = inboxItems({
    columns: {
      human: [
        item(11, ['q:human', 'why:triage', 'ask:decide', 'ask:session'], 1),
        item(12, ['q:human', 'why:triage', 'ask:decide'], 2),
        item(13, ['q:human', 'why:triage', 'ask:chore'], 3),
        item(14, ['q:human', 'why:rescue', 'ask:verify', 'ask:session'], 4),
        item(15, ['q:human', 'why:approve'], 5),
        item(16, ['q:human', 'why:budget'], 6),
        item(17, ['q:human', 'why:triage'], 7),
        item(18, ['q:human'], 8),
        item(19, ['q:human', 'why:triage', 'ask:decide'], 9),
      ],
    },
    stranded: gh().stranded,
  })
  assert.deepEqual(
    xs.map((x) => groupOf(x)),
    ['session', 'comment', 'chores', 'chores', 'approvals', 'session', 'other', 'other', 'comment', 'stranded'],
  )
  const groups = inboxGroups(viewOf(xs, { sort: 'newest', tags: new Set() }))
  assert.deepEqual(
    groups.map((g) => [g.label, keys(g.items)]),
    [
      ['Needs a session', [11, 16]],
      ['Answer in a comment', [12, 19]],
      ['Offline chores', [13, 14]],
      ['Approvals', [15]],
      ['Other', [17, 18]],
      ['PR closed', [9]],
    ],
  )
  assert.equal(groups.flatMap((g) => g.items).length, xs.length, 'every item is in one group')
  assert.deepEqual(
    inboxGroups(inboxItems(gh())).map((g) => g.id),
    ['session', 'approvals', 'other', 'stranded'],
    'empty groups are left out',
  )
})

test('viewOf sorts newest, oldest, or by priority (then newest)', () => {
  const xs = inboxItems(gh())
  assert.deepEqual(keys(viewOf(xs, { sort: 'newest', tags: new Set() })), [4, 1, 9, 3, 2])
  assert.deepEqual(keys(viewOf(xs, { sort: 'oldest', tags: new Set() })), [2, 3, 9, 1, 4])
  assert.deepEqual(keys(viewOf(xs, { sort: 'priority', tags: new Set() })), [2, 9, 3, 1, 4])
  assert.deepEqual([priorityRank('critical'), priorityRank('p0'), priorityRank(null)], [0, 4, 5])
})

test('viewOf: tags in one facet widen, across facets narrow', () => {
  const xs = inboxItems(gh())
  const v = (/** @type {string[]} */ tags) => keys(viewOf(xs, { sort: 'newest', tags: new Set(tags) }))
  assert.deepEqual(v(['why:budget']), [1, 3])
  assert.deepEqual(v(['why:budget', 'why:approve']), [4, 1, 3])
  assert.deepEqual(v(['why:budget', 'priority:high']), [3])
  assert.deepEqual(v(['kind:stranded']), [9])
  assert.deepEqual(v(['label:nope']), [])
})

test('inboxStats: reasons and priorities in a fixed order, ages by creation, oldest', () => {
  const xs = inboxItems(gh())
  const born = [0.5, 3, 20, 40, 1]
  xs.forEach((x, i) => {
    x.createdAt = iso(T0 - born[i] * 86_400_000)
  })
  xs[3].why = null
  const st = inboxStats(xs, T0)
  const parts = (/** @type {{ label: string, n: number, tag: string | null }[]} */ ps) =>
    ps.map((p) => `${p.label}:${p.n}${p.tag ? '' : '-'}`)
  assert.equal(st.total, 5)
  assert.deepEqual(parts(st.reasons), ['budget:2', 'triage:1', 'no why::1-', 'PR closed:1'])
  assert.deepEqual(parts(st.priorities), ['critical:1', 'high:2', 'low:1', 'none:1-'])
  assert.deepEqual(parts(st.opened), ['under 1d:1-', '1–7d:2-', '1–4w:1-', 'over 4w:1-'])
  assert.equal(st.oldest, xs[3].createdAt)
  assert.deepEqual(parts(st.repos), [`${REPO}:5`])
  assert.deepEqual(parts(inboxStats([], T0).opened), ['under 1d:0-', '1–7d:0-', '1–4w:0-', 'over 4w:0-'])
})

test('facetsOf offers only tags that narrow, keeps selected ones at zero, orders priorities by urgency', () => {
  const xs = inboxItems(gh())
  const f = facetsOf(xs, new Set(['label:gone']))
  const by = Object.fromEntries(f.map((x) => [x.facet, x.tags.map((t) => `${t.value}:${t.n}${t.on ? '*' : ''}`)]))
  assert.equal(by.repo, undefined, 'one repo: every item has it, so it filters nothing')
  assert.deepEqual(by.kind, ['human:4', 'stranded:1'])
  assert.deepEqual(by.priority, ['critical:1', 'high:2', 'low:1'])
  assert.deepEqual(by.why, ['budget:2', 'approve:1', 'triage:1'])
  assert.deepEqual(by.label, ['bug:1', 'gone:0*'])
})

/** A plain-object stand-in for the page's element builder. */
const h = (/** @type {string} */ tag, /** @type {any} */ attrs, /** @type {any[]} */ ...kids) => ({
  tag,
  attrs: Object.fromEntries(Object.entries(attrs ?? {}).filter(([, v]) => v != null)),
  kids: kids.flat(Number.POSITIVE_INFINITY).filter((k) => k != null && k !== false),
})
/** @returns {any[]} */
const all = (/** @type {any} */ n) => (typeof n === 'string' ? [] : [n, ...n.kids.flatMap(all)])
const text = (/** @type {any} */ n) => (typeof n === 'string' ? n : n.kids.map(text).join(''))
const render = (/** @type {string} */ src) => markdown(src, h, { repo: REPO })
const find = (/** @type {any[]} */ nodes, /** @type {string} */ tag) => nodes.flatMap(all).filter((n) => n.tag === tag)

test('markdown: cambium state comment renders without its marker', () => {
  const nodes = render(
    [
      '<!-- cambium:state {"v":2,"node":"to-human"} -->',
      '**cambium** · task · to-human · attempt 3/3 · PR #41',
      '',
      '<details><summary>Last failure</summary>',
      '',
      '```',
      'Error: a | b',
      '```',
      '</details>',
      '',
      '| at | outcome |',
      '|---|---:|',
      '| 2026-11-16 | failed |',
    ].join('\n'),
  )
  assert.doesNotMatch(nodes.map(text).join(), /cambium:state/)
  assert.deepEqual(
    nodes.map((n) => n.tag),
    ['p', 'details', 'div'],
  )
  assert.equal(text(find(nodes, 'summary')[0]), 'Last failure')
  assert.equal(text(find(nodes, 'pre')[0]), 'Error: a | b')
  assert.deepEqual(find(nodes, 'td').map(text), ['2026-11-16', 'failed'])
  assert.equal(find(nodes, 'td')[1].attrs.style, 'text-align:right')
  assert.equal(find(nodes, 'a')[0].attrs.href, `https://github.com/${REPO}/issues/41`)
})

test('markdown: lists, tasks, quotes, inline marks and hard breaks', () => {
  const nodes = render('- [x] done\n- [ ] todo\n  - nested `code`\n\n> quoted\n\n**b** _e_ ~~d~~ \\*lit\\*\nnext line')
  assert.deepEqual(
    nodes.map((n) => n.tag),
    ['ul', 'blockquote', 'p'],
  )
  const boxes = find(nodes, 'input')
  assert.deepEqual(
    boxes.map((b) => 'checked' in b.attrs),
    [true, false],
  )
  assert.equal(text(find(nodes, 'ul')[1]), 'nested code')
  const p = nodes[2]
  assert.deepEqual(
    p.kids.filter((/** @type {any} */ k) => typeof k !== 'string').map((/** @type {any} */ k) => k.tag),
    ['strong', 'em', 'del', 'br'],
  )
  assert.match(text(p), /\*lit\*/)
})

test('markdown: only http(s) links; images become links; raw HTML stays text', () => {
  const nodes = render(
    '[ok](https://example.com) [bad](javascript:alert(1)) ![shot](https://img.example/x.png) <img src=x onerror=alert(1)> see owner/repo#7 and @someone',
  )
  const links = find(nodes, 'a').map((a) => [a.attrs.href, text(a)])
  assert.deepEqual(links, [
    ['https://example.com', 'ok'],
    ['https://img.example/x.png', 'image: shot'],
    ['https://github.com/owner/repo/issues/7', 'owner/repo#7'],
    ['https://github.com/someone', '@someone'],
  ])
  assert.equal(find(nodes, 'img').length, 0)
  assert.match(text(nodes[0]), /<img src=x onerror=alert\(1\)>/)
})

const c = (/** @type {string} */ body, /** @type {number} */ n) => ({
  url: `https://github.com/${REPO}/issues/4#issuecomment-${n}`,
  body,
  createdAt: iso(T0 + n * 1000),
  updatedAt: iso(T0 + n * 1000),
  author: { login: n === 1 ? 'cambium[bot]' : 'me' },
})

test('issueDetail pins the state comment and keeps the newest others, counting what it leaves out', () => {
  const head = [
    c('<!-- cambium:state {} -->\n**cambium**', 1),
    ...Array.from({ length: 49 }, (_, i) => c(`old ${i}`, i + 2)),
  ]
  const tail = Array.from({ length: 20 }, (_, i) => c(`new ${i}`, 100 + i))
  const answer = {
    data: {
      repository: {
        issue: {
          number: 4,
          title: 'T',
          url: `https://github.com/${REPO}/issues/4`,
          state: 'OPEN',
          body: 'b',
          author: { login: 'me' },
          labels: { nodes: [{ name: 'q:human' }] },
          head: { totalCount: 75, nodes: head },
          tail: { nodes: tail },
        },
      },
    },
  }
  const d = /** @type {import('../src/issue.mjs').IssueDetail} */ (issueDetail(answer, REPO, 4))
  assert.equal(d.status?.author, 'cambium[bot]')
  assert.equal(d.comments.length, 10)
  assert.equal(d.comments[9].body, 'new 19')
  assert.equal(d.earlier, 74 - 10)
  assert.deepEqual(d.labels, ['q:human'])
  assert.equal(issueDetail({ repository: { issue: null } }, REPO, 5), null)
  assert.throws(() => issueDetail({}, REPO, 5), /no repository/)
})

test('cachedIssues: one fetch per ttl, the last good answer kept beside a failed refresh', async () => {
  let t = T0
  let fail = false
  let calls = 0
  const client = {
    queues: async () => assert.fail('not used'),
    issue: async (/** @type {string} */ slug, /** @type {number} */ n) => {
      calls++
      if (fail) throw new Error('graft: 502')
      return /** @type {any} */ ({ repo: slug, number: n, title: `#${n}` })
    },
  }
  const cache = cachedIssues({ client, now: () => t })
  const a = await cache.get(REPO, 4)
  await cache.get(REPO, 4)
  assert.equal(calls, 1)
  assert.equal(a.issue?.title, '#4')
  t += 16_000
  fail = true
  const b = await cache.get(REPO, 4)
  assert.equal(b.issue?.title, '#4')
  assert.equal(b.error, 'graft: 502')
  await assert.rejects(cache.get(REPO, 5), /502/)
})
