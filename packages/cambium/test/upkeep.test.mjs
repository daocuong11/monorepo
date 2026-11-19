// @ts-check
/** Upkeep (graph engine): the hourly reaper of untracked agent PRs and the daily re-triage of `q:human`. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { branchIssue, unreadCloses } from '../src/github.mjs'
import { reapVerdict } from '../src/upkeep.mjs'
import { newMarker, renderMarker } from '../src/marker.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG } from './fakes.mjs'

const MIN = 60_000

/** @param {{ issues?: any[], prs?: any[], config?: any }} seed */
const graph = ({ issues = [], prs = [], config = {} }) =>
  harness({
    issues,
    prs,
    config: {
      engine: 'graph',
      repos: [{ slug: SLUG, path: '/repo', merge: 'green' }],
      phases: { task: { cap: 0 }, dispatch: { cap: 0 } },
      ...config,
    },
  })

const reaperComments = (/** @type {ReturnType<typeof harness>} */ h) =>
  h.gh.calls.filter((c) => c.op === 'comment' && /\*\*Reaper:\*\*/.test(c.args[2]))

test('branchIssue reads agent/<n>-slug and agent/issue-<n>', () => {
  assert.equal(branchIssue('agent/4408-shared-vehicle-link'), 4408)
  assert.equal(branchIssue('agent/issue-7'), 7)
  assert.equal(branchIssue('agent/cambium-upkeep'), null)
  assert.equal(branchIssue('feature/12-x'), null)
})

test('unreadCloses also asks for the issue an open PR names only by its branch', () => {
  const snap = /** @type {any} */ ({
    issues: new Map(),
    prs: [
      { state: 'OPEN', closes: [], branch: 'agent/4316-e2e' },
      { state: 'OPEN', closes: [9], branch: 'agent/12-x' },
      { state: 'MERGED', closes: [], branch: 'agent/13-y' },
    ],
  })
  assert.deepEqual(unreadCloses(snap).sort(), [4316, 9])
})

test('reaper: a stale, untracked green PR for a q:human issue is linked, adopted, then merged by the PR graph', async () => {
  const h = graph({
    issues: [{ number: 4408, labels: ['q:human', 'why:budget'] }],
    prs: [{ number: 4627, closes: [], branch: 'agent/4408-shared-vehicle', checks: 'SUCCESS', autoMerge: false }],
  })
  await tick(h.deps)
  assert.equal(reaperComments(h).length, 0, 'fresh: left alone')

  h.clock.advance(61 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.calls.find((c) => c.op === 'linkIssue')?.args, [SLUG, 4627, 4408])
  assert.deepEqual(h.gh.issue(4408).labels, [], 'out of q:human')
  const m = h.gh.marker(4408)
  assert.equal(m?.pr, 4627)
  assert.equal(m?.node, 'submit')
  assert.match(reaperComments(h)[0].args[2], /adopted PR #4627, which nothing was tracking \(was q:human\)/)

  await tick(h.deps)
  assert.ok(
    h.gh.calls.some((c) => c.op === 'mergePull' && c.args[1] === 4627),
    'Watch merges it',
  )
})

test('reaper: a q:task issue with an untracked PR is adopted instead of starting a duplicate Task', async () => {
  const h = graph({
    issues: [{ number: 50, labels: ['q:task'] }],
    prs: [{ number: 500, closes: [50], checks: 'FAILURE', autoMerge: false }],
  })
  h.clock.advance(61 * MIN)
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'linkIssue').length, 0, 'already says Closes')
  assert.equal(h.gh.marker(50)?.pr, 500)
  assert.ok(!h.gh.issue(50).labels.includes('q:task'))
})

