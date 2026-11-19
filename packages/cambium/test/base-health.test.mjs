// @ts-check
/** The base branch's health: observed from its history, gating Schedule, and repaired by one issue. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseHealthOf, repairBody, REPAIR_LABEL } from '../src/base-health.mjs'
import { normalize, SNAPSHOT_QUERY } from '../src/github.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG } from './fakes.mjs'

const AT = { branch: 'develop', check: 'ci' }

/**
 * A history node: `run` is a check run's [status, conclusion], or null for none, in a suite for `branch` (the
 * base, unless a PR's own commit).
 */
const commit = (
  /** @type {string} */ oid,
  /** @type {[string, string | null] | null} */ run,
  pr = 0,
  branch = 'develop',
) => ({
  oid,
  messageHeadline: `merge ${oid}`,
  associatedPullRequests: { nodes: pr ? [{ number: pr }] : [] },
  checkSuites: {
    nodes: run
      ? [
          {
            branch: { name: branch },
            checkRuns: { nodes: [{ status: run[0], conclusion: run[1], detailsUrl: `https://ci/${oid}` }] },
          },
        ]
      : [],
  },
})

test('baseHealthOf: only runs for the base branch count; a merged PR is one suspect, not one per commit', () => {
  // Develop has no push runs; PR #4629's own commit ran `ci` on its agent branch, green. That says nothing.
  const pr = commit('p1', ['COMPLETED', 'SUCCESS'], 4629, 'agent/3972-x')
  assert.equal(baseHealthOf(repoOf([commit('m1', null, 4629), pr]), AT).state, 'unknown')
  const h = baseHealthOf(
    repoOf([
      commit('m2', ['COMPLETED', 'FAILURE'], 4625),
      commit('p2', ['COMPLETED', 'SUCCESS'], 4625, 'agent/3934-split'),
      commit('p3', null, 4625),
      commit('m1', ['COMPLETED', 'SUCCESS'], 4624),
    ]),
    AT,
  )
  assert.equal(h.state, 'red')
  assert.equal(h.lastGreen?.sha, 'm1', "the PR commit's green is not the base's")
  assert.deepEqual(
    h.suspects.map((c) => [c.sha, c.pr]),
    [['m2', 4625]],
  )
})
const repoOf = (/** @type {any[]} */ nodes, /** @type {number[]} */ repairs = []) => ({
  baseRef: { target: { history: { nodes } } },
  repairs: { nodes: repairs.map((number) => ({ number })) },
})
const OK = /** @type {[string, string]} */ (['COMPLETED', 'SUCCESS'])
const RED = /** @type {[string, string]} */ (['COMPLETED', 'FAILURE'])

test('baseHealthOf: the newest commit with a verdict decides; pending and cancelled runs say nothing', () => {
  assert.equal(baseHealthOf(repoOf([commit('c3', OK), commit('c2', RED)]), AT).state, 'green')
  const h = baseHealthOf(
    repoOf([
      commit('c5', ['IN_PROGRESS', null]),
      commit('c4', RED, 4625),
      commit('c3', ['COMPLETED', 'CANCELLED'], 4624),
      commit('c2', null, 4623),
      commit('c1', OK, 4622),
      commit('c0', RED),
    ]),
    AT,
  )
  assert.equal(h.state, 'red', 'a pending head does not clear a red base')
  assert.equal(h.head, 'c5')
  assert.deepEqual(h.red, { sha: 'c4', headline: 'merge c4', pr: 4625, url: 'https://ci/c4' })
  assert.equal(h.lastGreen?.sha, 'c1')
  assert.deepEqual(
    h.suspects.map((c) => [c.sha, c.pr]),
    [
      ['c4', 4625],
      ['c3', 4624],
      ['c2', 4623],
    ],
  )
})

test('baseHealthOf: no verdict in the window is unknown; red with no green names every commit', () => {
  assert.equal(baseHealthOf(repoOf([commit('a', null), commit('b', ['COMPLETED', 'CANCELLED'])]), AT).state, 'unknown')
  assert.equal(baseHealthOf({}, AT).state, 'unknown')
  const h = baseHealthOf(repoOf([commit('b', RED), commit('a', ['COMPLETED', 'TIMED_OUT'])], [77]), AT)
  assert.equal(h.lastGreen, null)
  assert.deepEqual(
    h.suspects.map((c) => c.sha),
    ['b', 'a'],
  )
  assert.deepEqual(h.repairs, [77])
})

test('snapshot: the base read is in the query and normalized only when asked for', () => {
  assert.match(SNAPSHOT_QUERY, /baseRef: ref\(qualifiedName: \$baseRef\) @include\(if: \$health\)/)
  assert.match(SNAPSHOT_QUERY, /checkRuns\(first: 3, filterBy: \{ checkName: \$check \}\)/)
  assert.match(SNAPSHOT_QUERY, new RegExp(`issues\\(labels: \\["${REPAIR_LABEL}"\\]`))
  const repository = { issues: { nodes: [] }, ...repoOf([commit('c1', RED)]) }
  assert.equal(normalize({ repository }).base, undefined)
  assert.equal(normalize({ repository }, { health: AT }).base?.state, 'red')
})

test('repair body: the spec names the failing run, the suspects and the way out', () => {
  const body = repairBody(
    baseHealthOf(repoOf([commit('c4', RED, 4625), commit('c3', null, 4624), commit('c1', OK)]), AT),
  )
  for (const needle of ['https://ci/c4', 'c4 #4625', 'c3 #4624', 'Last green: c1', 'revert', 'pnpm verify', 'rescue'])
    assert.ok(body.includes(needle), needle)
})

