// @ts-check
/**
 * `@oakgreencc/cambium/graph/langgraph`: LangGraph interop for cambium graphs.
 *
 * LangGraph is not a dependency of cambium: install `@langchain/langgraph` (and its peer `@langchain/core`)
 * yourself to use this module. Nothing here imports it at load time; {@link toLangGraph} imports it when called,
 * unless you pass the module in as `{ langgraph }`.
 *
 * - Export, {@link toLangGraph}: a cambium graph as an uncompiled `StateGraph` whose state is
 *   `{ subject, last, outputs }`. A wait node calls `interrupt({ waiting, input })`; resume it with what its
 *   `poll` returned as `output` ({@link pollWait} runs the poll for you).
 * - Import, {@link fromLangGraph}: a compiled LangGraph graph as one cambium step node.
 */
import { randomUUID } from 'node:crypto'
import { asNodeError, pick } from './advance.mjs'
import { check, defineNode, END, GraphNodeError } from './define.mjs'

/**
 * @typedef {import('./define.mjs').Graph} Graph
 * @typedef {import('./define.mjs').StandardSchema} StandardSchema
 * @typedef {{ subject: unknown, last: unknown, outputs: Record<string, unknown> }} State
 *   `last` is the input of the node about to run: the previous node's output, through its edge's `map`.
 *   `outputs` holds each node's latest output, by node name.
 * @typedef {{ waiting: string, input: unknown }} Waiting  The value a wait node passes to `interrupt()`.
 * @typedef {typeof import('@langchain/langgraph')} LangGraphModule
 */

/** @param {LangGraphModule | undefined} injected @returns {Promise<LangGraphModule>} */
async function load(injected) {
  if (injected) return injected
  try {
    return await import('@langchain/langgraph')
  } catch (err) {
    throw new Error('toLangGraph needs @langchain/langgraph (and @langchain/core): install them alongside cambium', {
      cause: err,
    })
  }
}

/**
 * The ctx a node gets: LangGraph's run `context` (`invoke(input, { context })`), with the run's `signal`.
 * @param {any} config @returns {Record<string, unknown>}
 */
const ctxOf = (config) => {
  const ctx = config?.context ?? {}
  return { ...ctx, signal: config?.signal ?? ctx.signal }
}

/**
 * `graph` as an uncompiled LangGraph `StateGraph`. Compile it with a checkpointer when the graph has waits.
 *
 * - State: `{ subject, last, outputs }`. Start a run with `{ subject, last: <entry input> }`; `subject` is what
 *   edge `when`/`map` see (cambium's advance passes `ctx.subject`), so it is checkpointed and must be serializable.
 * - Nodes get `{ ...context, signal }` as ctx, where `context` is the run's `invoke(…, { context })`.
 * - A step node validates `last`, runs, validates its output, picks its edge as advance does, and writes
 *   `outputs[name]` and `last` (the chosen edge's `map` is applied here: a LangGraph router cannot write state).
 * - A wait node validates `last` and calls `interrupt({ waiting: name, input })`; the resume value is the
 *   ready poll's `output`, validated against the wait's output schema. Not-ready polls never reach LangGraph:
 *   poll outside ({@link pollWait}) and resume only when ready.
 * - Edges: `addConditionalEdges(from, router)`, the router trying `when` in order on `outputs[from]`; a node with
 *   no outgoing edges goes to LangGraph's END. Errors are thrown as cambium's `GraphNodeError`.
 *
 * @param {Graph} graph
 * @param {{ langgraph?: LangGraphModule }} [opts] the `@langchain/langgraph` module, instead of importing it
 */
