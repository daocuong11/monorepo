// @ts-check
/** The graph module: node contracts, data edges, load-time validation, Mermaid, and the advance loop. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  advance,
  defineGraph,
  defineNode,
  defineWait,
  describeGraph,
  END,
  GraphNodeError,
  toMermaid,
  validateGraph,
} from '@oakgreencc/cambium/graph'

const Num = z.object({ n: z.number() })
const inc = defineNode({ name: 'inc', input: Num, output: Num, run: ({ n }) => ({ n: n + 1 }) })
const dbl = defineNode({ name: 'dbl', input: Num, output: Num, run: ({ n }) => ({ n: n * 2 }) })

/** A wait that is ready once `ctx.open` is true. */
const gate = defineWait({
  name: 'gate',
  input: Num,
  output: Num,
  poll: (input, ctx) => (ctx.open ? { ready: true, output: input } : { ready: false }),
})

/** inc -> gate -> (n even) dbl | inc ; dbl -> END */
const even = (/** @type {{ n: number }} */ out) => out.n % 2 === 0
const sample = () =>
  defineGraph({
    name: 'sample',
    version: 1,
    entry: { queue: 'q:task', node: 'inc' },
    nodes: [inc, gate, dbl],
    edges: [
      ['inc', 'gate'],
      ['gate', 'dbl', even],
      ['gate', 'inc'],
      ['dbl', END],
    ],
  })

test('graph: exported as @oakgreencc/cambium/graph with the documented API', () => {
  assert.equal(typeof END, 'string')
  for (const f of [advance, defineGraph, defineNode, defineWait, describeGraph, toMermaid, validateGraph])
    assert.equal(typeof f, 'function')
})

test('graph: defineNode/defineWait reject a missing schema or function', () => {
  assert.throws(() => defineNode(/** @type {any} */ ({ name: 'x', input: Num, output: {}, run: () => {} })), /output/)
  assert.throws(() => defineWait(/** @type {any} */ ({ name: 'x', input: Num, output: Num })), /poll/)
  assert.throws(() => defineNode(/** @type {any} */ ({ name: '', input: Num, output: Num, run: () => {} })), /name/)
})

test('graph: input is validated before run, output after, and the error names the node and the issue', async () => {
  let ran = 0
  const bad = defineNode({
    name: 'bad',
    input: Num,
    output: Num,
    run: () => {
      ran++
      return { n: 'x' }
    },
  })
  const g = defineGraph({ name: 'g', version: 1, entry: { node: 'bad' }, nodes: [bad], edges: [['bad', END]] })

  const r1 = await advance(g, { node: 'bad', input: { n: 'nope' } })
  assert.equal(r1.reason, 'error')
  assert.equal(ran, 0, 'run never sees invalid input')
  assert.ok(r1.error instanceof GraphNodeError)
  assert.equal(r1.error.node, 'bad')
  assert.equal(r1.error.phase, 'input')
  assert.match(r1.error.message, /^node "bad": invalid input: n: /)

  const r2 = await advance(g, { node: 'bad', input: { n: 1 } })
  assert.equal(ran, 1)
  assert.equal(r2.error?.phase, 'output')
  assert.match(r2.error?.message ?? '', /^node "bad": invalid output: n: /)
  assert.deepEqual(r2.transitions, [])
  assert.deepEqual([r2.node, r2.input], ['bad', { n: 1 }])
})

test('graph: a wait validates its input before poll and its output after; a throw is a node error', async () => {
  let polled = 0
  const w = defineWait({
    name: 'w',
    input: Num,
    output: Num,
    poll: () => {
      polled++
      return { ready: true, output: {} }
    },
  })
  const g = defineGraph({ name: 'g', version: 1, entry: { node: 'w' }, nodes: [w], edges: [['w', END]] })
  assert.equal((await advance(g, { node: 'w', input: {} })).error?.phase, 'input')
  assert.equal(polled, 0)
  const r = await advance(g, { node: 'w', input: { n: 1 } })
  assert.match(r.error?.message ?? '', /^node "w": invalid output: n: /)

  const boom = defineNode({
    name: 'boom',
    input: Num,
    output: Num,
    run: () => {
      throw new Error('kaput')
    },
  })
  const g2 = defineGraph({ name: 'g', version: 1, entry: { node: 'boom' }, nodes: [boom], edges: [['boom', END]] })
  const r2 = await advance(g2, { node: 'boom', input: { n: 1 } })
  assert.equal(r2.error?.message, 'node "boom": run failed: kaput')
})