/** A graph-engine harness with `base` set to red (suspects #4625) or green. */
function red(seed = {}) {
  const h = harness({
    ...seed,
    config: {
      engine: 'graph',
      repos: [{ slug: SLUG, path: '/repo', baseBranch: 'develop' }],
      .../** @type {any} */ (seed).config,
    },
  })
  h.gh.health.base = baseHealthOf(repoOf([commit('c4', RED, 4625), commit('c1', OK)]), AT)
  return h
}
const green = (/** @type {ReturnType<typeof harness>} */ h) => {
  h.gh.health.base = baseHealthOf(repoOf([commit('c5', OK), commit('c4', RED)]), AT)
}
const created = (/** @type {ReturnType<typeof harness>} */ h) => h.gh.calls.filter((c) => c.op === 'createIssue')

test('red base: one repair issue, top priority, in q:task; not opened twice', async () => {
  const h = red({ config: { phases: { task: { cap: 0 } } } })
  await tick(h.deps)
  assert.equal(created(h).length, 1)
  const [, made] = created(h)[0].args
  assert.equal(made.title, 'Red base: develop `ci` failing since c4')
  assert.deepEqual(made.labels, ['q:task', 'priority:critical', REPAIR_LABEL])
  await tick(h.deps)
  assert.equal(created(h).length, 1, 'the open repair issue is found, not duplicated')
})

test('red base: Schedule starts only the repair, which takes no slot', async () => {
  const h = red({ issues: [{ number: 1, labels: ['q:task'] }], config: { phases: { task: { cap: 2 } } } })
  // #1 started before the base went red; a slot is still free.
  h.gh.health.base = null
  await tick(h.deps)
  h.gh.health.base = red().gh.health.base
  const queued = await h.gh.github.createIssue(SLUG, { title: 'queued', body: 'b', labels: ['q:task'] })
  await tick(h.deps)
  assert.deepEqual(
    h.spawner.started.map((s) => s.issue),
    [1],
    `#${queued.number} waits though a slot is free`,
  )
  assert.equal(created(h).at(-1)?.args[1].title, 'Red base: develop `ci` failing since c4')
  await tick(h.deps)
  assert.deepEqual(
    h.spawner.started.map((s) => s.issue),
    [1, queued.number + 1],
    'then the repair, and only the repair',
  )

  // Every slot taken: the repair still starts.
  const full = red({ issues: [{ number: 1, labels: ['q:task'] }], config: { phases: { task: { cap: 1 } } } })
  full.gh.health.base = null
  await tick(full.deps)
  full.gh.health.base = red().gh.health.base
  await tick(full.deps)
  await tick(full.deps)
  assert.deepEqual(
    full.spawner.started.map((s) => s.issue),
    [1, 9000],
    'the repair starts past the cap',
  )
})

test('unknown base gates nothing', async () => {
  const h = harness({ issues: [{ number: 2, labels: ['q:task'] }], config: { engine: 'graph' } })
  await tick(h.deps)
  assert.deepEqual(
    h.spawner.started.map((s) => s.issue),
    [2],
  )
  assert.equal(created(h).length, 0)
})

test('red base: a failed attempt is requeued at the same attempt, never to q:human', async () => {
  const h = harness({
    issues: [{ number: 3, labels: ['q:task'] }],
    config: { engine: 'graph', phases: { task: { maxAttempts: 1 } } },
  })
  await tick(h.deps)
  const w = /** @type {any} */ (h.deps.store.worker(SLUG, 3))
  h.gh.health.base = red().gh.health.base
  h.procs.live.delete(w.pid)
  await tick(h.deps)
  const m = h.gh.marker(3)
  assert.ok(h.gh.issue(3).labels.includes('q:task'), 'back in q:task, not q:human, though the one attempt is spent')
  assert.equal(m?.attempt, 1, 'not charged')
  const last = m?.history.find((e) => e.outcome === 'base-red')
  assert.match(String(last?.reason), /develop is red at c4; not charged/)
  assert.equal(h.spawner.started.length, 1, 'held until the base is green')
})

test('red base: the repair issue itself is charged as usual', async () => {
  const h = red({ config: { phases: { task: { maxAttempts: 1 } } } })
  await tick(h.deps)
  await tick(h.deps)
  const n = created(h)[0] && 9000
  const w = /** @type {any} */ (h.deps.store.worker(SLUG, n))
  assert.ok(w, 'repair worker running')
  h.procs.live.delete(w.pid)
  await tick(h.deps)
  assert.ok(h.gh.issue(n).labels.includes('q:human'), 'a repair that fails its budget goes to a human')
})

test('green again: a repair issue nobody is working is closed; one with a worker is left alone', async () => {
  const h = red({ config: { phases: { task: { cap: 0 } } } })
  await tick(h.deps)
  green(h)
  await tick(h.deps)
  assert.equal(h.gh.issue(9000).state, 'CLOSED')
  assert.ok(h.gh.calls.some((c) => c.op === 'close' && c.args[1] === 9000 && /green again at c5/.test(c.args[2])))

  const busy = red()
  await tick(busy.deps)
  await tick(busy.deps)
  assert.ok(busy.deps.store.worker(SLUG, 9000), 'repair worker running')
  green(busy)
  await tick(busy.deps)
  assert.equal(busy.gh.issue(9000).state, 'OPEN', 'its worker decides')
})

test('heartbeat: each repo carries its base health', async () => {
  const h = red({ config: { phases: { task: { cap: 0 } } } })
  const state = await tick(h.deps)
  assert.equal(state.repos[0].base?.state, 'red')
  assert.equal(state.repos[0].base?.red?.sha, 'c4')
})
