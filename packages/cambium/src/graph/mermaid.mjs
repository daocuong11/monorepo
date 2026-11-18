// @ts-check
/** A graph as a Mermaid flowchart: step nodes are boxes, waits are hexagons, conditional edges carry `when`'s name. */
import { END } from './validate.mjs'

/** @param {string} s */
const label = (s) => `"${s.replaceAll('"', '#quot;')}"`

/**
 * @param {import('./define.mjs').Graph} graph
 * @returns {string}
 */
export function toMermaid(graph) {
  const id = new Map(graph.nodes.map((n, i) => [n.name, `n${i}`]))
  id.set(END, 'end_')
  const lines = [`flowchart TD`, `  start_([${label(graph.entry.queue ?? 'start')}])`]
  for (const n of graph.nodes)
    lines.push(n.kind === 'wait' ? `  ${id.get(n.name)}{{${label(n.name)}}}` : `  ${id.get(n.name)}[${label(n.name)}]`)
  lines.push(`  end_((${label('end')}))`)
  lines.push(`  start_ --> ${id.get(graph.entry.node)}`)
  for (const [from, to, when] of graph.edges) {
    const arrow = when ? `-->|${label(when.name || 'when')}|` : '-->'
    lines.push(`  ${id.get(from)} ${arrow} ${id.get(to)}`)
  }
  return `${lines.join('\n')}\n`
}
