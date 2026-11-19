// @ts-check
// Pure helpers for the trace view. Each function is self-contained: page.mjs inlines them into the page with String(fn).

/**
 * Whether a span is a Claude Code permission check that nobody was asked about: accepted by config, a hook or a classifier
 * rather than by a person. Claude Code opens one `claude_code.tool.blocked_on_user` span for every tool call, so these
 * outnumber everything else in a worker's trace while saying nothing. One a person answered (`source: user_*`) or one
 * that was rejected is kept.
 * @param {{ name: string, attrs: Record<string, unknown> }} sp
 */
export function autoApproved(sp) {
  if (sp.name !== 'claude_code.tool.blocked_on_user') return false
  const a = sp.attrs || {}
  return a.decision === 'accept' && !/^user/.test(String(a.source ?? ''))
}

/**
 * Spans folded into a flame graph: one frame per distinct path of frame labels from a root, its width the time summed over
 * every span on that path. A frame is never narrower than its children together, so a zero-length parent (cambium.issue)
 * still spans its work, and parallel children add up rather than overlap. A span whose parent is missing is a root.
 * @param {{ spanId: string, parentSpanId: string | null, name: string, start: number, end: number, status: string,
 *   attrs: Record<string, unknown> }[]} spans
 * @returns {{ label: string, key: string, ms: number, self: number, count: number, errors: number, depth: number,
 *   x: number, kids: any[] }}
 */
export function flameTree(spans) {
  const label = (/** @type {any} */ sp) => {
    const a = sp.attrs || {}
    const tool = a.tool_name || a['claude.tool.name']
    return sp.name + (tool ? ` · ${tool}` : a['cambium.node'] ? ` · ${a['cambium.node']}` : '')
  }
  const ids = new Set(spans.map((sp) => sp.spanId))
  /** @type {Map<string | null, typeof spans>} */
  const byParent = new Map()
  for (const sp of spans) {
    const p = sp.parentSpanId && ids.has(sp.parentSpanId) ? sp.parentSpanId : null
    if (!byParent.has(p)) byParent.set(p, [])
    byParent.get(p)?.push(sp)
  }
  const frame = (/** @type {string} */ lbl, /** @type {string} */ key, /** @type {number} */ depth) => ({
    label: lbl,
    key,
    ms: 0,
    self: 0,
    count: 0,
    errors: 0,
    depth,
    x: 0,
    kids: /** @type {any[]} */ ([]),
  })
  const root = frame('all spans', '', 0)
  const seen = new Set()
  const add = (/** @type {any} */ into, /** @type {typeof spans} */ group) => {
    for (const sp of group) {
      if (seen.has(sp.spanId)) continue
      seen.add(sp.spanId)
      const lbl = label(sp)
      let f = into.kids.find((k) => k.label === lbl)
      if (!f) {
        f = frame(lbl, `${into.key}/${lbl}`, into.depth + 1)
        into.kids.push(f)
      }
      f.count++
      if (sp.status === 'error') f.errors++
      f.self += Math.max(0, sp.end - sp.start)
      add(f, byParent.get(sp.spanId) || [])
    }
  }
  add(root, byParent.get(null) || [])
  const size = (/** @type {any} */ f) => {
    const kids = f.kids.reduce((n, k) => n + size(k), 0)
    f.kids.sort((a, b) => b.ms - a.ms)
    f.ms = Math.max(f.self, kids)
    return f.ms
  }
  size(root)
  const place = (/** @type {any} */ f, /** @type {number} */ x) => {
    f.x = x
    for (const k of f.kids) {
      place(k, x)
      x += k.ms
    }
  }
  place(root, 0)
  return root
}

/**
 * The frames under `key` (itself included) as a flat list with x and width as fractions of that frame, depth counted
 * from it. Frames narrower than `min` of it are left out. An unknown key falls back to the whole tree.
 * @param {ReturnType<typeof flameTree>} tree
 * @param {string} key
 * @param {number} [min]
 */
export function flameFrames(tree, key, min = 0.002) {
  const find = (/** @type {any} */ f) => {
    if (f.key === key) return f
    for (const k of f.kids) {
      const hit = key.startsWith(k.key) && find(k)
      if (hit) return hit
    }
    return null
  }
  const top = find(tree) || tree
  const total = top.ms || 1
  /** @type {any[]} */
  const out = []
  const walk = (/** @type {any} */ f) => {
    const w = f.ms / total
    if (w < min && f !== top) return
    out.push({ ...f, kids: undefined, left: (f.x - top.x) / total, width: w, level: f.depth - top.depth })
    for (const k of f.kids) walk(k)
  }
  walk(top)
  return { top, frames: out }
}