test('reaper leaves alone: a tracked PR and a PR touched recently; and runs hourly', async () => {
  const h = graph({
    issues: [
      { number: 50, labels: [] },
      { number: 52, labels: ['q:human', 'why:budget'] },
    ],
    prs: [
      { number: 500, closes: [50], checks: 'PENDING' },
      { number: 502, closes: [52], checks: 'PENDING' },
    ],
  })
  h.gh.issue(50).comment = { id: 7, body: renderMarker(newMarker({ node: 'submit', status: 'done', pr: 500 })) }
  h.clock.advance(61 * MIN)
  // #502 was updated a minute ago.
  Object.assign(/** @type {any} */ (h.gh.pulls.find((p) => p.number === 502)), {
    updatedAt: new Date(h.clock.now() - MIN).toISOString(),
  })
  await tick(h.deps)
  assert.equal(reaperComments(h).length, 0)
  assert.equal(h.gh.calls.filter((c) => c.op === 'closePull').length, 0)

  // Stale now, but the reaper ran under an hour ago.
  h.clock.advance(40 * MIN)
  await tick(h.deps)
  assert.equal(reaperComments(h).length, 0)
  h.clock.advance(21 * MIN)
  await tick(h.deps)
  assert.deepEqual(
    reaperComments(h).map((c) => c.args[1]),
    [52],
  )
})

test('reaper closes a PR whose issue is closed, and an issue-less one only after orphanDays', async () => {
  const h = graph({
    issues: [{ number: 60, labels: [], state: 'CLOSED' }],
    prs: [
      { number: 600, closes: [60], checks: 'SUCCESS' },
      { number: 601, closes: [], branch: 'agent/cambium-chore', checks: 'SUCCESS' },
    ],
  })
  h.clock.advance(61 * MIN)
  await tick(h.deps)
  const closed = () => h.gh.calls.filter((c) => c.op === 'closePull').map((c) => c.args[1])
  assert.deepEqual(closed(), [600])
  assert.match(h.gh.calls.find((c) => c.op === 'closePull')?.args[2], /Issue #60 is closed[\s\S]*reaper/)

  h.clock.advance(3 * 24 * 60 * MIN)
  await tick(h.deps)
  assert.deepEqual(closed(), [600, 601])
  assert.match(h.gh.calls.filter((c) => c.op === 'closePull')[1].args[2], /Abandoned: no issue names this PR/)
})

test('re-triage: daily, q:human back to q:intake without its why; not why:approve', async () => {
  const h = graph({
    issues: [
      { number: 70, labels: ['q:human', 'why:triage'] },
      { number: 71, labels: ['q:human', 'why:budget', 'priority:high'] },
      { number: 72, labels: ['q:human', 'why:approve'] },
    ],
    config: { retriage: { enabled: true, time: '00:00' }, reaper: { everyMinutes: 0 } },
  })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(70).labels, ['q:intake'])
  assert.deepEqual(h.gh.issue(71).labels.sort(), ['priority:high', 'q:intake'])
  assert.deepEqual(h.gh.issue(72).labels.sort(), ['q:human', 'why:approve'])

  // Once a day: a human sent back later the same day stays.
  h.gh.issue(70).labels = ['q:human', 'why:triage']
  h.clock.advance(60 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(70).labels.sort(), ['q:human', 'why:triage'])
  h.clock.advance(24 * 60 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(70).labels, ['q:intake'])
})

test('re-triage is off by default', async () => {
  const h = graph({ issues: [{ number: 70, labels: ['q:human', 'why:triage'] }] })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(70).labels.sort(), ['q:human', 'why:triage'])
})

test('reapVerdict: an issue with a live worker is left to it', () => {
  const issue = /** @type {any} */ ({ number: 5, state: 'OPEN', labels: ['q:task', 'running'], stateComment: null })
  const snap = /** @type {any} */ ({ issues: new Map([[5, issue]]), prs: [] })
  const pr = /** @type {any} */ ({
    number: 9,
    state: 'OPEN',
    closes: [5],
    branch: 'agent/5-x',
    createdAt: '2026-01-01T00:00:00Z',
  })
  const o = { now: Date.parse('2026-01-02T00:00:00Z'), staleMinutes: 30, orphanDays: 3 }
  assert.deepEqual(reapVerdict(pr, snap, { ...o, busy: () => true }), { act: 'leave', why: '#5 has a worker' })
  assert.deepEqual(reapVerdict(pr, snap, { ...o, busy: () => false }), { act: 'adopt', issue, link: false })
})