export async function toLangGraph(graph, opts = {}) {
  const lg = await load(opts.langgraph)
  const { Annotation, StateGraph, START, interrupt } = lg
  const LG_END = lg.END
  const State = Annotation.Root({
    subject: Annotation(),
    last: Annotation(),
    outputs: Annotation({
      reducer: (/** @type {Record<string, unknown>} */ a, /** @type {Record<string, unknown>} */ b) => ({ ...a, ...b }),
      default: () => ({}),
    }),
  })
  const sg = new StateGraph(State)
  const Any = {
    '~standard': { version: 1, vendor: 'cambium', validate: (/** @type {unknown} */ value) => ({ value }) },
  }

  for (const node of graph.nodes) {
    const { name } = node
    /** @param {unknown} output @param {unknown} subject */
    const settle = (output, subject) => {
      let next
      try {
        ;({ next } = pick(graph, name, output, subject))
      } catch (err) {
        throw asNodeError(err, name, 'edge')
      }
      return { last: next, outputs: { [name]: output } }
    }
    /** @param {State} state @param {any} config */
    const fn =
      node.kind === 'wait'
        ? async (state) => {
            const input = await check(node.input, state.last, name, 'input')
            const resumed = interrupt(/** @type {Waiting} */ ({ waiting: name, input }))
            return settle(await check(node.output, resumed, name, 'output'), state.subject)
          }
        : async (state, config) => {
            const input = await check(node.input, state.last, name, 'input')
            let out
            try {
              out = await node.run(input, ctxOf(config))
            } catch (err) {
              throw asNodeError(err, name, 'run')
            }
            return settle(await check(node.output, out, name, 'output'), state.subject)
          }
    sg.addNode(name, fn, { input: new lg.StateSchema({ subject: Any, last: node.input }) })
  }

  sg.addEdge(START, /** @type {any} */ (graph.entry.node))
  /** @type {Map<string, import('./define.mjs').Edge[]>} */
  const out = new Map()
  for (const e of graph.edges) out.set(e[0], [...(out.get(e[0]) ?? []), e])
  const target = (/** @type {string} */ to) => (to === END ? LG_END : to)
  for (const node of graph.nodes) {
    const edges = out.get(node.name)
    if (!edges) {
      sg.addEdge(/** @type {any} */ (node.name), LG_END)
      continue
    }
    const ends = [...new Set(edges.map(([, to]) => target(to)))]
    /** @param {State} state */
    const router = (state) => {
      const o = state.outputs[node.name]
      for (const [, to, when] of edges) if (!when || when(o, state.subject)) return target(to)
      throw new GraphNodeError(node.name, 'edge', 'no edge matched the output')
    }
    sg.addConditionalEdges(/** @type {any} */ (node.name), router, /** @type {any} */ (ends))
  }
  return sg
}

/**
 * Poll the wait a LangGraph run is interrupted at: `{ ready: true, output }` means resume with
 * `new Command({ resume: output })`; `{ ready: false }` means leave the thread where it is.
 * @param {Graph} graph @param {Waiting} waiting the interrupt's value @param {Record<string, unknown>} [ctx]
 * @returns {Promise<import('./define.mjs').PollResult>}
 */
export async function pollWait(graph, waiting, ctx = {}) {
  const node = graph.nodes.find((n) => n.name === waiting?.waiting)
  if (node?.kind !== 'wait') throw new Error(`graph "${graph.name}" has no wait node "${waiting?.waiting}"`)
  const input = await check(node.input, waiting.input, node.name, 'input')
  let polled
  try {
    polled = await node.poll(input, ctx)
  } catch (err) {
    throw asNodeError(err, node.name, 'poll')
  }
  if (typeof polled?.ready !== 'boolean')
    throw new GraphNodeError(node.name, 'poll', 'poll must return { ready: false } or { ready: true, output }')
  return polled
}

/** @param {unknown} err */
const isInterrupt = (err) =>
  /** @type {any} */ (err)?.name === 'GraphInterrupt' ||
  /** @type {any} */ (err)?.lc_error_code === 'MISSING_CHECKPOINTER'

/**
 * A compiled LangGraph graph as one cambium step node: `run` invokes it with the node's validated input as the
 * graph's input state (passing ctx's `signal`), and its final state is validated against `output`.
 *
 * An imported graph cannot wait: an `interrupt()` inside it fails the node with an error saying so (with or
 * without a checkpointer). Its own nodes stay opaque; they are closures over its state.
 *
 * @param {{ invoke: (input: any, config?: any) => Promise<any> }} compiled
 * @param {{ name: string, input: StandardSchema, output: StandardSchema }} def
 */
export function fromLangGraph(compiled, { name, input, output }) {
  if (typeof compiled?.invoke !== 'function') throw new Error(`fromLangGraph "${name}": expected a compiled graph`)
  const interrupted = () =>
    new Error(
      `imported LangGraph graph "${name}" called interrupt(); cambium runs imported graphs to completion and cannot resume them, so model the wait as a cambium wait node instead`,
    )
  return defineNode({
    name,
    input,
    output,
    run: async (value, ctx) => {
      let result
      try {
        result = await compiled.invoke(value, {
          signal: ctx?.signal,
          configurable: { thread_id: `cambium:${name}:${randomUUID()}` },
        })
      } catch (err) {
        if (isInterrupt(err)) throw interrupted()
        throw err
      }
      if (Array.isArray(result?.__interrupt__) && result.__interrupt__.length) throw interrupted()
      return result
    },
  })
}
