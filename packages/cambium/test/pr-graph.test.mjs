// @ts-check
/**
 * The PR graph (graphs/pr.mjs): once the task graph has ended at `submit`, every tick assesses each open agent PR
 * whose CI has settled and whose issue has no Task queued or running: merge, rework, close, or the Human Queue.
 * Graph engine only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.mjs'
import { toMermaid, validateGraph } from '../src/graph/index.mjs'
import { MERGE_RETRY_MINUTES, prGraph } from '../src/graphs/pr.mjs'
import { newMarker, renderMarker } from '../src/marker.mjs'
import { taskPrompt } from '../src/phases/task.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG } from './fakes.mjs'

const MIN = 60_000

/**
 * Issue #50 submitted as PR #500: its marker where the task graph left it (v2 `submit`, or a v1 `ci-running`).
 * @param {{ merge?: string, pr?: object, labels?: string[], marker?: object, cap?: number, prs?: object[] }} [o]
 */
function submitted({ merge = 'green', pr = {}, labels = [], marker = {}, cap = 0, prs = [] } = {}) {
  const h = harness({
    issues: [{ number: 50, labels }],
    prs: [{ number: 500, closes: [50], checks: 'PENDING', autoMerge: false, ...pr }, ...prs],
    config: { engine: 'graph', repos: [{ slug: SLUG, path: '/repo', merge }], phases: { task: { cap } } },
  })
  h.gh.issue(50).comment = {
    id: 7,
    body: renderMarker(
      newMarker({
        node: 'submit',
        graphVersion: 2,
        status: 'done',
        pr: 500,
        branch: 'agent/issue-50',
        submittedAt: new Date(h.clock.now()).toISOString(),
        ...marker,
      }),
    ),
  }
  const ops = (/** @type {string} */ op) => h.gh.calls.filter((c) => c.op === op).map((c) => c.args)
  const merges = () => ops('mergePull')
  return { ...h, ops, merges }
}

test('pr graph: valid, enters at assess, every outcome is an edge', () => {
  assert.deepEqual(validateGraph(prGraph), [])
  assert.equal(prGraph.entry.node, 'assess')
  assert.deepEqual(
    prGraph.nodes.map((n) => n.name),
    ['assess', 'merge', 'rework', 'close-pr', 'close-out', 'to-human'],
  )
  assert.ok(
    prGraph.nodes.every((n) => n.kind === 'node'),
    'no waits: the next tick assesses again',
  )
})

test('README shows the PR graph exactly as toMermaid renders it', async () => {
  const { readFileSync } = await import('node:fs')
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(readme.includes(toMermaid(prGraph)), 'README is out of date: paste toMermaid(prGraph)')
})

test('config: merge defaults to none, a repo overrides the top level, green needs the graph engine; maxReworks 3', () => {
  const base = { paths: { home: '/tmp/x' }, engine: 'graph' }
  const repos = [
    { slug: 'a/one', path: '/1' },
    { slug: 'a/two', path: '/2', merge: 'green' },
  ]
  assert.deepEqual(
    resolveConfig({ ...base, repos }).repos.map((r) => r.merge),
    ['none', 'green'],
  )
  assert.throws(() => resolveConfig({ ...base, repos: [{ slug: 'a/b', path: '/b', merge: 'queue' }] }), /merge must be/)
  assert.throws(() => resolveConfig({ ...base, engine: 'legacy', repos }), /a\/two\) needs engine "graph"/)
  assert.equal(resolveConfig(base).phases.task.maxReworks, 3)
})

test('active CI, a queued or running Task: not assessed', async () => {
  const pending = submitted()
  await tick(pending.deps)
  assert.deepEqual(pending.merges(), [], 'pending CI: no merge')
  assert.equal(pending.gh.marker(50)?.node, 'submit', 'nothing written')

  const queued = submitted({ pr: { checks: 'SUCCESS' }, labels: ['q:task'] })
  await tick(queued.deps)
  assert.deepEqual(queued.merges(), [])

  const running = submitted({ pr: { checks: 'SUCCESS' }, labels: ['running'] })
  await tick(running.deps)
  assert.deepEqual(running.merges(), [])
})

