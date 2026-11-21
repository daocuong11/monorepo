// @ts-check
/**
 * A graph as plain JSON, for the heartbeat: what a reader (canopy's Graphs tab) needs to draw it without importing
 * cambium. Schemas and functions are dropped; a conditional edge keeps its `when`'s name.
 */
import { END } from './validate.mjs'

/**
 * @typedef {{
 *   name: string, kind: 'step' | 'wait', queue: string | null, running: boolean, about: string | null,
 * }} NodeDescription
 *   `queue`/`running`: the labels an issue resting at the node carries, when the graph declares them.
 * @typedef {{ from: string, to: string | null, when: string | null }} EdgeDescription
 *   `to: null` ends the graph. `when: null` is the unconditional fallback, taken when no condition before it holds.
 * @typedef {{
 *   name: string, version: number, about: string | null, entry: { queue: string | null, node: string },
 *   nodes: NodeDescription[], edges: EdgeDescription[],
 * }} GraphDescription
 */

/** @param {unknown} v */
const str = (v) => (typeof v === 'string' && v ? v : null)

/**
 * @param {import('./define.mjs').Graph} graph
 * @returns {GraphDescription}
 */
export function describeGraph(graph) {
  return {
    name: graph.name,
    version: graph.version,
    about: str(graph.about),
    entry: { queue: str(graph.entry.queue), node: graph.entry.node },
    nodes: graph.nodes.map((n) => {
      const d = /** @type {{ queue?: unknown, running?: unknown, about?: unknown }} */ (n)
      return {
        name: n.name,
        kind: n.kind === 'wait' ? 'wait' : 'step',
        queue: str(d.queue),
        running: d.running === true,
        about: str(d.about),
      }
    }),
    edges: graph.edges.map(([from, to, when]) => ({
      from,
      to: to === END ? null : to,
      when: when ? when.name || 'when' : null,
    })),
  }
}
