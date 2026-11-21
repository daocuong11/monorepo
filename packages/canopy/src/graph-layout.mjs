// @ts-check
/**
 * A layered drawing of one cambium graph, as the heartbeat describes it (cambium's `describeGraph`). Runs in the
 * page (stringified like inbox.mjs, so it must stay self-contained) and in the tests.
 *
 * Sugiyama in miniature: back edges found by a depth-first walk from the entry, layers by longest path, dummy
 * points on edges that skip a layer, crossings reduced by barycenter sweeps, then positions balanced against
 * each node's neighbours. A back edge (a retry loop) runs in a lane under everything it spans; an edge to the
 * graph's end is a short stub that ends in a terminal mark beside its node, so many endings don't converge.
 */

/**
 * @typedef {{ name: string, kind: 'step' | 'wait', queue: string | null, running: boolean, about: string | null }} GNode
 * @typedef {{ from: string, to: string | null, when: string | null }} GEdge
 * @typedef {{ name: string, entry: { queue: string | null, node: string }, nodes: GNode[], edges: GEdge[] }} GraphDesc
 * @typedef {{
 *   id: string, name: string | null, kind: 'step' | 'wait' | 'start', x: number, y: number, w: number, h: number,
 *   cx: number, cy: number, label: string, meta: string | null, shape: string,
 * }} LNode
 *   `id` is the node's name, or `\u0000start` for the entry mark (`name: null`). `shape` is an SVG path.
 * @typedef {{
 *   id: string, from: string | null, to: string | null, whens: string[], fallback: boolean, back: boolean,
 *   d: string, label: { x: number, y: number, text: string } | null, end: { x: number, y: number } | null,
 * }} LEdge
 *   `id` is `from>to` with `from` empty for the entry edge and `to` empty for an ending. Parallel edges between
 *   the same two nodes are drawn as one, carrying every condition (`whens`) and whether one is the fallback.
 * @typedef {{ dir: 'LR' | 'TD', width: number, height: number, nodes: LNode[], edges: LEdge[] }} Layout
 */

/**
 * @param {GraphDesc} g
 * @param {{ dir?: 'LR' | 'TD' }} [opts]
 * @returns {Layout}
 */