test('green → graft pr merge; merged → issue closed, branch deleted', async () => {
  const h = submitted({ pr: { checks: 'SUCCESS' } })
  await tick(h.deps)
  assert.deepEqual(h.merges(), [[SLUG, 500]])
  const m = h.gh.marker(50)
  assert.equal(m?.graph, 'pr')
  assert.equal(m?.node, 'merge')
  assert.equal(m?.history.at(-1)?.outcome, 'merge-armed')
  assert.deepEqual(h.gh.issue(50).labels, [], 'still in no queue')

  h.gh.pr(500).state = 'MERGED'
  await tick(h.deps)
  assert.equal(h.gh.issue(50).state, 'CLOSED')
  assert.equal(h.gh.marker(50)?.node, 'close-out')
  assert.equal(h.gh.marker(50)?.history.at(-1)?.outcome, 'merged')
  assert.deepEqual(h.ops('deleteBranch'), [[SLUG, 'agent/issue-50']])
})

test('a v1 marker resting at ci-running is assessed, not restarted (graph v1 → v2)', async () => {
  const h = submitted({ pr: { checks: 'SUCCESS' }, marker: { node: 'ci-running', graphVersion: 1, status: 'waiting' } })
  await tick(h.deps)
  assert.deepEqual(h.merges(), [[SLUG, 500]])
  assert.ok(!h.gh.marker(50)?.history.some((e) => e.outcome === 'graph-changed'))
})

test('merge "none": green is left alone, then stalls to q:human + why:approve', async () => {
  const h = submitted({ merge: 'none', pr: { checks: 'SUCCESS' } })
  await tick(h.deps)
  assert.deepEqual(h.merges(), [])
  h.clock.advance(121 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(50).labels.sort(), ['q:human', 'why:approve'])
  assert.equal(h.gh.marker(50)?.history.at(-1)?.outcome, 'stalled')
})

test('auto-merge already armed: cambium does not merge again', async () => {
  const h = submitted({ pr: { checks: 'SUCCESS', autoMerge: true } })
  await tick(h.deps)
  assert.deepEqual(h.merges(), [])
})

test('armed, green and BLOCKED past mergeStallMinutes → q:human + why:approve, naming GitHub’s state', async () => {
  const h = submitted({ pr: { checks: 'SUCCESS', autoMerge: true, mergeState: 'BLOCKED' } })
  h.gh.pulls[0].autoMergeAt = new Date(h.clock.now()).toISOString()
  await tick(h.deps)
  h.clock.advance(19 * MIN)
  await tick(h.deps)
  assert.ok(!h.gh.issue(50).labels.includes('q:human'), 'within the stall window: held')
  h.clock.advance(2 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(50).labels.sort(), ['q:human', 'why:approve'])
  const last = h.gh.marker(50)?.history.at(-1)
  assert.equal(last?.outcome, 'merge-blocked')
  assert.match(String(last?.reason), /auto-merge armed 21 min ago .* BLOCKED/)
})

test('armed and green but not BLOCKED (GitHub still merging): no stall before mergeQueueMinutes', async () => {
  const h = submitted({ pr: { checks: 'SUCCESS', autoMerge: true, mergeState: 'CLEAN' } })
  h.gh.pulls[0].autoMergeAt = new Date(h.clock.now()).toISOString()
  h.clock.advance(60 * MIN)
  await tick(h.deps)
  assert.ok(!h.gh.issue(50).labels.includes('q:human'))
})

test('a refused merge is recorded and held; asked again on a new head or after the retry window', async () => {
  const h = submitted({ pr: { checks: 'SUCCESS', headSha: 'head1' } })
  h.gh.faults.mergeError = new Error('graft: base develop is red; refusing to merge')
  await tick(h.deps)
  const m = h.gh.marker(50)
  assert.equal(m?.history.at(-1)?.outcome, 'merge-refused')
  assert.equal(m?.mergeRefusal?.sha, 'head1')
  assert.match(String(m?.lastFailure), /base develop is red/)
  assert.deepEqual(h.gh.issue(50).labels, [], 'a transient refusal is neither a rework nor the Human Queue')

  await tick(h.deps)
  assert.equal(h.merges().length, 1, 'same head, inside the window: hold')

  h.gh.faults.mergeError = null
  h.clock.advance((MERGE_RETRY_MINUTES + 1) * MIN)
  await tick(h.deps)
  assert.equal(h.merges().length, 2, 'retried after the window')
  assert.equal(h.gh.marker(50)?.mergeRefusal, null)

  const moved = submitted({ pr: { checks: 'SUCCESS', headSha: 'head1' } })
  moved.gh.faults.mergeError = new Error('refused')
  await tick(moved.deps)
  moved.gh.pr(500).headSha = 'head2'
  await tick(moved.deps)
  assert.equal(moved.merges().length, 2, 'a new head is asked at once')
})

