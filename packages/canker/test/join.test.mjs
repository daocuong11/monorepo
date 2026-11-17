// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze } from '../src/complexity.mjs'
import { parseIstanbul, parseLcov } from '../src/coverage.mjs'
import { crap, joinFile } from '../src/join.mjs'
import { ISTANBUL, NODE_LCOV } from './fixtures.mjs'

test('crap: comp² × (1 − cov)³ + comp, to 2 places', () => {
  assert.equal(crap(1, 1), 1)
  assert.equal(crap(5, 0), 30)
  assert.equal(crap(10, 0.5), 22.5)
  assert.equal(crap(3, 1 / 3), 5.67)
})

const M_MJS = `export function f(a) {
  if (a) {
    return 1
  }
  return 2
}
export const g = (x) => {
  return x ? 1 : 0
}
`

test('lcov join: lines inside a function count toward it', () => {
  const cov = parseLcov(NODE_LCOV, '/repo/pkg').get('/repo/pkg/src/m.mjs')
  const [f, g] = joinFile(analyze(M_MJS, 'm.mjs'), cov)
  assert.equal(f.coverage, 5 / 6)
  assert.equal(g.coverage, 1 / 3)
  assert.equal(g.crap, crap(2, 1 / 3))
})

test('istanbul join uses statement columns; a statement belongs to the innermost function', () => {
  const code = `function f(a) {
  if (a) {
    a = 1
  }
  a(() => 1)
}`
  const cov = parseIstanbul(JSON.stringify(ISTANBUL), '/').get('/repo/pkg/src/m.ts')
  assert.ok(cov)
  // a statement inside the arrow on line 5: it is the arrow's, not f's
  cov.points.push({ line: 5, column: 10, hits: 0 })
  const [f, arrow] = joinFile(analyze(code, 'm.ts'), cov)
  assert.equal(f.coverage, 2 / 3)
  assert.equal(arrow.coverage, 0)
})

test('a function with no statements falls back to its call count; a file with no coverage is 0%', () => {
  const fns = analyze('const noop = () => {}', 'a.js')
  assert.equal(joinFile(fns, { points: [], functions: [{ line: 1, hits: 2 }] })[0].coverage, 1)
  assert.equal(joinFile(fns, { points: [], functions: [{ line: 1, hits: 0 }] })[0].coverage, 0)
  const [uncovered] = joinFile(analyze('function h(a) { return a || 1 }', 'a.js'), undefined)
  assert.equal(uncovered.coverage, 0)
  assert.equal(uncovered.crap, crap(2, 0))
})
