// @ts-check
/**
 * LangGraph interop (`@oakgreencc/cambium/graph/langgraph`): the exported task graph against the native advance
 * loop on the tick's fakes, and a LangGraph graph imported as one cambium node. `@langchain/langgraph` is a
 * devDependency: if LangGraph drifts under the adapter, these fail in `pnpm verify`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import * as langgraph from '@langchain/langgraph'
import { advance, defineGraph, defineNode, END, GraphNodeError } from '../src/graph/index.mjs'
import { fromLangGraph, pollWait, toLangGraph } from '../src/graph/langgraph.mjs'
import { nodeOf, task } from '../src/graphs/task.mjs'
import { newCtx } from '../src/tick.mjs'
import { harness, SLUG, trace } from './fakes.mjs'

const { Annotation, Command, MemorySaver, StateGraph, START, interrupt } = langgraph

/**
 * @typedef {ReturnType<typeof harness>} Harness
 * @typedef {{
 *   number: number, seed: Parameters<typeof harness>[0], marker?: Record<string, unknown>,
 *   steps: ((h: Harness) => void)[], expect: string[],
 * }} Scenario
 *   `steps`: what the world does each time a wait is polled and not ready, in order.
 */

/**
 * One issue's world: the tick's fakes, a TaskCtx over them, and `next()`, which runs the scenario's next step
 * and re-reads the snapshot (a new tick).
 * @param {Scenario} sc
 */
async function world(sc) {
  const h = harness(sc.seed)
  if (sc.marker) h.gh.issue(sc.number).comment = { id: 1, body: `<!-- cambium:state ${JSON.stringify(sc.marker)} -->` }
  /** @type {import('../src/graphs/task.mjs').Subject} */
  const subject = { slug: SLUG, number: sc.number }
  const ctx = { ...h.deps, tick: newCtx(h.deps), subject }
  const read = async () => {
    const snap = await h.gh.github.read(SLUG)
    Object.assign(subject, { snap, issue: snap.issues.get(sc.number) })
    ctx.tick = newCtx(h.deps)
    ctx.tick.snaps.set(SLUG, snap)
  }
  await read()
  const steps = [...sc.steps]
  const next = async () => {
    const step = steps.shift()
    if (!step) throw new Error('a wait is still not ready and the scenario has no steps left')
    step(h)
    h.clock.advance(60_000)
    await read()
  }
  return { h, ctx, next }
}

/** The native runtime: advance one transition at a time, entering waits as the graph engine does. @param {Scenario} sc */
async function runNative(sc) {
  const { h, ctx, next } = await world(sc)
  /** @type {string[]} */
  const nodes = []
  /** @type {[string, unknown][]} */
  const outputs = []
  let pos = { node: task.entry.node, input: {} }
  for (;;) {
    const r = await advance(task, pos, ctx, { maxTransitions: 1 })
    if (r.error) throw r.error
    for (const t of r.transitions) {
      nodes.push(t.from)
      outputs.push([t.from, t.output])
      if (t.to !== END) await nodeOf(t.to).enter?.(t.next, ctx)
    }
    if (r.reason === 'end') break
    if (r.reason === 'waiting') await next()
    pos = { node: r.node, input: r.input }
  }
  return { nodes, outputs, trace: trace(h) }
}

/**
 * The exported graph through LangGraph: a MemorySaver thread per issue; at each interrupt, enter the wait, poll it
 * (advancing the world until it is ready) and resume with `Command({ resume: output })`.
 * @param {Scenario} sc
 */
async function runLangGraph(sc) {
  const { h, ctx, next } = await world(sc)
  const app = (await toLangGraph(task)).compile({ checkpointer: new MemorySaver() })
  const config = { configurable: { thread_id: `${SLUG}#${sc.number}` }, context: ctx, streamMode: 'updates' }
  /** @type {string[]} */
  const nodes = []
  /** @type {[string, unknown][]} */
  const outputs = []
  /** @type {unknown} */
  let input = { subject: { slug: SLUG, number: sc.number }, last: {} }
  for (;;) {
    /** @type {any} */
    let waiting = null
    for await (const chunk of await app.stream(/** @type {any} */ (input), /** @type {any} */ (config)))
      for (const [name, update] of Object.entries(chunk)) {
        if (name === '__interrupt__') waiting = /** @type {any} */ (update)[0].value
        else {
          nodes.push(name)
          outputs.push([name, /** @type {any} */ (update).outputs[name]])
        }
      }
    if (!waiting) break
    await nodeOf(waiting.waiting).enter?.(waiting.input, ctx)
    let polled = await pollWait(task, waiting, ctx)
    while (!polled.ready) {
      await next()
      polled = await pollWait(task, waiting, ctx)
    }
    input = new Command({ resume: polled.output })
  }
  const state = await app.getState(/** @type {any} */ (config))
  return { nodes, outputs, trace: trace(h), state: state.values, pending: state.next }
}

