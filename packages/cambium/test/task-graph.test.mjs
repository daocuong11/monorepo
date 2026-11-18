// @ts-check
/** The `task` graph itself: its shape and declarations, the README's diagram, and where an issue resumes. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveConfig } from '../src/config.mjs'
import { validateGraph, toMermaid } from '../src/graph/index.mjs'
import { locate } from '../src/graph-engine.mjs'
import { nodeOf, task, TASK_QUEUES } from '../src/graphs/task.mjs'
import { newMarker, parseMarker } from '../src/marker.mjs'
import { tick } from '../src/tick.mjs'
import { harness, T0 } from './fakes.mjs'

test('task graph: nine nodes, four waits, valid', () => {
  assert.deepEqual(validateGraph(task), [])
  assert.deepEqual(
    task.nodes.map((n) => n.name),
    [
      'start-worker',
      'worker-running',
      'ci-running',
      'merge',
      'merging',
      'merge-queue',
      'close-out',
      'requeue',
      'to-human',
    ],
  )
  assert.deepEqual(
    task.nodes.filter((n) => n.kind === 'wait').map((n) => n.name),
    ['worker-running', 'ci-running', 'merging', 'merge-queue'],
  )
  assert.equal(task.entry.queue, 'q:task')
  assert.equal(task.entry.node, 'start-worker')
})

test('each node declares its queue label and whether it holds running', () => {
  const decl = Object.fromEntries(task.nodes.map((n) => [n.name, [nodeOf(n.name).queue, nodeOf(n.name).running]]))
  assert.deepEqual(decl, {
    'start-worker': ['q:task', false],
    'worker-running': ['q:task', true],
    'ci-running': [null, false],
    merge: [null, false],
    merging: [null, false],
    'merge-queue': [null, false],
    'close-out': [null, false],
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

test('locate: the label wins, a queued submission resumes at merge-queue, a vanished node restarts', () => {
  assert.deepEqual(locate(issueWith(['q:task'], null), T0), { node: 'start-worker', input: {} })
  assert.deepEqual(locate(issueWith(['q:task'], { node: 'ci-running', pr: 3 }), T0), {
    node: 'start-worker',
    input: {},
  })
  assert.deepEqual(locate(issueWith([], { stage: 'submitted', pr: 3, branch: 'b', queued: true }), T0), {
    node: 'merge-queue',
    input: { pr: 3, branch: 'b' },
  })
  assert.deepEqual(locate(issueWith([], { node: 'ci-running', pr: 3, branch: 'b' }), T0), {
    node: 'ci-running',
    input: { pr: 3, branch: 'b' },
  })
  const gone = locate(issueWith([], { node: 'review', graphVersion: 0 }), T0)
  assert.equal(gone?.node, 'start-worker')
  assert.equal(gone?.note?.outcome, 'graph-changed')
})

test('graph engine: a marker at a node the graph no longer has goes back to q:task with a history note', async () => {
  const h = harness({
    issues: [{ number: 40, labels: [] }],
    prs: [{ number: 400, closes: [40] }],
    config: { engine: 'graph', phases: { task: { cap: 0 } } },
  })
  h.gh.issue(40).comment = {
    id: 2,
    body: `<!-- cambium:state ${JSON.stringify({ v: 2, graph: 'task', graphVersion: 0, node: 'review', status: 'waiting', attempt: 1, history: [] })} -->`,
  }
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(40).labels, ['q:task'])
  const m = parseMarker(h.gh.issue(40).comment.body)
  assert.equal(m?.node, 'start-worker')
  assert.equal(m?.graphVersion, task.version)
  assert.equal(m?.history.at(-1)?.outcome, 'graph-changed')
})