test('a refusal only a human can clear (protected paths) → q:human + why:approve, and it stays there', async () => {
  const h = submitted({ pr: { checks: 'SUCCESS', headSha: 'head1' } })
  h.gh.faults.mergeError = new Error(
    "refusing to merge o/r#500:\n\nPR #500 changes 1 protected path:\n  package.json\nThese are the code owners' to approve; hand the PR over rather than retrying.",
  )
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(50).labels.sort(), ['q:human', 'why:approve'])
  assert.equal(h.gh.marker(50)?.history.at(-1)?.outcome, 'needs-approval')
  h.clock.advance((MERGE_RETRY_MINUTES + 1) * MIN)
  await tick(h.deps)
  assert.equal(h.merges().length, 1, 'the same head is the human’s')
  h.gh.pr(500).headSha = 'head2'
  h.gh.faults.mergeError = null
  await tick(h.deps)
  assert.equal(h.merges().length, 2, 'a new head (approved, or reworked) is merged')
})

test('behind its base: update the branch, then merge once the new head is green', async () => {
  const h = submitted({ pr: { checks: 'SUCCESS', headSha: 'head1', behind: 2 } })
  await tick(h.deps)
  assert.deepEqual(h.merges(), [], 'green on an old base is not merged')
  assert.deepEqual(h.ops('updatePull'), [[SLUG, 500]])
  const m = h.gh.marker(50)
  assert.equal(m?.history.at(-1)?.outcome, 'branch-updated')
  assert.match(String(m?.history.at(-1)?.reason), /2 commits behind develop/)
  assert.equal(m?.mergeRefusal?.sha, 'head1', 'held on the head it replaced')

  await tick(h.deps)
  assert.deepEqual(h.merges(), [], 'CI pending on the updated head')
  h.gh.pr(500).checks = 'SUCCESS'
  await tick(h.deps)
  assert.deepEqual(h.merges(), [[SLUG, 500]])
})

test('two PRs green on the same base in one tick: the first merges, the second is updated, not merged', async () => {
  // sektorapp/monorepo#4624 and #4625: each green on the same base, merged 8 s apart, red together.
  const h = harness({
    issues: [
      { number: 50, labels: [] },
      { number: 51, labels: [] },
    ],
    prs: [
      { number: 500, closes: [50], checks: 'SUCCESS', headSha: 'a1', autoMerge: false },
      { number: 501, closes: [51], checks: 'SUCCESS', headSha: 'b1', autoMerge: false },
    ],
    config: { engine: 'graph', repos: [{ slug: SLUG, path: '/repo', merge: 'green' }], phases: { task: { cap: 0 } } },
  })
  for (const [n, pr] of [
    [50, 500],
    [51, 501],
  ])
    h.gh.issue(n).comment = {
      id: n,
      body: renderMarker(
        newMarker({ node: 'submit', graphVersion: 2, status: 'done', pr, branch: `agent/issue-${n}` }),
      ),
    }
  const merge = h.gh.github.mergePull
  h.gh.github.mergePull = async (slug, n) => {
    await merge(slug, n)
    for (const p of /** @type {any[]} */ (h.gh.pulls)) if (p.number !== n) p.behind = (p.behind ?? 0) + 1
  }
  await tick(h.deps)
  const ops = h.gh.calls.filter((c) => c.op === 'mergePull' || c.op === 'updatePull').map((c) => [c.op, c.args[1]])
  assert.deepEqual(ops, [
    ['mergePull', 500],
    ['updatePull', 501],
  ])
})

