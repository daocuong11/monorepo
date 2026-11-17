// @ts-check
import { isAbsolute, resolve } from 'node:path'

/**
 * Coverage normalized to what the join needs, keyed by absolute file path.
 * A point is a statement (Istanbul, has a column) or a line (lcov, column null).
 * @typedef {{ line: number, column: number | null, hits: number }} Point
 * @typedef {{ line: number, hits: number }} FnHit
 * @typedef {{ points: Point[], functions: FnHit[] }} FileCoverage
 * @typedef {Map<string, FileCoverage>} Coverage
 */

/**
 * Istanbul's `coverage-final.json` (vitest, jest, nyc, c8).
 * @param {string} text
 * @param {string} root resolves relative paths
 * @returns {Coverage}
 */
export function parseIstanbul(text, root) {
  const data = JSON.parse(text)
  /** @type {Coverage} */
  const out = new Map()
  for (const [key, entry] of Object.entries(data)) {
    const file = resolve(root, entry.path ?? key)
    const points = Object.entries(entry.statementMap ?? {}).map(([id, loc]) => ({
      line: loc.start.line,
      column: loc.start.column ?? 0,
      hits: entry.s?.[id] ?? 0,
    }))
    const functions = Object.entries(entry.fnMap ?? {}).map(([id, fn]) => ({
      line: (fn.decl ?? fn.loc).start.line,
      hits: entry.f?.[id] ?? 0,
    }))
    out.set(file, { points, functions })
  }
  return out
}

/**
 * lcov tracefile (`node --test --experimental-test-coverage --test-reporter=lcov`, c8, istanbul).
 * @param {string} text
 * @param {string} root resolves relative SF paths
 * @returns {Coverage}
 */
export function parseLcov(text, root) {
  /** @type {Coverage} */
  const out = new Map()
  /** @type {FileCoverage | null} */
  let current = null
  /** @type {Map<string, number>} */
  let fnLines = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const colon = line.indexOf(':')
    const tag = colon === -1 ? line : line.slice(0, colon)
    const rest = colon === -1 ? '' : line.slice(colon + 1)
    if (tag === 'SF') {
      const file = isAbsolute(rest) ? rest : resolve(root, rest)
      current = out.get(file) ?? { points: [], functions: [] }
      out.set(file, current)
      fnLines = new Map()
      continue
    }
    if (!current) continue
    if (tag === 'DA') {
      const [ln, hits] = rest.split(',')
      current.points.push({ line: Number(ln), column: null, hits: Number(hits) })
    } else if (tag === 'FN') {
      // FN:<line>,<name> or, since lcov 2.0, FN:<line>,<end line>,<name>
      const parts = rest.split(',')
      fnLines.set(parts.slice(/^\d+$/.test(parts[1] ?? '') ? 2 : 1).join(','), Number(parts[0]))
    } else if (tag === 'FNDA') {
      const comma = rest.indexOf(',')
      const ln = fnLines.get(rest.slice(comma + 1))
      if (ln !== undefined) current.functions.push({ line: ln, hits: Number(rest.slice(0, comma)) })
    } else if (tag === 'end_of_record') {
      current = null
    }
  }
  return out
}

/**
 * Pick the parser from the content, not the name: Istanbul is JSON, lcov is not.
 * @param {string} text
 * @param {string} root
 */
export function parseCoverage(text, root) {
  return text.trimStart().startsWith('{') ? parseIstanbul(text, root) : parseLcov(text, root)
}

/**
 * Merge several reports; the first report that has a file wins it, so mixed formats never double count.
 * @param {Coverage[]} reports
 * @returns {Coverage}
 */
export function mergeCoverage(reports) {
  /** @type {Coverage} */
  const out = new Map()
  for (const report of reports) for (const [file, cov] of report) if (!out.has(file)) out.set(file, cov)
  return out
}
