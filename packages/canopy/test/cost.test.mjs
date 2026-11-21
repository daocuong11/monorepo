// @ts-check
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { costByDay, costIndex, withCosts } from '../src/cost.mjs'
import { cachedQueues } from '../src/github.mjs'
import { judge } from '../src/heartbeat.mjs'
import { facetsOf, inboxGroups, inboxItems, inboxStats } from '../src/inbox.mjs'
import { PAGE } from '../src/page.mjs'
import { group } from '../src/queues.mjs'
import { buildState } from '../src/server.mjs'
import { graphqlAnswer, heartbeat, T0 } from './fixtures.mjs'

const REPO = 'oakgreencc/monorepo'

const tally = (/** @type {number} */ usd, runs = 1) => ({
  usd,
  input: 1,
  output: 1,
  cacheRead: 1,
  cacheCreation: 1,
  runs,
})
/** A heartbeat issue cost line as cambium writes it. */
const line = (
  /** @type {number} */ number,
  /** @type {Record<string, number>} */ by,
  flagged = false,
  labels = ['q:task'],
) => {
  const t = Object.values(by).reduce((n, v) => n + v, 0)
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    labels,
    cost: {
      total: tally(t, Object.keys(by).length),
      triage: tally(by.triage ?? 0, by.triage ? 1 : 0),
      task: tally(by.task ?? 0, by.task ? 1 : 0),
      rescue: tally(by.rescue ?? 0, by.rescue ? 1 : 0),
      lastLog: '/l/x.out.log',
    },
    flagged,
  }
}

const withCostRepos = () =>
  heartbeat({
    costFlagUsd: 10,
    repos: [
      {
        slug: REPO,
        ok: true,
        error: null,
        counts: null,
        cost: {
          issues: [
            line(2, { triage: 0.5, task: 3 }),
            line(4, { task: 1.25 }, false, ['q:human', 'why:budget']),
            line(17, { task: 14, triage: 0.5 }, true, ['q:task', 'priority:high']),
          ],
          days: [
            { day: '2026-11-15', triage: 0.5, task: 3, rescue: 0, total: 3.5 },
            { day: '2026-11-16', triage: 0.5, task: 15.25, rescue: 0.2, total: 15.95 },
            { day: '2026-11-01', triage: 9, task: 9, rescue: 9, total: 27 },
          ],
        },
      },
      {
        slug: 'oakgreencc/other',
        ok: true,
        error: null,
        counts: null,
        cost: { issues: [], days: [{ day: '2026-11-16', triage: 1, task: 0, rescue: 0, total: 1 }] },
      },
    ],
  })

test('the heartbeat keeps repos[].cost and costFlagUsd; an older one without them reads as none', () => {
  const d = judge(withCostRepos(), { now: T0 }).data
  assert.equal(d.costFlagUsd, 10)
  assert.equal(d.repos[0].cost.issues.length, 3)
  const old = judge(heartbeat(), { now: T0 }).data
  assert.deepEqual(old.repos[0].cost, { issues: [], days: [] })
  assert.equal(old.costFlagUsd, null)
})

test('costIndex and withCosts: items gain per-issue cost by phase; flagged ones outside the Inbox become candidates', () => {
  const d = judge(withCostRepos(), { now: T0 }).data
  assert.deepEqual(costIndex(d).get(`${REPO}#2`)?.cost, {
    usd: 3.5,
    triage: 0.5,
    task: 3,
    rescue: 0,
    runs: 2,
    flagged: false,
  })
  const gh = withCosts(group(graphqlAnswer(), REPO), d)
  const task2 = gh.columns.task.find((i) => i.number === 2)
  assert.equal(task2.cost.usd, 3.5)
  assert.equal(gh.columns.intake[0].cost, null, 'no cost reported')
  assert.equal(gh.columns.human[0].cost.task, 1.25)
  assert.deepEqual(
    gh.flagged.map((i) => [i.number, i.priority, i.cost.task, i.cost.flagged]),
    [[17, 'high', 14, true]],
  )
  assert.deepEqual(withCosts(group(graphqlAnswer(), REPO), null).flagged, [], 'no heartbeat: no costs')
})

test('a flagged issue already in q:human is tagged flag:cost there, not listed twice', () => {
  const d = judge(withCostRepos(), { now: T0 }).data
  d.repos[0].cost.issues[1].flagged = true // #4, in q:human
  const gh = withCosts(group(graphqlAnswer(), REPO), d)
  const items = inboxItems(gh)
  assert.deepEqual(
    items.map((i) => [i.number, i.kind]),
    [
      [4, 'human'],
      [7, 'stranded'],
      [17, 'cost'],
    ],
  )
  assert.ok(items[0].tags.includes('flag:cost'))
  assert.ok(!items[1].tags.includes('flag:cost'), 'the stranded #7 reports no cost')
  assert.deepEqual(items[2].tags.slice(0, 2), ['kind:cost', 'flag:cost'])
  const kinds = facetsOf(items, new Set()).find((f) => f.facet === 'kind')
  assert.deepEqual(
    kinds?.tags.map((t) => t.id),
    ['kind:human', 'kind:stranded', 'kind:cost'],
  )
  const flag = facetsOf(items, new Set()).find((f) => f.facet === 'flag')
  assert.deepEqual(
    flag?.tags.map((t) => [t.id, t.n]),
    [['flag:cost', 2]],
  )
  assert.deepEqual(
    inboxGroups(items).map((g) => [g.id, g.items.map((i) => i.number)]),
    [
      ['session', [4, 17]],
      ['stranded', [7]],
    ],
    'session candidates, and a flagged q:human issue, go under Needs a session',
  )
  const st = inboxStats(items, T0)
  assert.equal(st.total, 3)
  assert.deepEqual(st.reasons.at(-1), { key: 'why:~cost', label: 'over budget', n: 1, tag: 'kind:cost' })
})

test('costByDay: the last N UTC days summed over repos, by phase, with no gaps', () => {
  const d = judge(withCostRepos(), { now: T0 }).data
  assert.deepEqual(costByDay(d, T0, 3), [
    { day: '2026-11-14', triage: 0, task: 0, rescue: 0, total: 0 },
    { day: '2026-11-15', triage: 0.5, task: 3, rescue: 0, total: 3.5 },
    { day: '2026-11-16', triage: 1.5, task: 15.25, rescue: 0.2, total: 16.95 },
  ])
  assert.equal(costByDay(null, T0).length, 7)
})

test('/api/state carries item costs, session candidates and the per-day cost by phase', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'canopy-')), 'state.json')
  writeFileSync(path, JSON.stringify(withCostRepos()))
  const client = { queues: async (/** @type {string} */ slug) => group(graphqlAnswer(), slug) }
  const s = await buildState({
    statePath: path,
    repos: [REPO],
    queues: cachedQueues({ client, now: () => T0 }),
    now: () => T0,
  })
  assert.equal(s.github.columns.task.find((i) => i.number === 2)?.cost?.usd, 3.5)
  assert.deepEqual(
    s.github.flagged.map((i) => i.number),
    [17],
  )
  assert.equal(s.cost.flagUsd, 10)
  assert.equal(s.cost.days.length, 7)
  assert.equal(s.cost.days.at(-1)?.task, 15.25)
})

test('the page draws cost chips, the per-day cost figure and session candidates', () => {
  for (const s of ['function costChip', 'function costFigure', "'session candidate'", 'flaggedOf(gh)'])
    assert.ok(PAGE.includes(s), s)
})
