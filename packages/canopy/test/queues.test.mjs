// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cachedQueues, graftClient } from '../src/github.mjs'
import { columnOf, group, QUEUES_QUERY, tallyOf } from '../src/queues.mjs'
import { graphqlAnswer, T0 } from './fixtures.mjs'

const REPO = 'oakgreencc/monorepo'
const nums = (/** @type {{ number: number }[]} */ xs) => xs.map((x) => x.number)

test('columnOf: running wins over q:task; unqueued is null', () => {
  assert.equal(columnOf(['q:task', 'running']), 'running')
  assert.equal(columnOf(['q:task']), 'task')
  assert.equal(columnOf(['q:human', 'why:reject']), 'human')
  assert.equal(columnOf(['bug']), null)
})

test('columnOf: a q:intake issue with wait:deferred or wait:blocked is waiting, not intake', () => {
  assert.equal(columnOf(['q:intake']), 'intake')
  assert.equal(columnOf(['q:intake', 'wait:deferred']), 'waiting')
  assert.equal(columnOf(['q:intake', 'wait:blocked']), 'waiting')
  assert.equal(columnOf(['q:intake', 'wait:deferred', 'running']), 'running', 'a running triage is running')
  assert.equal(columnOf(['q:task', 'wait:blocked']), 'task', 'wait:* only parks intake')
})

