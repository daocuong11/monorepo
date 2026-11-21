// @ts-check
/** The Graphs tab's parts: the heartbeat's graphs, the flow read from traces, and the layout. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { graphFlow, MOVES_KEPT } from '../src/flow.mjs'
import { layoutGraph } from '../src/graph-layout.mjs'
import { judge } from '../src/heartbeat.mjs'
import { heartbeat, T0 } from './fixtures.mjs'

/** cambium's task graph as describeGraph writes it. */
const TASK = {
  name: 'task',
  version: 2,
  about: 'Turns a q:task issue into a published PR.',
  entry: { queue: 'q:task', node: 'start-worker' },
  nodes: [
    { name: 'start-worker', kind: 'step', queue: 'q:task', running: false, about: 'Claims the issue.' },
    { name: 'worker-running', kind: 'wait', queue: 'q:task', running: true, about: 'Holds while the worker runs.' },
    { name: 'submit', kind: 'step', queue: null, running: false, about: null },
    { name: 'requeue', kind: 'step', queue: 'q:task', running: false, about: null },
    { name: 'to-human', kind: 'step', queue: 'q:human', running: false, about: null },
  ],
  edges: [
    { from: 'start-worker', to: 'worker-running', when: 'started' },
    { from: 'start-worker', to: 'to-human', when: 'budgetSpent' },
    { from: 'start-worker', to: 'requeue', when: null },
    { from: 'worker-running', to: null, when: 'issueGone' },
    { from: 'worker-running', to: 'submit', when: 'submitted' },
    { from: 'worker-running', to: 'requeue', when: null },
    { from: 'submit', to: null, when: null },
    { from: 'requeue', to: 'start-worker', when: 'attemptsLeft' },
    { from: 'requeue', to: 'to-human', when: null },
    { from: 'to-human', to: null, when: null },
  ],
}

test('heartbeat: graphs and engine pass through; dangling edges and nameless graphs are dropped', () => {
  const g = { ...TASK, edges: [...TASK.edges, { from: 'submit', to: 'nowhere', when: null }] }
  const hb = judge(heartbeat({ engine: 'graph', graphs: [g, { name: '', nodes: [] }] }), { now: T0 })
  assert.equal(hb.data.engine, 'graph')
  assert.equal(hb.data.graphs.length, 1)
  assert.deepEqual(hb.data.graphs[0], TASK)
})

test('heartbeat: an older cambium without graphs reads as null, not an empty list', () => {
  const hb = judge(heartbeat(), { now: T0 })
  assert.equal(hb.data.graphs, null)
  assert.equal(hb.data.engine, null)
})

/** @param {string} graph @param {string} node @param {number} start @param {number} end @param {boolean} [error] */
const step = (graph, node, start, end, error = false) => ({
  traceId: 't',
  spanId: `${node}${start}`,
  parentSpanId: null,
  name: node === 'worker-running' ? 'cambium.wait' : 'cambium.node',
  service: 'cambium',
  start: T0 + start,
  end: T0 + end,
  status: /** @type {'ok' | 'error'} */ (error ? 'error' : 'ok'),
  statusMessage: null,
  attrs: { 'cambium.graph': graph, 'cambium.node': node, 'cambium.repo': 'o/r', 'cambium.issue.number': 7 },
  events: [],
})

