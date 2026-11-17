// @ts-check

/**
 * @typedef {{ markdown: string[], comments: Record<string, number> }} Baseline
 * @typedef {import('./check.mjs').Offender} Offender
 */

export const EMPTY = Object.freeze({ markdown: [], comments: {} })

/** @param {number} density */
const stored = (density) => Math.ceil(density * 1e4) / 1e4

/**
 * @param {Baseline} baseline
 * @param {Offender} o
 */
function tolerates(baseline, o) {
  if (o.rule === 'markdown') return baseline.markdown.includes(o.path)
  const allowed = baseline.comments[o.path]
  return allowed !== undefined && stored(o.density) <= allowed
}

/**
 * @param {Offender[]} offenders
 * @param {Baseline} baseline
 */
export function applyBaseline(offenders, baseline) {
  const failing = offenders.filter((o) => !tolerates(baseline, o))
  const tolerated = offenders.filter((o) => tolerates(baseline, o))
  const shrunk = toBaseline(tolerated)
  const stale = [
    ...baseline.markdown.filter((p) => !shrunk.markdown.includes(p)).map((path) => ({ path, rule: 'markdown' })),
    ...Object.entries(baseline.comments)
      .filter(([path, density]) => shrunk.comments[path] !== density)
      .map(([path, density]) => ({ path, rule: 'comments', was: density, now: shrunk.comments[path] ?? null })),
  ]
  return { failing, tolerated, stale, shrunk }
}

/**
 * @param {Offender[]} offenders
 * @returns {Baseline}
 */
export function toBaseline(offenders) {
  const markdown = offenders
    .filter((o) => o.rule === 'markdown')
    .map((o) => o.path)
    .sort()
  /** @type {Record<string, number>} */
  const comments = {}
  for (const o of [...offenders].sort((a, b) => a.path.localeCompare(b.path))) {
    if (o.rule === 'comments') comments[o.path] = stored(o.density)
  }
  return { markdown, comments }
}

/**
 * @param {string} text
 * @returns {Baseline}
 */
export function parseBaseline(text) {
  const raw = JSON.parse(text)
  const markdown = raw?.markdown ?? []
  const comments = raw?.comments ?? {}
  if (!Array.isArray(markdown) || typeof comments !== 'object' || Array.isArray(comments)) {
    throw new Error('baseline must be { "markdown": [paths], "comments": { path: density } }')
  }
  return { markdown, comments }
}
