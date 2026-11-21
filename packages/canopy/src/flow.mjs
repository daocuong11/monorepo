// @ts-check
/**
 * How work moved through cambium's graphs, from the trace file: the Graphs tab draws each graph from the heartbeat
 * (cambium's `graphs`) and lays this over it. Every `cambium.node` and `cambium.wait` span names its graph and
 * node; within one trace, consecutive steps in the same graph are one move along an edge.
 */

/** The newest moves kept for the replay; older ones in the window still count toward the totals. */
export const MOVES_KEPT = 600

/**
 * @typedef {import('./traces.mjs').Span} Span
 * @typedef {{ graph: string, node: string, start: number, end: number, error: boolean, outcome: string | null }} Step
 * @typedef {{ visits: number, errors: number, medianMs: number | null, lastAt: number | null }} NodeFlow
 * @typedef {{ from: string | null, to: string, n: number }} EdgeFlow
 *   `from: null`: the issue entered the graph here.
 * @typedef {{ from: string | null, to: string, at: number, issue: string | null, error: boolean }} Move
 * @typedef {{ nodes: Record<string, NodeFlow>, edges: EdgeFlow[], moves: Move[], total: number }} GraphFlow
 *   `moves` are the newest {@link MOVES_KEPT} in the window, oldest first; `total` counts them all.
 * @typedef {{ graph: string, node: string, at: number, outcome: string | null }} LastStep
 * @typedef {{ sinceMs: number, graphs: Record<string, GraphFlow>, at: Record<string, LastStep> }} Flow
 *   `at`: per `owner/name#n`, the newest step any of its traces recorded, whenever it was.
 */

/** @param {Span[]} spans @returns {Step[]} */
function stepsOf(spans) {
  /** @type {Step[]} */
  const steps = []
  for (const s of spans) {
    if (s.name !== 'cambium.node' && s.name !== 'cambium.wait') continue
    const graph = s.attrs['cambium.graph']
    const node = s.attrs['cambium.node']
    if (typeof graph !== 'string' || typeof node !== 'string') continue
    const outcome = s.attrs['cambium.outcome']
    steps.push({
      graph,
      node,
      start: s.start,
      end: s.end,
      error: s.status === 'error',
      outcome: outcome == null ? null : String(outcome),
    })
  }
  // A wait's span is written when it ends and starts when the issue entered it, so the end orders them.
  return steps.sort((a, b) => a.end - b.end || a.start - b.start)
}

/** @param {Span[]} spans */
function issueOf(spans) {
  for (const s of spans) {
    const repo = s.attrs['cambium.repo']
    const n = Number(s.attrs['cambium.issue.number'])
    if (typeof repo === 'string' && Number.isInteger(n) && n > 0) return `${repo}#${n}`
  }
  return null
}

/** @param {number[]} xs */
function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * @param {Map<string, Span[]>} traces
 * @param {number} now
 * @param {number} sinceMs
 * @returns {Flow}
 */
export function graphFlow(traces, now, sinceMs) {
  const from = now - sinceMs
  /** @type {Map<string, { nodes: Map<string, { visits: number, errors: number, ms: number[], lastAt: number }>, edges: Map<string, EdgeFlow>, moves: Move[] }>} */
  const graphs = new Map()
  /** @type {Record<string, LastStep>} */
  const at = {}
  const graphOf = (/** @type {string} */ name) => {
    let g = graphs.get(name)
    if (!g) {
      g = { nodes: new Map(), edges: new Map(), moves: [] }
      graphs.set(name, g)
    }
    return g
  }
  for (const spans of traces.values()) {
    const steps = stepsOf(spans)
    if (!steps.length) continue
    const issue = issueOf(spans)
    const last = steps[steps.length - 1]
    if (issue && (!at[issue] || at[issue].at < last.end))
      at[issue] = { graph: last.graph, node: last.node, at: last.end, outcome: last.outcome }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]
      if (s.end < from) continue
      const g = graphOf(s.graph)
      let n = g.nodes.get(s.node)
      if (!n) {
        n = { visits: 0, errors: 0, ms: [], lastAt: 0 }
        g.nodes.set(s.node, n)
      }
      n.visits++
      if (s.error) n.errors++
      n.ms.push(Math.max(0, s.end - s.start))
      n.lastAt = Math.max(n.lastAt, s.end)
      const prev = i > 0 && steps[i - 1].graph === s.graph ? steps[i - 1] : null
      const key = `${prev ? prev.node : ''}\u0000${s.node}`
      const e = g.edges.get(key)
      if (e) e.n++
      else g.edges.set(key, { from: prev ? prev.node : null, to: s.node, n: 1 })
      // The issue left the previous step when it ended; an entry arrives when its first step starts.
      g.moves.push({ from: prev ? prev.node : null, to: s.node, at: prev ? prev.end : s.start, issue, error: s.error })
    }
  }
  /** @type {Record<string, GraphFlow>} */
  const out = {}
  for (const [name, g] of graphs) {
    const moves = g.moves.filter((m) => m.at >= from).sort((a, b) => a.at - b.at)
    out[name] = {
      nodes: Object.fromEntries(
        [...g.nodes].map(([node, n]) => [
          node,
          { visits: n.visits, errors: n.errors, medianMs: median(n.ms), lastAt: n.lastAt || null },
        ]),
      ),
      edges: [...g.edges.values()].sort((a, b) => b.n - a.n),
      moves: moves.slice(-MOVES_KEPT),
      total: moves.length,
    }
  }
  return { sinceMs, graphs: out, at }
}