test('red CI → rework: back to q:task at attempt 1 with the PR state, the worker resumes the PR', async () => {
  const h = submitted({
    pr: {
      checks: 'FAILURE',
      headSha: 'red1',
      failing: [{ name: 'verify', url: 'https://ci/1', summary: 'lint failed' }],
    },
    marker: { attempt: 3 },
    cap: 1,
  })
  await tick(h.deps)
  const m = h.gh.marker(50)
  assert.equal(m?.graph, 'task')
  assert.equal(m?.attempt, 1, 'a fresh attempt budget')
  assert.equal(m?.reworks, 1)
  assert.equal(m?.failedSha, 'red1')
  assert.ok(m?.history.some((e) => e.node === 'rework' && e.outcome === 'ci-red'))
  assert.equal(h.spawner.started.length, 1, 'Schedule starts it in the same tick')
  const prompt = String(h.spawner.started[0].prompt)
  assert.match(prompt, /This is rework 1 of PR #500/)
  assert.match(prompt, /A PR already exists: #500/)
  assert.match(prompt, /verify \(https:\/\/ci\/1\)\n {2}lint failed/)
  assert.deepEqual(h.merges(), [])
})

test('a conflict or changes requested → rework with the reason', async () => {
  const conflict = submitted({ pr: { checks: 'SUCCESS', mergeable: 'CONFLICTING' } })
  await tick(conflict.deps)
  assert.equal(conflict.gh.marker(50)?.lastFailure?.includes('conflicts with its base'), true)
  assert.deepEqual(conflict.gh.issue(50).labels, ['q:task'])
  assert.deepEqual(conflict.merges(), [])

  const review = submitted({ pr: { checks: 'SUCCESS', reviewDecision: 'CHANGES_REQUESTED' } })
  await tick(review.deps)
  assert.equal(review.gh.marker(50)?.history.at(-1)?.outcome, 'changes-requested')
  assert.deepEqual(review.gh.issue(50).labels, ['q:task'])
})

test('red CI while the base is red: held, not reworked; the repair issue is reworked', async () => {
  const red = /** @type {any} */ ({
    state: 'red',
    branch: 'develop',
    check: 'ci',
    red: { sha: 'bad1' },
    lastGreen: null,
    suspects: [],
  })
  const h = submitted({ pr: { checks: 'FAILURE', headSha: 'red1' } })
  h.gh.health.base = red
  await tick(h.deps)
  assert.ok(!h.gh.issue(50).labels.includes('q:task'), 'not reworked')
  assert.equal(h.gh.marker(50)?.reworks, undefined)

  const repair = submitted({ pr: { checks: 'FAILURE', headSha: 'red1' }, labels: ['red-base'] })
  repair.gh.health.base = red
  await tick(repair.deps)
  assert.equal(repair.gh.marker(50)?.reworks, 1)
})

test('reworks spent → q:human + why:budget', async () => {
  const h = submitted({ pr: { checks: 'FAILURE', headSha: 'red4' }, marker: { reworks: 3 } })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(50).labels.sort(), ['q:human', 'why:budget'])
  assert.equal(h.gh.marker(50)?.history.at(-1)?.outcome, 'reworks-spent')
  assert.match(String(h.gh.marker(50)?.lastFailure), /^3 reworks spent on PR #500/)
})

test('issue closed, or a newer PR for the same issue → the PR is closed with the reason', async () => {
  const closed = submitted({ pr: { checks: 'SUCCESS' } })
  closed.gh.issue(50).state = 'CLOSED'
  await tick(closed.deps)
  assert.deepEqual(closed.ops('closePull'), [
    [SLUG, 500, 'Issue #50 is closed, so this PR has nothing to do. Closed by cambium.'],
  ])
  assert.deepEqual(closed.merges(), [])

  const twice = submitted({ pr: { checks: 'FAILURE' }, prs: [{ number: 501, closes: [50], checks: 'PENDING' }] })
  await tick(twice.deps)
  assert.deepEqual(
    twice.ops('closePull').map((a) => a.slice(1)),
    [[500, 'Superseded by #501 for #50. Closed by cambium.']],
  )
  assert.equal(twice.gh.marker(50)?.history.at(-1)?.outcome, 'pr-closed')
})

test('the orphan (sektorapp/monorepo#4627): a green PR whose issue went to q:human before it landed is merged', async () => {
  const h = submitted({
    pr: { checks: 'SUCCESS' },
    labels: ['q:human', 'why:budget'],
    marker: { graph: 'task', graphVersion: 2, node: 'to-human', status: 'waiting', pr: null, submittedAt: null },
  })
  await tick(h.deps)
  assert.deepEqual(h.merges(), [[SLUG, 500]])
  h.gh.pr(500).state = 'MERGED'
  await tick(h.deps)
  assert.equal(h.gh.issue(50).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(50).labels, [], 'out of the Human Queue')
})

test('q:human is the human’s for anything but a green merge: red is not reworked, nothing is closed', async () => {
  const h = submitted({ pr: { checks: 'FAILURE', headSha: 'red1' }, labels: ['q:human', 'why:budget'] })
  await tick(h.deps)
  h.clock.advance(300 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(50).labels, ['q:human', 'why:budget'])
  assert.deepEqual(h.ops('closePull'), [])
  assert.equal(h.gh.calls.filter((c) => c.op === 'writeState').length, 0)
})

test('the worker prompt says who merges', () => {
  const issue = /** @type {any} */ ({ number: 1, title: 't', url: 'u', body: 'b' })
  const base = { repo: SLUG, issue, marker: newMarker(), branch: 'b', pr: null, agentsMd: null, maxAttempts: 3 }
  assert.match(taskPrompt({ ...base, merge: 'green' }), /Green: stop; cambium merges the PR once CI is green\./)
  assert.match(taskPrompt({ ...base, merge: 'none' }), /Green: stop; the PR is merged outside this session\./)
})