test('graphFlow: moves between consecutive steps of one graph, entries, visits, failures and where each issue is', () => {
  const traces = new Map([
    [
      'a',
      [
        step('dispatch', 'to-task', 0, 10),
        step('task', 'start-worker', 20, 30),
        // A wait's span starts when the issue entered it and is written when it ends: ordered by end.
        step('task', 'worker-running', 30, 500),
        step('task', 'requeue', 510, 520, true),
        step('task', 'start-worker', 600, 610),
      ],
    ],
  ])
  const f = graphFlow(traces, T0 + 1000, 10_000)
  const task = f.graphs.task
  assert.deepEqual(
    task.moves.map((m) => [m.from, m.to, m.at - T0, m.error]),
    [
      [null, 'start-worker', 20, false],
      ['start-worker', 'worker-running', 30, false],
      ['worker-running', 'requeue', 500, true],
      ['requeue', 'start-worker', 520, false],
    ],
  )
  assert.equal(task.total, 4)
  assert.deepEqual(task.nodes['start-worker'], { visits: 2, errors: 0, medianMs: 10, lastAt: T0 + 610 })
  assert.equal(task.nodes.requeue.errors, 1)
  assert.deepEqual(task.nodes['worker-running'].medianMs, 470)
  assert.ok(task.edges.some((e) => e.from === 'requeue' && e.to === 'start-worker' && e.n === 1))
  // The dispatch step does not lead into the task graph's entry: graphs are counted apart.
  assert.deepEqual(
    f.graphs.dispatch.moves.map((m) => [m.from, m.to]),
    [[null, 'to-task']],
  )
  assert.deepEqual(f.at['o/r#7'], { graph: 'task', node: 'start-worker', at: T0 + 610, outcome: null })
})

test('graphFlow: steps before the window are left out of the figures; only the newest moves are kept', () => {
  const old = graphFlow(new Map([['a', [step('task', 'start-worker', 0, 10)]]]), T0 + 100_000, 1000)
  assert.deepEqual(old.graphs, {})
  assert.equal(old.at['o/r#7'].node, 'start-worker', 'where an issue is does not expire with the window')
  const many = Array.from({ length: MOVES_KEPT + 5 }, (_, i) =>
    step('task', i % 2 ? 'requeue' : 'start-worker', i * 10, i * 10 + 5),
  )
  const f = graphFlow(new Map([['a', many]]), T0 + 1e7, 1e8)
  assert.equal(f.graphs.task.moves.length, MOVES_KEPT)
  assert.equal(f.graphs.task.total, MOVES_KEPT + 5)
})

test('layoutGraph: every node and edge is placed, retries run as a back edge, endings as stubs', () => {
  for (const dir of /** @type {const} */ (['LR', 'TD'])) {
    const l = layoutGraph(TASK, { dir })
    assert.equal(l.dir, dir)
    assert.deepEqual(l.nodes.map((n) => n.name).sort(), [null, ...TASK.nodes.map((n) => n.name)].sort())
    for (const n of l.nodes) {
      assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= l.width && n.y + n.h <= l.height, `${n.id} inside the drawing`)
      assert.doesNotMatch(n.shape, /NaN/)
    }
    // No two nodes overlap.
    for (const a of l.nodes)
      for (const b of l.nodes)
        if (a !== b)
          assert.ok(
            a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
            `${a.id} clear of ${b.id}`,
          )
    const byId = new Map(l.edges.map((e) => [e.id, e]))
    assert.equal(byId.get('requeue>start-worker')?.back, true)
    assert.equal(byId.get('requeue>start-worker')?.label?.text, 'attemptsLeft')
    assert.ok(byId.get('>start-worker'), 'the entry edge')
    assert.ok(byId.get('submit>')?.end, 'an ending ends in a mark')
    for (const e of l.edges) assert.doesNotMatch(e.d, /NaN|undefined/)
    assert.equal(l.edges.length, TASK.edges.length + 1)
  }
})

test('layoutGraph: parallel edges between two nodes are drawn once with every condition', () => {
  const g = {
    name: 'g',
    entry: { queue: null, node: 'a' },
    nodes: [
      { name: 'a', kind: /** @type {const} */ ('step'), queue: null, running: false, about: null },
      { name: 'b', kind: /** @type {const} */ ('step'), queue: null, running: false, about: null },
    ],
    edges: [
      { from: 'a', to: 'b', when: 'needsHuman' },
      { from: 'a', to: 'b', when: null },
      { from: 'b', to: null, when: null },
    ],
  }
  const e = layoutGraph(g).edges.find((x) => x.id === 'a>b')
  assert.deepEqual([e?.whens, e?.fallback, e?.label?.text], [['needsHuman'], true, 'needsHuman / otherwise'])
  assert.equal(layoutGraph(g).nodes.find((n) => n.kind === 'start')?.label, 'start')
})
