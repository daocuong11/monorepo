// @ts-check
/** The advance loop: run a graph from a position until a wait holds, the graph ends, or a bound is hit. */
import { check, END, GraphNodeError } from './define.mjs'

/**
 * @typedef {{ node: string, input: unknown }} Position
 * @typedef {{ from: string, to: string, edge: number | null, input: unknown, output: unknown, next: unknown }} Transition
 *   `edge` is the index into `graph.edges` (null when a terminal node ends the graph); `next` is `to`'s input.
 * @typedef {'waiting' | 'end' | 'limit' | 'aborted' | 'error'} StopReason
 * @typedef {{ transitions: Transition[], reason: StopReason, node: string, input: unknown, error?: GraphNodeError }} Advanced
 *   `node`/`input` is where it stopped: the held wait, END with the last output, the next node to run, or the failed node.
 */

/** @param {unknown} err @param {string} node @param {'run' | 'poll' | 'edge'} phase */
const asNodeError = (err, node, phase) =>
  err instanceof GraphNodeError
    ? err
    : new GraphNodeError(node, phase, String(/** @type {any} */ (err)?.message ?? err), { cause: err })

/**
 * @template T @param {string} node @param {'run' | 'poll'} phase @param {() => T} fn @returns {Promise<Awaited<T>>}
 */
async function call(node, phase, fn) {
  try {
    return await fn()
  } catch (err) {
    throw asNodeError(err, node, phase)
  }
}

/**
 * Advance `graph` from `at`. Step nodes and ready waits each take one transition; a wait that is not ready stops
 * the loop without one. Also stops after `maxTransitions`, when `signal` is aborted (checked before each node),
 * at END, or on a node error, which is returned, not thrown, so the transitions already taken are kept.
 *
 * `ctx` is opaque here: each node gets it as `{ ...ctx, signal }`. Edge `when`/`map` get `ctx.subject`.
 * @param {import('./define.mjs').Graph} graph
 * @param {Position} at
 * @param {Record<string, unknown>} [ctx]
 * @param {{ maxTransitions?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<Advanced>}
 */
export async function advance(graph, at, ctx = {}, opts = {}) {
  const { maxTransitions = 8 } = opts
  const signal = opts.signal ?? /** @type {AbortSignal | undefined} */ (ctx.signal)
  const nodeCtx = { ...ctx, signal }
  const byName = new Map(graph.nodes.map((n) => [n.name, n]))
  /** @type {Transition[]} */
  const transitions = []
  let { node: name, input } = at
  /** @param {StopReason} reason @param {GraphNodeError} [error] @returns {Advanced} */
  const stop = (reason, error) => ({ transitions, reason, node: name, input, ...(error && { error }) })

  while (name !== END) {
    if (signal?.aborted) return stop('aborted')
    if (transitions.length >= maxTransitions) return stop('limit')
    const node = byName.get(name)
    if (!node) return stop('error', new GraphNodeError(name, 'run', 'no such node in the graph'))
    try {
      const valid = await check(node.input, input, name, 'input')
      let output
      if (node.kind === 'wait') {
        const polled = await call(name, 'poll', () => node.poll(valid, nodeCtx))
        if (typeof polled?.ready !== 'boolean')
          throw new GraphNodeError(name, 'poll', 'poll must return { ready: false } or { ready: true, output }')
        if (!polled.ready) return stop('waiting')
        output = await check(node.output, polled.output, name, 'output')
      } else {
        output = await check(node.output, await call(name, 'run', () => node.run(valid, nodeCtx)), name, 'output')
      }
      const { edge, to, next } = pick(graph, name, output, ctx.subject)
      transitions.push({ from: name, to, edge, input, output, next })
      name = to
      input = next
    } catch (err) {
      return stop('error', asNodeError(err, name, 'edge'))
    }
  }
  return stop('end')
}

/**
 * The first edge out of `from` whose `when` matches `output`; a node with no outgoing edges goes to END.
 * @param {import('./define.mjs').Graph} graph @param {string} from @param {unknown} output @param {unknown} subject
 */
function pick(graph, from, output, subject) {
  let any = false
  for (const [i, [f, to, when, map]] of graph.edges.entries()) {
    if (f !== from) continue
    any = true
    if (when && !when(output, subject)) continue
    return { edge: i, to, next: map ? map(output, subject) : output }
  }
  if (!any) return { edge: null, to: END, next: output }
  throw new GraphNodeError(from, 'edge', 'no edge matched the output')
}
