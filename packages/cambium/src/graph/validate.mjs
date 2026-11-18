// @ts-check
/** Load-time checks on a graph value. */

/** The terminal target of an edge. A string, so a graph stays plain data. */
export const END = '__end__'

/**
 * Every problem with `graph`, as readable strings; empty when it is valid.
 *
 * - `name` is a non-empty string and `version` an integer;
 * - node names are unique (and not END);
 * - `entry.node` and every edge endpoint name a node (`to` may be END; `from` may not);
 * - `when` and `map`, when given, are functions;
 * - every node is reachable from `entry.node`;
 * - every non-terminal node (one with outgoing edges) ends its edges with an unconditional fallback.
 *   A node with no outgoing edges is terminal: the graph ends after it.
 * @param {import('./define.mjs').Graph} graph
 * @returns {string[]}
 */
export function validateGraph(graph) {
  /** @type {string[]} */
  const problems = []
  if (typeof graph !== 'object' || graph === null) return ['graph must be an object']
  const { name, version, entry, nodes, edges } = graph
  if (typeof name !== 'string' || !name) problems.push('name must be a non-empty string')
  if (!Number.isInteger(version)) problems.push(`version must be an integer, got ${JSON.stringify(version)}`)
  if (!Array.isArray(nodes) || !nodes.length) return [...problems, 'nodes must be a non-empty array']
  if (!Array.isArray(edges)) return [...problems, 'edges must be an array']

  const names = new Set()
  for (const n of nodes) {
    if (n?.name === END) problems.push(`node name "${END}" is reserved`)
    else if (names.has(n?.name)) problems.push(`duplicate node name "${n?.name}"`)
    names.add(n?.name)
  }

  if (typeof entry?.node !== 'string' || !names.has(entry.node))
    problems.push(`entry.node ${JSON.stringify(entry?.node)} is not a node`)
  if (entry?.input !== undefined && typeof entry.input !== 'function') problems.push('entry.input must be a function')

  /** @type {Map<string, import('./define.mjs').Edge[]>} */
  const out = new Map()
  for (const [i, e] of edges.entries()) {
    if (!Array.isArray(e) || e.length < 2) {
      problems.push(`edge ${i} must be [from, to, when?, map?]`)
      continue
    }
    const [from, to, when, map] = e
    if (!names.has(from)) problems.push(`edge ${i} (${from} -> ${to}): unknown from "${from}"`)
    if (to !== END && !names.has(to)) problems.push(`edge ${i} (${from} -> ${to}): unknown to "${to}"`)
    if (when != null && typeof when !== 'function')
      problems.push(`edge ${i} (${from} -> ${to}): when must be a function`)
    if (map !== undefined && typeof map !== 'function')
      problems.push(`edge ${i} (${from} -> ${to}): map must be a function`)
    out.set(from, [...(out.get(from) ?? []), e])
  }

  for (const [from, list] of out) {
    if (!names.has(from)) continue
    if (list[list.length - 1][2] != null)
      problems.push(`node "${from}" has no unconditional fallback edge (its last edge must have no when)`)
  }

  if (names.has(entry?.node)) {
    const seen = new Set([entry.node])
    const todo = [entry.node]
    while (todo.length) {
      for (const [, to] of out.get(/** @type {string} */ (todo.pop())) ?? [])
        if (names.has(to) && !seen.has(to)) {
          seen.add(to)
          todo.push(to)
        }
    }
    for (const n of names) if (!seen.has(n)) problems.push(`node "${n}" is unreachable from entry "${entry.node}"`)
  }
  return problems
}