test('group: parked intake issues go to waiting with the defer reason and due time, or the open blockers', () => {
  const marker = { node: 'deferred', deferUntil: '2026-11-20T05:01:00.000Z', deferReason: 'next cd run on main' }
  const answer = {
    repository: {
      issues: {
        nodes: [
          { number: 1, title: 'untriaged', labels: { nodes: [{ name: 'q:intake' }] } },
          { number: 2, title: 'deferred', labels: { nodes: [{ name: 'q:intake' }, { name: 'wait:deferred' }] } },
          {
            number: 3,
            title: 'blocked',
            labels: { nodes: [{ name: 'q:intake' }, { name: 'wait:blocked' }] },
            blockedBy: {
              nodes: [
                { number: 8, title: 'API', url: 'https://github.com/o/r/issues/8', state: 'OPEN' },
                { number: 9, title: 'old', url: 'https://github.com/o/r/issues/9', state: 'CLOSED' },
              ],
            },
          },
        ],
      },
      waiting: {
        nodes: [
          {
            number: 2,
            comments: {
              nodes: [
                { body: 'a human comment' },
                { body: `<!-- cambium:state ${JSON.stringify(marker)} -->\n**cambium** · dispatch · deferred` },
              ],
            },
          },
          {
            number: 3,
            comments: {
              nodes: [
                { body: `<!-- cambium:state ${JSON.stringify({ node: 'blocked', deferReason: 'needs the API' })} -->` },
              ],
            },
          },
        ],
      },
    },
  }
  const { columns } = group(answer, 'o/r')
  assert.deepEqual(nums(columns.intake), [1], 'Intake holds only what awaits triage')
  assert.deepEqual(nums(columns.waiting), [2, 3])
  assert.equal(columns.intake[0].wait, undefined)
  assert.deepEqual(columns.waiting[0].wait, {
    kind: 'deferred',
    reason: 'next cd run on main',
    until: '2026-11-20T05:01:00.000Z',
    blockers: [],
  })
  assert.deepEqual(columns.waiting[1].wait, {
    kind: 'blocked',
    reason: 'needs the API',
    until: null,
    blockers: [{ number: 8, title: 'API', url: 'https://github.com/o/r/issues/8' }],
  })
  assert.match(QUEUES_QUERY, /blockedBy\(first: 20\)/)
  assert.match(QUEUES_QUERY, /waiting: issues\(labels: \["wait:deferred", "wait:blocked"\]/)
})

test('group: issues into columns, why and priority read, agent PRs only', () => {
  const { columns, prs } = group(graphqlAnswer(), REPO)
  assert.deepEqual(nums(columns.intake), [1])
  assert.deepEqual(nums(columns.task), [2])
  assert.deepEqual(nums(columns.running), [3])
  assert.deepEqual(nums(columns.human), [4])
  assert.deepEqual(nums(columns.promote), [5, 11], 'open first, then the closed ones awaiting promotion, once each')
  assert.equal(columns.human[0].why, 'budget')
  assert.equal(columns.task[0].priority, 'high')
  assert.equal(columns.task[0].url, 'https://github.com/oakgreencc/monorepo/issues/2')
  assert.deepEqual(nums(prs), [20, 22])
  assert.deepEqual(
    { checks: prs[0].checks, q: prs[0].inMergeQueue, auto: prs[0].autoMerge, closes: prs[0].closes },
    { checks: 'SUCCESS', q: true, auto: true, closes: [3] },
  )
  assert.deepEqual({ checks: prs[1].checks, draft: prs[1].draft }, { checks: null, draft: true })
  assert.deepEqual(
    {
      tally: prs[0].tally,
      queue: prs[0].queue,
      mergeState: prs[0].mergeState,
      size: [prs[0].additions, prs[0].deletions, prs[0].files],
    },
    {
      tally: { passed: 8, failed: 0, pending: 0 },
      queue: { position: 2, state: 'AWAITING_CHECKS' },
      mergeState: 'CLEAN',
      size: [424, 9, 8],
    },
  )
  assert.deepEqual(
    { tally: prs[1].tally, queue: prs[1].queue, mergeState: prs[1].mergeState, files: prs[1].files },
    { tally: null, queue: null, mergeState: null, files: null },
    'fields GitHub left out read as null',
  )
})

test('tallyOf: check runs and statuses together, skipped as passed, an unconcluded completed run left out', () => {
  assert.deepEqual(
    tallyOf({
      checkRunCountsByState: [
        { state: 'SUCCESS', count: 3 },
        { state: 'NEUTRAL', count: 1 },
        { state: 'IN_PROGRESS', count: 2 },
        { state: 'QUEUED', count: 1 },
        { state: 'FAILURE', count: 1 },
        { state: 'TIMED_OUT', count: 1 },
        { state: 'COMPLETED', count: 4 },
      ],
      statusContextCountsByState: [
        { state: 'PENDING', count: 1 },
        { state: 'ERROR', count: 1 },
      ],
    }),
    { passed: 4, failed: 3, pending: 4 },
  )
  assert.equal(tallyOf(null), null)
  assert.equal(tallyOf({ checkRunCountsByState: [] }), null)
})

test('the query asks for closed q:promote issues', () => {
  assert.match(QUEUES_QUERY, /awaiting: issues\(labels: \["q:promote"\], states: CLOSED/)
})

test('group: an open, unqueued issue whose agent PR closed unmerged is stranded, once, newest PR', () => {
  const { stranded } = group(graphqlAnswer(), REPO)
  // 7: stranded (newest PR #30 kept, #31 dropped); 8: closed; 2: requeued (q:task);
  // 9: an open agent PR (#22) still closes it; 10: not an agent branch.
  assert.deepEqual(nums(stranded), [7])
  assert.deepEqual(stranded[0].pr, {
    number: 30,
    title: 'closed 30',
    url: 'https://github.com/oakgreencc/monorepo/pull/30',
    branch: 'agent/issue-7',
    closedAt: new Date(T0 - 30 * 60_000).toISOString(),
  })
  assert.equal(stranded[0].priority, 'low')
  assert.equal(stranded[0].url, 'https://github.com/oakgreencc/monorepo/issues/7')
})

test('group: an answer without closed PRs strands nothing', () => {
  const a = graphqlAnswer()
  delete (/** @type {any} */ (a.repository).closed)
  assert.deepEqual(group(a, REPO).stranded, [])
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
  assert.deepEqual(empty.stranded, [])
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
  assert.deepEqual(
    v.stranded.map((i) => i.repo),
    [REPO, 'oakgreencc/other'],
  )
  assert.equal(v.fetchedAt, new Date(T0).toISOString())
})
