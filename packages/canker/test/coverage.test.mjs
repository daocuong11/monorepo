// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeCoverage, parseCoverage, parseIstanbul, parseLcov } from '../src/coverage.mjs'
import { ISTANBUL, NODE_LCOV } from './fixtures.mjs'

const ROOT = '/repo/pkg'

test('lcov: relative SF resolves from the project root; DA lines become column-less points; FN/FNDA pair by name', () => {
  const cov = parseLcov(NODE_LCOV, ROOT)
  const m = cov.get('/repo/pkg/src/m.mjs')
  assert.ok(m)
  assert.equal(m.points.length, 9)
  assert.deepEqual(m.points[4], { line: 5, column: null, hits: 0 })
  assert.deepEqual(m.functions, [
    { line: 1, hits: 1 },
    { line: 7, hits: 0 },
  ])
})

test('lcov 2.x FN with an end line, absolute SF, CRLF', () => {
  const text = 'SF:/abs/a.js\r\nFN:3,9,name,with,commas\r\nFNDA:4,name,with,commas\r\nDA:3,4\r\nend_of_record\r\n'
  const a = parseLcov(text, ROOT).get('/abs/a.js')
  assert.deepEqual(a, { points: [{ line: 3, column: null, hits: 4 }], functions: [{ line: 3, hits: 4 }] })
})

test('istanbul: statements become points with columns; functions keyed by declaration line', () => {
  const m = parseIstanbul(JSON.stringify(ISTANBUL), ROOT).get('/repo/pkg/src/m.ts')
  assert.ok(m)
  assert.deepEqual(m.points[1], { line: 3, column: 4, hits: 0 })
  assert.deepEqual(m.functions, [{ line: 1, hits: 3 }])
})

test('parseCoverage sniffs the format from the content', () => {
  assert.ok(parseCoverage(JSON.stringify(ISTANBUL), ROOT).has('/repo/pkg/src/m.ts'))
  assert.ok(parseCoverage(NODE_LCOV, ROOT).has('/repo/pkg/src/m.mjs'))
})

test('mergeCoverage: the first report to cover a file wins it', () => {
  const a = new Map([['/x', { points: [], functions: [{ line: 1, hits: 1 }] }]])
  const b = new Map([
    ['/x', { points: [], functions: [] }],
    ['/y', { points: [], functions: [] }],
  ])
  const merged = mergeCoverage([a, b])
  assert.equal(merged.get('/x'), a.get('/x'))
  assert.ok(merged.has('/y'))
})
