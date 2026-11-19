// @ts-check
/** The `task` graph itself: its shape and declarations, the README's diagram, and where an issue resumes. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveConfig } from '../src/config.mjs'
import { END, validateGraph, toMermaid } from '../src/graph/index.mjs'
import { locate } from '../src/graph-engine.mjs'
import { nodeOf, task, TASK_QUEUES } from '../src/graphs/task.mjs'
import { newMarker, parseMarker } from '../src/marker.mjs'
import { tick } from '../src/tick.mjs'
import { harness, T0 } from './fakes.mjs'

test('task graph: five nodes, one wait, ends at submit, valid', () => {
  assert.deepEqual(validateGraph(task), [])
  assert.equal(task.version, 2)
  assert.deepEqual(
    task.nodes.map((n) => n.name),
    ['start-worker', 'worker-running', 'submit', 'requeue', 'to-human'],
  )
  assert.deepEqual(
    task.nodes.filter((n) => n.kind === 'wait').map((n) => n.name),
    ['worker-running'],
  )
  assert.deepEqual(
    task.edges.filter(([from]) => from === 'submit').map(([, to]) => String(to)),
    [String(END)],
  )
  assert.equal(task.entry.queue, 'q:task')
  assert.equal(task.entry.node, 'start-worker')
})

test('each node declares its queue label and whether it holds running', () => {
  const decl = Object.fromEntries(task.nodes.map((n) => [n.name, [nodeOf(n.name).queue, nodeOf(n.name).running]]))
  assert.deepEqual(decl, {
    'start-worker': ['q:task', false],
    'worker-running': ['q:task', true],
    submit: [null, false],
    requeue: ['q:task', false],
    'to-human': ['q:human', false],
  })
  assert.deepEqual(TASK_QUEUES['q:task'].nodes, ['start-worker', 'worker-running', 'requeue'])
})

test('README shows the task graph exactly as toMermaid renders it', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(readme.includes(`\`\`\`mermaid\n${toMermaid(task)}\`\`\``), 'regenerate the README diagram')
})

test('config: engine defaults to legacy and takes only legacy or graph', () => {
  const base = { repos: [], paths: { home: '/tmp/x' } }
  assert.equal(resolveConfig(base).engine, 'legacy')
  assert.equal(resolveConfig({ ...base, engine: 'graph' }).engine, 'graph')
  assert.throws(() => resolveConfig({ ...base, engine: 'langgraph' }), /engine must be "legacy" or "graph"/)
})

/** @param {string[]} labels @param {Partial<import('../src/marker.mjs').Marker> | null} marker */
const issueWith = (labels, marker) =>
  /** @type {import('../src/github.mjs').Issue} */ ({
    number: 1,
    title: 't',
    url: 'u',
    state: 'OPEN',
    createdAt: new Date(T0).toISOString(),
    body: '',
    labels,
    stateComment: marker ? { id: 1, marker: newMarker(marker) } : null,
  })

test('locate: the label wins, a PR-graph node is not the task graph’s, a vanished node restarts', () => {
  assert.deepEqual(locate(issueWith(['q:task'], null), T0), { node: 'start-worker', input: {} })
  assert.deepEqual(locate(issueWith(['q:task'], { node: 'ci-running', pr: 3 }), T0), {
    node: 'start-worker',
    input: {},
  })
  for (const node of ['submit', 'ci-running', 'merging', 'merge-queue', 'close-out'])
    assert.equal(locate(issueWith([], { node, pr: 3, branch: 'b', graphVersion: 1 }), T0), null, node)
  assert.equal(locate(issueWith([], { stage: 'submitted', pr: 3, branch: 'b', queued: true }), T0), null)
  assert.equal(locate(issueWith([], { graph: 'pr', node: 'merge', pr: 3 }), T0), null)
  const gone = locate(issueWith([], { node: 'review', graphVersion: 0 }), T0)
  assert.equal(gone?.node, 'start-worker')
  assert.equal(gone?.note?.outcome, 'graph-changed')
})

test('graph engine: a resting v1 marker with an open PR is the PR graph’s, not restarted', async () => {
  const h = harness({
    issues: [{ number: 40, labels: [] }],
    prs: [{ number: 400, closes: [40] }],
    config: { engine: 'graph', phases: { task: { cap: 0 } } },
  })
  h.gh.issue(40).comment = {
    id: 2,
    body: `<!-- cambium:state ${JSON.stringify({ v: 2, graph: 'task', graphVersion: 1, node: 'merging', status: 'waiting', attempt: 1, pr: 400, history: [] })} -->`,
  }
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(40).labels, [], 'not requeued')
  assert.equal(parseMarker(h.gh.issue(40).comment.body)?.node, 'merging', 'CI pending: nothing written')
})