test('graph: schemas are used through Standard Schema, so parsed values reach run', async () => {
  const Coerced = z.object({ n: z.coerce.number() })
  const seen = []
  const n = defineNode({
    name: 'n',
    input: Coerced,
    output: Num,
    run: (i) => {
      seen.push(i)
      return i
    },
  })
  const g = defineGraph({ name: 'g', version: 1, entry: { node: 'n' }, nodes: [n], edges: [['n', END]] })
  await advance(g, { node: 'n', input: { n: '4' } })
  assert.deepEqual(seen, [{ n: 4 }])

  /** A hand-rolled Standard Schema, no zod. */
  const any = { '~standard': { version: 1, vendor: 'test', validate: (/** @type {unknown} */ value) => ({ value }) } }
  const plain = defineNode({ name: 'p', input: any, output: any, run: (i) => i })
  const g2 = defineGraph({ name: 'g', version: 1, entry: { node: 'p' }, nodes: [plain], edges: [['p', END]] })
  assert.equal((await advance(g2, { node: 'p', input: 7 })).reason, 'end')
})

test('graph: edges are tried in order, first match wins, map defaults to identity and gets the subject', async () => {
  const Tag = z.object({ n: z.number(), tag: z.string() })
  const a = defineNode({ name: 'a', input: Num, output: Num, run: (i) => i })
  const big = defineNode({ name: 'big', input: Tag, output: Tag, run: (i) => i })
  const small = defineNode({ name: 'small', input: Num, output: Num, run: (i) => i })
  const g = defineGraph({
    name: 'g',
    version: 1,
    entry: { node: 'a' },
    nodes: [a, big, small],
    edges: [
      ['a', 'big', (o) => o.n > 10, (o, subject) => ({ ...o, tag: `${subject}` })],
      ['a', 'big', (o) => o.n > 0, () => ({ n: -1 })],
      ['a', 'small'],
      ['big', END],
      ['small', END],
    ],
  })
  const r = await advance(g, { node: 'a', input: { n: 11 } }, { subject: 'o/r#1' })
  assert.deepEqual(
    r.transitions.map((t) => [t.from, t.to, t.edge, t.next]),
    [
      ['a', 'big', 0, { n: 11, tag: 'o/r#1' }],
      ['big', END, 3, { n: 11, tag: 'o/r#1' }],
    ],
  )
  const r2 = await advance(g, { node: 'a', input: { n: 5 } })
  assert.equal(r2.reason, 'error', 'the second edge matched, and its map gave big an input without tag')
  assert.deepEqual(r2.transitions[0].next, { n: -1 })
  assert.match(r2.error?.message ?? '', /^node "big": invalid input: tag: /)
  const r3 = await advance(g, { node: 'a', input: { n: -3 } })
  assert.deepEqual(
    r3.transitions.map((t) => [t.to, t.next]),
    [
      ['small', { n: -3 }],
      [END, { n: -3 }],
    ],
  )
  assert.deepEqual([r3.reason, r3.node, r3.input], ['end', END, { n: -3 }])
})

test('graph: validateGraph rejects bad endpoints, unreachable nodes, missing fallbacks, duplicates, bad version', () => {
  assert.deepEqual(validateGraph(sample()), [])
  const base = { name: 'g', version: 1, entry: { node: 'inc' }, nodes: [inc, dbl], edges: [] }
  /** @param {any} over */
  const problems = (over) => validateGraph(/** @type {any} */ ({ ...base, ...over }))

  assert.deepEqual(
    problems({
      edges: [
        ['inc', 'nope'],
        ['dbl', END],
      ],
      nodes: [inc],
    }),
    ['edge 0 (inc -> nope): unknown to "nope"', 'edge 1 (dbl -> __end__): unknown from "dbl"'],
  )
  assert.deepEqual(problems({ edges: [['inc', END]] }), ['node "dbl" is unreachable from entry "inc"'])
  assert.deepEqual(
    problems({
      edges: [
        ['inc', 'dbl', even],
        ['dbl', END],
      ],
    }),
    ['node "inc" has no unconditional fallback edge (its last edge must have no when)'],
  )
  assert.deepEqual(
    problems({
      edges: [
        ['inc', 'dbl'],
        ['inc', END, even],
        ['dbl', END],
      ],
    }),
    ['node "inc" has no unconditional fallback edge (its last edge must have no when)'],
  )
  assert.deepEqual(problems({ nodes: [inc, inc], edges: [['inc', END]] }), ['duplicate node name "inc"'])
  assert.deepEqual(
    problems({
      version: 1.5,
      edges: [
        ['inc', 'dbl'],
        ['dbl', END],
      ],
    }),
    ['version must be an integer, got 1.5'],
  )
  assert.deepEqual(
    problems({
      version: '1',
      edges: [
        ['inc', 'dbl'],
        ['dbl', END],
      ],
    }),
    ['version must be an integer, got "1"'],
  )
  assert.deepEqual(problems({ entry: { node: 'zzz' }, edges: [['inc', 'dbl']] }), ['entry.node "zzz" is not a node'])
  assert.deepEqual(problems({ edges: [['inc', 'dbl']] }), [], 'a node with no outgoing edges is terminal')
  assert.throws(() => defineGraph(/** @type {any} */ ({ ...base, version: 'x' })), /graph "g" is invalid:\n- version/)
})

