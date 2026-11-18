// @ts-check
/** `merge: "green"`: cambium merges a Task PR once CI is green (task graph `merge` → `merging`). Graph engine only. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.mjs'
import { MERGE_RETRY_MINUTES } from '../src/graphs/task.mjs'
import { newMarker, renderMarker } from '../src/marker.mjs'
import { taskPrompt } from '../src/phases/task.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG } from './fakes.mjs'

const MIN = 60_000

/** An issue submitted as PR #500, resting at `ci-running`. @param {{ merge?: string, pr?: object }} [o] */
function submitted({ merge = 'green', pr = {} } = {}) {
  const h = harness({
    issues: [{ number: 50, labels: [] }],
    prs: [{ number: 500, closes: [50], checks: 'PENDING', autoMerge: false, ...pr }],
    config: { engine: 'graph', repos: [{ slug: SLUG, path: '/repo', merge }], phases: { task: { cap: 0 } } },
  })
  h.gh.issue(50).comment = {
    id: 7,
    body: renderMarker(
      newMarker({
        node: 'ci-running',
        graphVersion: 1,
        pr: 500,
        branch: 'agent/issue-50',
        submittedAt: new Date(h.clock.now()).toISOString(),
        queued: false,
      }),
    ),
  }
  const merges = () => h.gh.calls.filter((c) => c.op === 'mergePull').map((c) => c.args)
  return { ...h, merges }
}

test('config: merge defaults to none, a repo overrides the top level, green needs the graph engine', () => {
  const base = { paths: { home: '/tmp/x' }, engine: 'graph' }
  const repos = [
    { slug: 'a/one', path: '/1' },
    { slug: 'a/two', path: '/2', merge: 'green' },
  ]
  assert.deepEqual(
    resolveConfig({ ...base, repos }).repos.map((r) => r.merge),
    ['none', 'green'],
  )
  assert.deepEqual(
    resolveConfig({ ...base, merge: 'green', repos: [{ slug: 'a/one', path: '/1', merge: 'none' }] }).repos.map(
      (r) => r.merge,
    ),
    ['none'],
  )
  assert.throws(() => resolveConfig({ ...base, repos: [{ slug: 'a/b', path: '/b', merge: 'queue' }] }), /merge must be/)
  assert.throws(() => resolveConfig({ ...base, engine: 'legacy', repos }), /a\/two\) needs engine "graph"/)
})

test('green CI → graft pr merge, then merging; merged → issue closed, branch deleted', async () => {
  const h = submitted()
  await tick(h.deps)
  assert.deepEqual(h.merges(), [], 'pending CI: no merge')
  assert.equal(h.gh.marker(50)?.node, 'ci-running')

  h.gh.pr(500).checks = 'SUCCESS'
  await tick(h.deps)
  assert.deepEqual(h.merges(), [[SLUG, 500]])
  assert.equal(h.gh.marker(50)?.node, 'merging')
  assert.equal(h.gh.marker(50)?.history.at(-1)?.outcome, 'merge-armed')
  assert.deepEqual(h.gh.issue(50).labels, [], 'still in no queue')

  await tick(h.deps)
  assert.equal(h.merges().length, 1, 'no second merge while one is in flight')

  h.gh.pr(500).state = 'MERGED'
  await tick(h.deps)
  assert.equal(h.gh.issue(50).state, 'CLOSED')
  assert.equal(h.gh.marker(50)?.history.at(-1)?.outcome, 'merged')
  assert.ok(h.gh.calls.some((c) => c.op === 'deleteBranch'))
})

test('merge "none" (the default): green CI is left alone, then stalls to q:human', async () => {
  const h = submitted({ merge: 'none', pr: { checks: 'SUCCESS' } })
  await tick(h.deps)
  assert.deepEqual(h.merges(), [])
  assert.equal(h.gh.marker(50)?.node, 'ci-running')
  h.clock.advance(121 * MIN)
  await tick(h.deps)
  assert.ok(h.gh.issue(50).labels.includes('q:human'))
})

test('auto-merge already armed: cambium does not merge again', async () => {
  const h = submitted({ pr: { checks: 'SUCCESS', autoMerge: true } })
  await tick(h.deps)
  assert.deepEqual(h.merges(), [])
})

test('a refused merge is recorded, held, and asked again on a new head or after the retry window', async () => {
  const h = submitted({ pr: { checks: 'SUCCESS', headSha: 'head1' } })
  h.gh.faults.mergeError = new Error('graft: base develop is red; refusing to merge')
  await tick(h.deps)
  const m = h.gh.marker(50)
  assert.equal(m?.node, 'merging')
  assert.equal(m?.history.at(-1)?.outcome, 'merge-refused')
  assert.equal(m?.mergeRefusal?.sha, 'head1')
  assert.match(String(m?.lastFailure), /base develop is red/)
  assert.deepEqual(h.gh.issue(50).labels, [], 'a refusal is not a requeue')

  await tick(h.deps)
  assert.equal(h.merges().length, 1, 'same head, inside the window: hold')

  h.gh.faults.mergeError = null
  h.clock.advance((MERGE_RETRY_MINUTES + 1) * MIN)
  await tick(h.deps)
  assert.equal(h.merges().length, 2, 'retried after the window')
  assert.equal(h.gh.marker(50)?.history.at(-1)?.outcome, 'merge-armed')
  assert.equal(h.gh.marker(50)?.mergeRefusal, null)
})

test('a refused merge retries at once on a new head', async () => {
  const h = submitted({ pr: { checks: 'SUCCESS', headSha: 'head1' } })
  h.gh.faults.mergeError = new Error('refused')
  await tick(h.deps)
  h.gh.pr(500).headSha = 'head2'
  await tick(h.deps)
  assert.equal(h.merges().length, 2)
})

test('red CI while merging → requeue', async () => {
  const h = submitted({ pr: { checks: 'SUCCESS' } })
  await tick(h.deps)
  assert.equal(h.gh.marker(50)?.node, 'merging')
  Object.assign(h.gh.pr(500), { checks: 'FAILURE', headSha: 'red1' })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(50).labels, ['q:task'])
  assert.equal(h.gh.marker(50)?.history.at(-1)?.outcome, 'ci-red')
})

test('the worker prompt says who merges', () => {
  const issue = /** @type {any} */ ({ number: 1, title: 't', url: 'u', body: 'b' })
  const base = { repo: SLUG, issue, marker: newMarker(), branch: 'b', pr: null, agentsMd: null, maxAttempts: 3 }
  assert.match(taskPrompt({ ...base, merge: 'green' }), /Green: stop; cambium merges the PR once CI is green\./)
  assert.match(taskPrompt({ ...base, merge: 'none' }), /Green: stop; the PR is merged outside this session\./)
  assert.doesNotMatch(taskPrompt({ ...base, merge: 'none' }), /merge queue|through the queue/)
})
