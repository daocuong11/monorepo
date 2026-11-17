// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cachedQueues, graftClient } from '../src/github.mjs'
import { columnOf, group, QUEUES_QUERY } from '../src/queues.mjs'
import { graphqlAnswer, T0 } from './fixtures.mjs'

const REPO = 'oakgreencc/monorepo'
const nums = (/** @type {{ number: number }[]} */ xs) => xs.map((x) => x.number)

test('columnOf: running wins over q:task; unqueued is null', () => {
  assert.equal(columnOf(['q:task', 'running']), 'running')
  assert.equal(columnOf(['q:task']), 'task')
  assert.equal(columnOf(['q:human', 'why:reject']), 'human')
  assert.equal(columnOf(['bug']), null)
})

test('group: issues into columns, why and priority read, agent PRs only', () => {
  const { columns, prs } = group(graphqlAnswer(), REPO)
  assert.deepEqual(nums(columns.intake), [1])
  assert.deepEqual(nums(columns.task), [2])
  assert.deepEqual(nums(columns.running), [3])
  assert.deepEqual(nums(columns.human), [4])
  assert.deepEqual(nums(columns.promote), [5])
  assert.equal(columns.human[0].why, 'budget')
  assert.equal(columns.task[0].priority, 'high')
  assert.equal(columns.task[0].url, 'https://github.com/oakgreencc/monorepo/issues/2')
  assert.deepEqual(nums(prs), [20, 22])
  assert.deepEqual(
    { checks: prs[0].checks, q: prs[0].inMergeQueue, auto: prs[0].autoMerge, closes: prs[0].closes },
    { checks: 'SUCCESS', q: true, auto: true, closes: [3] },
  )
  assert.deepEqual({ checks: prs[1].checks, draft: prs[1].draft }, { checks: null, draft: true })
})

test('group: accepts { data } and refuses an answer without a repository', () => {
  assert.equal(group({ data: graphqlAnswer() }, REPO).prs.length, 2)
  assert.throws(() => group({ data: null }, REPO), /no repository/)
})

test('graftClient shells out to graft graphql with the repo vars', async () => {
  /** @type {[string, string[]][]} */
  const calls = []
  const client = graftClient({
    bin: 'graft',
    exec: async (cmd, args) => {
      calls.push([cmd, args])
      return JSON.stringify(graphqlAnswer())
    },
  })
  const q = await client.queues(REPO)
  assert.equal(q.columns.running.length, 1)
  const [cmd, args] = calls[0]
  assert.equal(cmd, 'graft')
  assert.deepEqual(args.slice(0, 2), ['graphql', QUEUES_QUERY])
  const vars = JSON.parse(args[3])
  assert.deepEqual([vars.owner, vars.name], ['oakgreencc', 'monorepo'])
  assert.ok(vars.labels.includes('q:human') && vars.labels.includes('running'))
  assert.deepEqual(args.slice(4), ['--repo', REPO])
})

test('cache: one fetch per ttl however many reads, minimum 15 s', async () => {
  let t = T0
  let fetches = 0
  const client = {
    queues: async (/** @type {string} */ slug) => {
      fetches++
      return group(graphqlAnswer(), slug)
    },
  }
  const cache = cachedQueues({ client, ttlMs: 1000, now: () => t })
  assert.equal(cache.ttlMs, 15_000)
  const [a, b] = await Promise.all([cache.get([REPO]), cache.get([REPO])])
  assert.equal(fetches, 1)
  assert.equal(a.columns.task.length, 1)
  assert.equal(b.columns.task.length, 1)
  t += 14_999
  const hit = await cache.get([REPO])
  assert.equal(hit.cached, true)
  assert.equal(fetches, 1)
  t += 1
  const miss = await cache.get([REPO])
  assert.equal(miss.cached, false)
  assert.equal(fetches, 2)
})

test('cache: a failed refresh keeps the last good answer, with the error', async () => {
  let t = T0
  let fail = false
  const client = {
    queues: async (/** @type {string} */ slug) => {
      if (fail) throw new Error('rate limited')
      return group(graphqlAnswer(), slug)
    },
  }
  const cache = cachedQueues({ client, now: () => t })
  await cache.get([REPO])
  fail = true
  t += 20_000
  const v = await cache.get([REPO])
  assert.deepEqual(v.repos, [{ slug: REPO, ok: false, error: 'rate limited', fetchedAt: new Date(T0).toISOString() }])
  assert.equal(v.columns.task.length, 1)

  const fresh = cachedQueues({ client, now: () => t })
  const empty = await fresh.get([REPO])
  assert.equal(empty.repos[0].ok, false)
  assert.equal(empty.prs.length, 0)
})

test('cache: several repos are combined, oldest fetch time reported', async () => {
  const client = { queues: async (/** @type {string} */ slug) => group(graphqlAnswer(), slug) }
  const v = await cachedQueues({ client, now: () => T0 }).get([REPO, 'oakgreencc/other'])
  assert.equal(v.columns.task.length, 2)
  assert.deepEqual(
    v.columns.task.map((i) => i.repo),
    [REPO, 'oakgreencc/other'],
  )
  assert.equal(v.prs.length, 4)
  assert.equal(v.fetchedAt, new Date(T0).toISOString())
})
