// @ts-check

/**
 * @typedef {import('./complexity.mjs').FunctionInfo} FunctionInfo
 * @typedef {import('./coverage.mjs').FileCoverage} FileCoverage
 * @typedef {import('./coverage.mjs').Point} Point
 * @typedef {FunctionInfo & { coverage: number, crap: number }} Scored
 */

/** CRAP(m) = comp(m)² × (1 − cov(m))³ + comp(m), rounded to 2 places so baselines compare exactly. */
export function crap(complexity, coverage) {
  return Math.round((complexity ** 2 * (1 - coverage) ** 3 + complexity) * 100) / 100
}

/** @param {FunctionInfo} fn @param {Point} p */
function contains(fn, p) {
  if (p.line < fn.start.line || p.line > fn.end.line) return false
  if (p.column === null) return true
  if (p.line === fn.start.line && p.column < fn.start.column) return false
  if (p.line === fn.end.line && p.column >= fn.end.column) return false
  return true
}

/**
 * Join one file's functions with its coverage by location. Each statement (or lcov line)
 * belongs to the innermost function that contains it, so an outer function is not credited
 * or blamed for a nested one. A file absent from coverage scores as 0% covered.
 * @param {FunctionInfo[]} functions
 * @param {FileCoverage | undefined} cov
 * @returns {Scored[]}
 */
export function joinFile(functions, cov) {
  const total = new Array(functions.length).fill(0)
  const covered = new Array(functions.length).fill(0)
  for (const p of cov?.points ?? []) {
    let best = -1
    for (let i = 0; i < functions.length; i++) {
      if (!contains(functions[i], p)) continue
      if (best === -1 || functions[i].depth >= functions[best].depth) best = i
    }
    if (best === -1) continue
    total[best]++
    if (p.hits > 0) covered[best]++
  }
  return functions.map((fn, i) => {
    let coverage = 0
    if (total[i] > 0) coverage = covered[i] / total[i]
    else if (cov?.functions.some((f) => f.line === fn.start.line && f.hits > 0)) coverage = 1
    return { ...fn, coverage, crap: crap(fn.complexity, coverage) }
  })
}
