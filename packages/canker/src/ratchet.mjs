// @ts-check

/**
 * Baseline: `{ "<file>": { "<function id>": <crap> } }`. Keyed by name, not line, so an edit
 * above a function does not orphan its entry. Same-named functions in a file get `#2`, `#3`….
 * @typedef {Record<string, Record<string, number>>} Baseline
 * @typedef {import('./join.mjs').Scored & { file: string, id: string }} Entry
 * @typedef {Entry & { baseline: number | null, status: 'new' | 'raised' | 'baselined' }} Offender
 */

/**
 * @param {string} file
 * @param {import('./join.mjs').Scored[]} functions
 * @returns {Entry[]}
 */
export function identify(file, functions) {
  /** @type {Map<string, number>} */
  const seen = new Map()
  return functions.map((fn) => {
    const n = (seen.get(fn.name) ?? 0) + 1
    seen.set(fn.name, n)
    return { ...fn, file, id: n === 1 ? fn.name : `${fn.name}#${n}` }
  })
}

/**
 * Every function over maxCrap. A baselined one fails only if its score rose.
 * @param {Entry[]} entries
 * @param {Baseline} baseline
 * @param {number} maxCrap
 * @returns {{ failing: Offender[], baselined: Offender[] }}
 */
export function evaluate(entries, baseline, maxCrap) {
  /** @type {Offender[]} */
  const failing = []
  /** @type {Offender[]} */
  const baselined = []
  for (const e of entries) {
    if (e.crap <= maxCrap) continue
    const prior = baseline[e.file]?.[e.id]
    if (prior === undefined) failing.push({ ...e, baseline: null, status: 'new' })
    else if (e.crap > prior) failing.push({ ...e, baseline: prior, status: 'raised' })
    else baselined.push({ ...e, baseline: prior, status: 'baselined' })
  }
  return { failing, baselined }
}

/**
 * `--update`: lower entries to the current score, drop the ones that are gone or back under
 * maxCrap. Never adds an entry and never raises one.
 * @param {Baseline} baseline
 * @param {Entry[]} entries
 * @param {number} maxCrap
 * @returns {Baseline}
 */
export function ratchet(baseline, entries, maxCrap) {
  const current = new Map(entries.map((e) => [`${e.file}\0${e.id}`, e.crap]))
  /** @type {Baseline} */
  const out = {}
  for (const file of Object.keys(baseline).sort()) {
    for (const id of Object.keys(baseline[file]).sort()) {
      const score = current.get(`${file}\0${id}`)
      if (score === undefined || score <= maxCrap) continue
      out[file] ??= {}
      out[file][id] = Math.min(score, baseline[file][id])
    }
  }
  return out
}

/**
 * `--init`: the first baseline, every current offender at its current score.
 * @param {Entry[]} entries
 * @param {number} maxCrap
 * @returns {Baseline}
 */
export function initial(entries, maxCrap) {
  /** @type {Baseline} */
  const out = {}
  for (const e of entries) {
    if (e.crap <= maxCrap) continue
    out[e.file] ??= {}
    out[e.file][e.id] = e.crap
  }
  return out
}