test('graph: advance runs steps and ready waits, stops on a wait that is not ready, and returns every transition', async () => {
  const g = sample()
  const held = await advance(g, { node: 'inc', input: { n: 1 } }, { open: false })
  assert.equal(held.reason, 'waiting')
  assert.deepEqual([held.node, held.input], ['gate', { n: 2 }])
  assert.deepEqual(
    held.transitions.map((t) => `${t.from}->${t.to}`),
    ['inc->gate'],
  )

  const done = await advance(g, { node: held.node, input: held.input }, { open: true })
  assert.equal(done.reason, 'end')
  assert.deepEqual(
    done.transitions.map((t) => [t.from, t.to, t.input, t.output]),
    [
      ['gate', 'dbl', { n: 2 }, { n: 2 }],
      ['dbl', END, { n: 2 }, { n: 4 }],
    ],
  )
  assert.deepEqual(done.input, { n: 4 })
})

test('graph: advance stops after maxTransitions (default 8)', async () => {
  // inc loops on itself until n > 100, far past any limit used here.
  const loop = defineGraph({
    name: 'loop',
    version: 1,
    entry: { node: 'inc' },
    nodes: [inc],
    edges: [
      ['inc', END, (o) => o.n > 100],
      ['inc', 'inc'],
    ],
  })
  const r = await advance(loop, { node: 'inc', input: { n: 0 } })
  assert.equal(r.reason, 'limit')
  assert.equal(r.transitions.length, 8)
  assert.deepEqual([r.node, r.input], ['inc', { n: 8 }])
  const r3 = await advance(loop, { node: 'inc', input: { n: 0 } }, {}, { maxTransitions: 3 })
  assert.deepEqual([r3.reason, r3.transitions.length, r3.input], ['limit', 3, { n: 3 }])
})

test('graph: advance stops at an AbortSignal deadline and passes ctx through with ctx.signal', async () => {
  const ac = new AbortController()
  /** @type {any[]} */
  const ctxs = []
  const slow = defineNode({
    name: 'slow',
    input: Num,
    output: Num,
    run: (i, ctx) => {
      ctxs.push(ctx)
      if (i.n === 2) ac.abort()
      return { n: i.n + 1 }
    },
  })
  const g = defineGraph({ name: 'g', version: 1, entry: { node: 'slow' }, nodes: [slow], edges: [['slow', 'slow']] })
  const deps = { github: { tag: 'fake' } }
  const r = await advance(g, { node: 'slow', input: { n: 0 } }, { deps }, { signal: ac.signal })
  assert.equal(r.reason, 'aborted')
  assert.equal(r.transitions.length, 3, 'the node running at the deadline finishes its transition')
  assert.deepEqual([r.node, r.input], ['slow', { n: 3 }])
  assert.equal(ctxs[0].deps, deps)
  assert.equal(ctxs[0].signal, ac.signal)

  const pre = await advance(g, { node: 'slow', input: { n: 0 } }, { signal: AbortSignal.abort() })
  assert.deepEqual([pre.reason, pre.transitions.length], ['aborted', 0])
})

test('graph: toMermaid snapshot', () => {
  assert.equal(
    toMermaid(sample()),
    `flowchart TD
  start_(["q:task"])
  n0["inc"]
  n1{{"gate"}}
  n2["dbl"]
  end_(("end"))
  start_ --> n0
  n0 --> n1
  n1 -->|"even"| n2
  n1 --> n0
  n2 --> end_
`,
  )
})

test('graph: describeGraph is plain JSON with kinds, declared labels, abouts and condition names', () => {
  const g = defineGraph({
    name: 'sample',
    version: 3,
    about: 'counts up',
    entry: { queue: 'q:task', node: 'inc' },
    nodes: [{ ...inc, queue: 'q:task', running: true, about: 'adds one' }, gate, dbl],
    edges: [
      ['inc', 'gate'],
      ['gate', 'dbl', even],
      ['gate', 'inc'],
      ['dbl', END],
    ],
  })
  const d = describeGraph(g)
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d, 'survives JSON')
  assert.deepEqual(d, {
    name: 'sample',
    version: 3,
    about: 'counts up',
    entry: { queue: 'q:task', node: 'inc' },
    nodes: [
      { name: 'inc', kind: 'step', queue: 'q:task', running: true, about: 'adds one' },
      { name: 'gate', kind: 'wait', queue: null, running: false, about: null },
      { name: 'dbl', kind: 'step', queue: null, running: false, about: null },
    ],
    edges: [
      { from: 'inc', to: 'gate', when: null },
      { from: 'gate', to: 'dbl', when: 'even' },
      { from: 'gate', to: 'inc', when: null },
      { from: 'dbl', to: null, when: null },
    ],
  })
  assert.equal(describeGraph(sample()).about, null)
})