/** @type {Record<string, Scenario>} */
const SCENARIOS = {
  'green path: worker submits, CI green, merge queue, merged → closed': {
    number: 11,
    seed: { issues: [{ number: 11, labels: ['q:task'] }] },
    steps: [
      (h) => {
        h.procs.live.clear()
        h.gh.addPr({ number: 110, closes: [11], checks: 'SUCCESS' })
      },
      (h) => Object.assign(h.gh.pr(110), { inMergeQueue: true }),
      (h) => Object.assign(h.gh.pr(110), { state: 'MERGED', inMergeQueue: false }),
    ],
    expect: ['start-worker', 'worker-running', 'ci-running', 'merge-queue', 'close-out'],
  },
  'red CI: requeued, the retry exits on the red commit, attempts spent → q:human': {
    number: 12,
    seed: { issues: [{ number: 12, labels: ['q:task'] }], config: { phases: { task: { maxAttempts: 2 } } } },
    steps: [
      (h) => {
        h.procs.live.clear()
        h.gh.addPr({ number: 120, closes: [12], checks: 'PENDING', headSha: 'deadbeef00' })
      },
      (h) =>
        Object.assign(h.gh.pr(120), {
          checks: 'FAILURE',
          failing: [{ name: 'verify', url: 'https://ci/run/1', summary: '3 tests red' }],
        }),
      (h) => h.procs.live.clear(),
    ],
    expect: [
      'start-worker',
      'worker-running',
      'ci-running',
      'requeue',
      'start-worker',
      'worker-running',
      'requeue',
      'to-human',
    ],
  },
  'budget exhausted: past maxAttempts → q:human without a worker': {
    number: 13,
    seed: { issues: [{ number: 13, labels: ['q:task'] }] },
    marker: { v: 2, graph: 'task', graphVersion: 1, node: 'start-worker', status: 'waiting', attempt: 4, history: [] },
    steps: [],
    expect: ['start-worker', 'to-human'],
  },
}

for (const [name, sc] of Object.entries(SCENARIOS))
  test(`langgraph export, differential: ${name}`, async () => {
    const native = await runNative(sc)
    const lg = await runLangGraph(sc)
    assert.deepEqual(native.nodes, sc.expect)
    assert.deepEqual(lg.nodes, native.nodes, 'same node sequence')
    assert.deepEqual(lg.outputs, native.outputs, 'same outputs')
    assert.deepEqual(lg.trace, native.trace, 'same moves on the fakes')
    assert.deepEqual(lg.pending, [], 'the LangGraph thread ran to END')
    const [lastNode, lastOutput] = /** @type {[string, unknown]} */ (native.outputs.at(-1))
    assert.deepEqual(/** @type {any} */ (lg.state).outputs[lastNode], lastOutput)
  })

test('langgraph export: wait nodes interrupt with { waiting, input }; the router follows our edges', async () => {
  const sc = SCENARIOS['green path: worker submits, CI green, merge queue, merged → closed']
  const { ctx } = await world(sc)
  const app = (await toLangGraph(task, { langgraph })).compile({ checkpointer: new MemorySaver() })
  const config = { configurable: { thread_id: 't' }, context: ctx }
  const out = await app.invoke({ subject: { slug: SLUG, number: 11 }, last: {} }, config)
  assert.deepEqual(
    out.__interrupt__?.map((/** @type {any} */ i) => i.value.waiting),
    ['worker-running'],
  )
  assert.deepEqual(out.__interrupt__?.[0].value.input, { branch: 'agent/11-issue-11', attempt: 1 })
  // `last` is start-worker's output (no edge map); the wait's validated input drops what its schema does not name.
  assert.equal(/** @type {any} */ (out.outputs)['start-worker'].to, 'running')
  assert.deepEqual(out.last, /** @type {any} */ (out.outputs)['start-worker'])
  // A resume value that is not the wait's output fails as cambium's GraphNodeError.
  await assert.rejects(app.invoke(new Command({ resume: { exit: 'nope' } }), config), (err) => {
    assert.ok(err instanceof GraphNodeError, String(err))
    assert.equal(err.node, 'worker-running')
    assert.equal(err.phase, 'output')
    return true
  })
})