export function layoutGraph(g, opts = {}) {
  const dir = opts.dir === 'TD' ? 'TD' : 'LR'
  const LR = dir === 'LR'
  const CH = 7.3 // advance of the 12px monospace node names
  const CH_META = 6.4 // 11px meta line
  const NODE_H = 46
  const START_H = 24
  const LAYER_GAP = LR ? 72 : 56
  const ROW_GAP = LR ? 20 : 24
  const DUMMY = 14 // a dummy's slot also holds the edge's label, clear of the nodes beside it
  const STUB = 22
  const MARGIN = 16
  const LANE = 16
  const CHAMFER = 10
  const START = '\u0000start'

  /** @type {Map<string, any>} */
  const N = new Map()
  const startLabel = g.entry.queue || 'start'
  N.set(START, {
    id: START,
    name: null,
    kind: 'start',
    label: startLabel,
    meta: null,
    w: Math.round(startLabel.length * 6.6 + 26),
    h: START_H,
    real: true,
  })
  for (const n of g.nodes) {
    const meta = n.queue ? n.queue + (n.running ? ' · running' : '') : 'no queue label'
    const w = Math.round(Math.max(112, n.name.length * CH + 36, meta.length * CH_META + 36))
    N.set(n.name, { id: n.name, name: n.name, kind: n.kind, label: n.name, meta, w, h: NODE_H, real: true })
  }

  // Edges between the same two nodes are drawn once.
  /** @type {Map<string, any>} */
  const pairs = new Map()
  const addPair = (/** @type {string} */ from, /** @type {string | null} */ to, /** @type {string | null} */ when) => {
    const key = `${from}\u0001${to ?? ''}`
    let p = pairs.get(key)
    if (!p) {
      p = { from, to, whens: [], fallback: false }
      pairs.set(key, p)
    }
    if (when) p.whens.push(when)
    else p.fallback = true
  }
  addPair(START, g.entry.node, null)
  for (const e of g.edges) if (N.has(e.from) && (e.to === null || N.has(e.to))) addPair(e.from, e.to, e.when)
  const all = [...pairs.values()]
  /** @type {Map<string, any[]>} */
  const out = new Map([...N.keys()].map((k) => [k, []]))
  for (const p of all) if (p.to !== null) out.get(p.from)?.push(p)

  // Back edges: the ones that return to a node still on the depth-first path.
  /** @type {Map<string, number>} */
  const seen = new Map()
  /** @type {Map<string, number>} */
  const rank = new Map()
  const dfs = (/** @type {string} */ v) => {
    seen.set(v, 1)
    rank.set(v, rank.size)
    for (const p of out.get(v) || []) {
      const s = seen.get(p.to)
      if (s === 1) p.back = true
      else if (!s) dfs(p.to)
    }
    seen.set(v, 2)
  }
  dfs(START)
  for (const k of N.keys()) if (!seen.has(k)) dfs(k)
  const fwd = all.filter((p) => p.to !== null && !p.back)

  // Layers by longest path from the entry.
  for (const v of N.values()) v.layer = 0
  for (let i = 0; i < N.size; i++)
    for (const p of fwd) N.get(p.to).layer = Math.max(N.get(p.to).layer, N.get(p.from).layer + 1)

  // An edge that skips layers passes through a dummy point in each, so it bends around what lies between.
  let dk = 0
  for (const p of fwd) {
    p.chain = [p.from]
    const a = N.get(p.from).layer,
      b = N.get(p.to).layer
    for (let L = a + 1; L < b; L++) {
      const id = `\u0000d${dk++}`
      N.set(id, { id, layer: L, w: DUMMY, h: DUMMY, real: false })
      rank.set(id, (rank.get(p.from) ?? 0) + 0.5 + dk * 0.001)
      p.chain.push(id)
    }
    p.chain.push(p.to)
  }
  /** @type {Map<string, string[]>} */
  const up = new Map([...N.keys()].map((k) => [k, []]))
  /** @type {Map<string, string[]>} */
  const down = new Map([...N.keys()].map((k) => [k, []]))
  for (const p of fwd)
    for (let i = 1; i < p.chain.length; i++) {
      down.get(p.chain[i - 1])?.push(p.chain[i])
      up.get(p.chain[i])?.push(p.chain[i - 1])
    }

  const depth = Math.max(...[...N.values()].map((v) => v.layer))
  /** @type {string[][]} */
  const layers = Array.from({ length: depth + 1 }, () => [])
  for (const v of N.values()) layers[v.layer].push(v.id)
  for (const l of layers) l.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))

  // Fewer crossings: each node moves toward the mean position of its neighbours in the layer before (then after).
  /** @type {Map<string, number>} */
  const pos = new Map()
  const index = () => {
    for (const l of layers)
      l.forEach((id, i) => {
        pos.set(id, i)
      })
  }
  index()
  const sweep = (/** @type {number} */ L, /** @type {Map<string, string[]>} */ nb) => {
    const bc = new Map(
      layers[L].map((id) => {
        const ns = nb.get(id) || []
        return [id, ns.length ? ns.reduce((s, n) => s + (pos.get(n) ?? 0), 0) / ns.length : (pos.get(id) ?? 0)]
      }),
    )
    layers[L].sort((a, b) => (bc.get(a) ?? 0) - (bc.get(b) ?? 0) || (pos.get(a) ?? 0) - (pos.get(b) ?? 0))
    layers[L].forEach((id, i) => {
      pos.set(id, i)
    })
  }
  for (let it = 0; it < 6; it++) {
    for (let L = 1; L <= depth; L++) sweep(L, up)
    for (let L = depth - 1; L >= 0; L--) sweep(L, down)
  }

  // Main axis: across the layers (x when LR). Cross axis: along a layer.
  const mainSize = (/** @type {any} */ v) => (LR ? v.w : v.h)
  const crossSize = (/** @type {any} */ v) => (LR ? v.h : v.w)
  const layerMain = layers.map((l) => Math.max(0, ...l.map((id) => (N.get(id).real ? mainSize(N.get(id)) : 0))))
  let at = MARGIN
  /** @type {number[]} */
  const layerFrom = []
  layers.forEach((l, L) => {
    layerFrom[L] = at
    for (const id of l) N.get(id).main = at + layerMain[L] / 2
    at += layerMain[L] + LAYER_GAP
  })
  const sep = (/** @type {string} */ a, /** @type {string} */ b) => {
    const va = N.get(a),
      vb = N.get(b)
    const gap = va.real && vb.real ? ROW_GAP : va.real || vb.real ? ROW_GAP / 2 : 4
    return crossSize(va) / 2 + crossSize(vb) / 2 + gap
  }
  // Place a layer as close to the wanted positions as its order and spacing allow: the mean of a pass pushing
  // down from the top and one pushing up from the bottom, then spacing enforced once more.
  const place = (/** @type {string[]} */ l, /** @type {Map<string, number>} */ want) => {
    const A = [],
      B = []
    for (let i = 0; i < l.length; i++)
      A[i] = i ? Math.max(want.get(l[i]) ?? 0, A[i - 1] + sep(l[i - 1], l[i])) : (want.get(l[i]) ?? 0)
    for (let i = l.length - 1; i >= 0; i--)
      B[i] = i < l.length - 1 ? Math.min(want.get(l[i]) ?? 0, B[i + 1] - sep(l[i], l[i + 1])) : (want.get(l[i]) ?? 0)
    let prev = -Infinity
    l.forEach((id, i) => {
      const c = Math.max((A[i] + B[i]) / 2, i ? prev + sep(l[i - 1], id) : -Infinity)
      N.get(id).cross = c
      prev = c
    })
  }
  for (const l of layers) {
    let c = 0
    l.forEach((id, i) => {
      c += i ? sep(l[i - 1], id) : 0
      N.get(id).cross = c
    })
    const mid = c / 2
    for (const id of l) N.get(id).cross -= mid
  }
  const toward = (/** @type {number} */ L, /** @type {Map<string, string[]>} */ nb) => {
    const want = new Map(
      layers[L].map((id) => {
        const ns = nb.get(id) || []
        return [id, ns.length ? ns.reduce((s, n) => s + N.get(n).cross, 0) / ns.length : N.get(id).cross]
      }),
    )
    place(layers[L], want)
  }
  for (let it = 0; it < 4; it++) {
    for (let L = 1; L <= depth; L++) toward(L, up)
    for (let L = depth - 1; L >= 0; L--) toward(L, down)
  }
  for (let L = 1; L <= depth; L++) toward(L, up)
  const minCross = Math.min(...[...N.values()].map((v) => v.cross - crossSize(v) / 2))
  for (const v of N.values()) v.cross += MARGIN - minCross

  const pt = (/** @type {number} */ m, /** @type {number} */ c) => (LR ? [m, c] : [c, m])
  const f = (/** @type {number} */ n) => Math.round(n * 10) / 10
  const P = (/** @type {number} */ m, /** @type {number} */ c) => pt(m, c).map(f).join(' ')
  const startOf = (/** @type {any} */ v) => v.main - mainSize(v) / 2
  const endOf = (/** @type {any} */ v) => v.main + mainSize(v) / 2
  // Where an edge meets a node's side at offset `off` from its centre: a wait's chamfered tips slope inward.
  const sideAt = (/** @type {any} */ v, /** @type {number} */ off, /** @type {1 | -1} */ side) => {
    if (!v.real) return v.main
    const edge = side > 0 ? endOf(v) : startOf(v)
    if (v.kind !== 'wait') return edge
    return edge - side * CHAMFER * Math.min(1, Math.abs(off) / (crossSize(v) / 2))
  }

  // Ports: several edges leaving (or entering) one side spread out along it, ordered by where they go.
  /** @type {Map<any, number>} */
  const outOff = new Map()
  /** @type {Map<any, number>} */
  const inOff = new Map()
  const spread = (
    /** @type {any[]} */ items,
    /** @type {(p: any) => number} */ key,
    /** @type {Map<any, number>} */ into,
    /** @type {any} */ v,
  ) => {
    items.sort((a, b) => key(a) - key(b))
    const room = Math.max(0, crossSize(v) - 16)
    const step = items.length > 1 ? Math.min(8, room / (items.length - 1)) : 0
    items.forEach((p, i) => {
      into.set(p, (i - (items.length - 1) / 2) * step)
    })
  }
  for (const v of N.values()) {
    if (!v.real) continue
    const leaving = all.filter((p) => p.from === v.id && !p.back)
    spread(leaving, (p) => (p.to === null ? v.cross : N.get(p.chain[1]).cross), outOff, v)
    const arriving = fwd.filter((p) => p.to === v.id)
    spread(arriving, (p) => N.get(p.chain[p.chain.length - 2]).cross, inOff, v)
  }

  /** @type {LEdge[]} */
  const edges = []
  const cubic = (/** @type {number[]} */ a, /** @type {number[]} */ b, /** @type {number} */ t) => {
    const dm = (b[0] - a[0]) / 2,
      s = 1 - t
    const m = s * s * s * a[0] + 3 * s * s * t * (a[0] + dm) + 3 * s * t * t * (b[0] - dm) + t * t * t * b[0]
    const c = s * s * s * a[1] + 3 * s * s * t * a[1] + 3 * s * t * t * b[1] + t * t * t * b[1]
    return [m, c]
  }
  const labelText = (/** @type {any} */ p) =>
    p.whens.length ? p.whens.join(' / ') + (p.fallback ? ' / otherwise' : '') : null
  const idOf = (/** @type {any} */ p) => `${p.from === START ? '' : p.from}>${p.to ?? ''}`
  let farMain = 0,
    farCross = 0
  for (const v of N.values())
    if (v.real) {
      farMain = Math.max(farMain, endOf(v))
      farCross = Math.max(farCross, v.cross + crossSize(v) / 2)
    }

  for (const p of all) {
    if (p.back || p.to === null) continue
    const a = N.get(p.from),
      b = N.get(p.to)
    const pts = p.chain.map((/** @type {string} */ id, /** @type {number} */ i) => {
      const v = N.get(id)
      if (i === 0) {
        const o = outOff.get(p) ?? 0
        return [sideAt(a, o, 1), a.cross + o]
      }
      if (i === p.chain.length - 1) {
        const o = inOff.get(p) ?? 0
        return [sideAt(b, o, -1), b.cross + o]
      }
      return [v.main, v.cross]
    })
    let d = `M${P(pts[0][0], pts[0][1])}`
    for (let i = 1; i < pts.length; i++) {
      const [m0, c0] = pts[i - 1],
        [m1, c1] = pts[i],
        dm = (m1 - m0) / 2
      d += ` C${P(m0 + dm, c0)} ${P(m1 - dm, c1)} ${P(m1, c1)}`
    }
    // A label sits on the middle dummy of a long edge (its slot is clear of nodes), else near the far end.
    const text = labelText(p)
    const lp = !text ? null : pts.length > 2 ? pts[Math.floor((pts.length - 1) / 2)] : cubic(pts[0], pts[1], 0.6)
    edges.push({
      id: idOf(p),
      from: p.from === START ? null : p.from,
      to: p.to,
      whens: p.whens,
      fallback: p.fallback,
      back: false,
      d,
      label: lp && text ? { x: f(pt(lp[0], lp[1])[0]), y: f(pt(lp[0], lp[1])[1]), text } : null,
      end: null,
    })
  }

  // Endings: a stub off the node's leaving side, ending in the terminal mark.
  for (const p of all) {
    if (p.to !== null) continue
    const a = N.get(p.from),
      o = outOff.get(p) ?? 0
    const m0 = sideAt(a, o, 1),
      c0 = a.cross + o,
      m1 = m0 + STUB
    farMain = Math.max(farMain, m1 + 8)
    const e = pt(m1 + 5, c0)
    edges.push({
      id: idOf(p),
      from: p.from,
      to: null,
      whens: p.whens,
      fallback: p.fallback,
      back: false,
      d: `M${P(m0, c0)} L${P(m1, c0)}`,
      label: null,
      end: { x: f(e[0]), y: f(e[1]) },
    })
  }

  // An orthogonal route with rounded corners, through points given as [main, cross].
  const ortho = (/** @type {number[][]} */ pts) => {
    let d = `M${P(pts[0][0], pts[0][1])}`
    for (let i = 1; i < pts.length - 1; i++) {
      const [pm, pc] = pts[i - 1],
        [m, c] = pts[i],
        [nm, nc] = pts[i + 1]
      const ul = Math.hypot(m - pm, c - pc) || 1,
        wl = Math.hypot(nm - m, nc - c) || 1
      const r = Math.min(10, ul / 2, wl / 2)
      d +=
        ' L' +
        P(m - ((m - pm) / ul) * r, c - ((c - pc) / ul) * r) +
        ' Q' +
        P(m, c) +
        ' ' +
        P(m + ((nm - m) / wl) * r, c + ((nc - c) / wl) * r)
    }
    const z = pts[pts.length - 1]
    return `${d} L${P(z[0], z[1])}`
  }
  // Back edges run in a lane past everything they span. A node lowest in its layer is left (or entered) from below;
  // any other leaves by its far side into the gap after its layer (enters from the gap before), so the route
  // never crosses a node in its own column.
  const backs = all
    .filter((p) => p.back)
    .sort(
      (a, b) => Math.abs(N.get(a.from).layer - N.get(a.to).layer) - Math.abs(N.get(b.from).layer - N.get(b.to).layer),
    )
  const lowest = (/** @type {any} */ v) =>
    ![...N.values()].some((u) => u.real && u !== v && u.layer === v.layer && u.cross > v.cross)
  backs.forEach((p, k) => {
    const a = N.get(p.from),
      b = N.get(p.to)
    const lo = Math.min(a.layer, b.layer),
      hi = Math.max(a.layer, b.layer)
    let far = 0
    for (const v of N.values())
      if (v.real && v.layer >= lo && v.layer <= hi) far = Math.max(far, v.cross + crossSize(v) / 2)
    const lane = far + LANE + k * 12
    farCross = Math.max(farCross, lane + 8)
    const off = (/** @type {any} */ v) => crossSize(v) / 2 - 7
    const gapAfter = layerFrom[a.layer] + layerMain[a.layer] + LAYER_GAP * 0.62 + k * 6
    const gapBefore = layerFrom[b.layer] - LAYER_GAP * 0.62 - k * 6
    const head = lowest(a)
      ? [
          [a.main + 10, a.cross + crossSize(a) / 2],
          [a.main + 10, lane],
        ]
      : [
          [sideAt(a, off(a), 1), a.cross + off(a)],
          [gapAfter, a.cross + off(a)],
          [gapAfter, lane],
        ]
    const tail = lowest(b)
      ? [
          [b.main - 10, lane],
          [b.main - 10, b.cross + crossSize(b) / 2],
        ]
      : [
          [gapBefore, lane],
          [gapBefore, b.cross + off(b)],
          [sideAt(b, off(b), -1), b.cross + off(b)],
        ]
    farMain = Math.max(farMain, gapAfter + 8)
    const route = [...head, ...tail]
    const d = ortho(route)
    const text = labelText(p)
    const lp = pt((head[head.length - 1][0] + tail[0][0]) / 2, lane)
    edges.push({
      id: idOf(p),
      from: p.from === START ? null : p.from,
      to: p.to,
      whens: p.whens,
      fallback: p.fallback,
      back: true,
      d,
      label: text ? { x: f(lp[0]), y: f(lp[1]), text } : null,
      end: null,
    })
  })

  /** @type {LNode[]} */
  const nodes = []
  for (const v of N.values()) {
    if (!v.real) continue
    const [cx, cy] = pt(v.main, v.cross)
    const x = cx - v.w / 2,
      y = cy - v.h / 2
    let shape
    if (v.kind === 'wait') {
      const c = CHAMFER
      shape = LR
        ? `M${f(x + c)} ${f(y)}H${f(x + v.w - c)}L${f(x + v.w)} ${f(cy)}L${f(x + v.w - c)} ${f(y + v.h)}H${f(x + c)}L${f(x)} ${f(cy)}Z`
        : `M${f(x)} ${f(y + c)}L${f(cx)} ${f(y)}L${f(x + v.w)} ${f(y + c)}V${f(y + v.h - c)}L${f(cx)} ${f(y + v.h)}L${f(x)} ${f(y + v.h - c)}Z`
    } else {
      const r = v.kind === 'start' ? v.h / 2 : 6
      shape = `M${f(x + r)} ${f(y)}H${f(x + v.w - r)}A${r} ${r} 0 0 1 ${f(x + v.w)} ${f(y + r)}V${f(y + v.h - r)}A${r} ${r} 0 0 1 ${f(x + v.w - r)} ${f(y + v.h)}H${f(x + r)}A${r} ${r} 0 0 1 ${f(x)} ${f(y + v.h - r)}V${f(y + r)}A${r} ${r} 0 0 1 ${f(x + r)} ${f(y)}Z`
    }
    nodes.push({
      id: v.id,
      name: v.name,
      kind: v.kind,
      x: f(x),
      y: f(y),
      w: v.w,
      h: v.h,
      cx: f(cx),
      cy: f(cy),
      label: v.label,
      meta: v.meta,
      shape,
    })
  }
  const [W, H] = pt(farMain + MARGIN, farCross + MARGIN)
  return { dir, width: Math.ceil(W), height: Math.ceil(H), nodes, edges }
}