test('the adapter does not import LangGraph at load time', () => {
  const src = readFileSync(new URL('../src/graph/langgraph.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /^import[^\n]*@langchain/m)
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dependencies['@langchain/langgraph'], undefined)
  assert.equal(pkg.exports['./graph/langgraph'], './src/graph/langgraph.mjs')
})

// ---- Import

const Trail = Annotation.Root({
  n: Annotation(),
  trail: Annotation({
    reducer: (/** @type {string[]} */ a, /** @type {string[]} */ b) => [...a, ...b],
    default: () => [],
  }),
})

/** Three LangGraph nodes: double, add one, square. */
function threeNodes() {
  return new StateGraph(Trail)
    .addNode('double', (/** @type {any} */ s) => ({ n: s.n * 2, trail: ['double'] }))
    .addNode('inc', (/** @type {any} */ s) => ({ n: s.n + 1, trail: ['inc'] }))
    .addNode('square', (/** @type {any} */ s) => ({ n: s.n * s.n, trail: ['square'] }))
    .addEdge(START, 'double')
    .addEdge('double', 'inc')
    .addEdge('inc', 'square')
    .addEdge('square', langgraph.END)
}

const N = z.object({ n: z.number() })
/** A cambium graph with `inner` between two native step nodes. @param {import('../src/graph/define.mjs').StepNode} inner */
const around = (inner) =>
  defineGraph({
    name: 'host',
    version: 1,
    entry: { node: 'prep' },
    nodes: [
      defineNode({ name: 'prep', input: N, output: N, run: (i) => ({ n: i.n + 1 }) }),
      inner,
      defineNode({
        name: 'report',
        input: z.object({ n: z.number(), trail: z.array(z.string()) }),
        output: z.object({ line: z.string() }),
        run: (i) => ({ line: `${i.n} via ${i.trail.join('>')}` }),
      }),
    ],
    edges: [
      ['prep', inner.name],
      [inner.name, 'report'],
    ],
  })

test('langgraph import: a three-node LangGraph graph runs as one node inside a cambium graph', async () => {
  const inner = fromLangGraph(threeNodes().compile(), {
    name: 'lg',
    input: N,
    output: z.object({ n: z.number(), trail: z.array(z.string()) }),
  })
  const r = await advance(around(inner), { node: 'prep', input: { n: 2 } })
  assert.equal(r.reason, 'end', String(r.error))
  assert.deepEqual(
    r.transitions.map((t) => [t.from, t.output]),
    [
      ['prep', { n: 3 }],
      ['lg', { n: 49, trail: ['double', 'inc', 'square'] }],
      ['report', { line: '49 via double>inc>square' }],
    ],
  )
})

test("langgraph import: the imported graph's output is validated", async () => {
  const inner = fromLangGraph(threeNodes().compile(), { name: 'lg', input: N, output: z.object({ n: z.string() }) })
  const r = await advance(around(inner), { node: 'prep', input: { n: 2 } })
  assert.equal(r.reason, 'error')
  assert.equal(r.error?.node, 'lg')
  assert.equal(r.error?.phase, 'output')
})

test('langgraph import: interrupt() inside fails with a clear error, with or without a checkpointer', async () => {
  const waits = () =>
    new StateGraph(Trail)
      .addNode('ask', () => ({ n: /** @type {number} */ (interrupt({ question: 'n?' })), trail: ['ask'] }))
      .addEdge(START, 'ask')
      .addEdge('ask', langgraph.END)
  for (const compiled of [waits().compile(), waits().compile({ checkpointer: new MemorySaver() })]) {
    const inner = fromLangGraph(compiled, {
      name: 'lg',
      input: N,
      output: z.object({ n: z.number(), trail: z.array(z.string()) }),
    })
    const r = await advance(around(inner), { node: 'prep', input: { n: 2 } })
    assert.equal(r.reason, 'error')
    assert.equal(r.error?.node, 'lg')
    assert.equal(r.error?.phase, 'run')
    assert.match(String(r.error?.message), /imported LangGraph graph "lg" called interrupt\(\)/)
  }
})
