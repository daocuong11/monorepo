// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, identify, initial, ratchet } from '../src/ratchet.mjs'

const fn = (name, crap) => ({
  name,
  crap,
  complexity: 1,
  coverage: 0,
  depth: 1,
  start: { line: 1, column: 0 },
  end: { line: 1, column: 1 },
})

test('identify: same-named functions in a file get #2, #3', () => {
  const ids = identify('a.js', [fn('<anonymous>', 1), fn('x', 1), fn('<anonymous>', 1)]).map((e) => e.id)
  assert.deepEqual(ids, ['<anonymous>', 'x', '<anonymous>#2'])
})

test('evaluate: new offenders and raised scores fail; at or under the baseline passes', () => {
  const entries = identify('a.js', [fn('ok', 10), fn('fresh', 40), fn('same', 50), fn('better', 45), fn('worse', 61)])
  const { failing, baselined } = evaluate(entries, { 'a.js': { same: 50, better: 60, worse: 60 } }, 30)
  assert.deepEqual(
    failing.map((o) => [o.id, o.status, o.baseline]),
    [
      ['fresh', 'new', null],
      ['worse', 'raised', 60],
    ],
  )
  assert.deepEqual(
    baselined.map((o) => o.id),
    ['same', 'better'],
  )
})

test('ratchet: lowers and removes, never raises or adds', () => {
  const entries = identify('a.js', [fn('lower', 40), fn('higher', 90), fn('fixed', 12), fn('fresh', 99)])
  const next = ratchet({ 'a.js': { lower: 50, higher: 80, fixed: 70, gone: 70 }, 'b.js': { x: 40 } }, entries, 30)
  assert.deepEqual(next, { 'a.js': { higher: 80, lower: 40 } })
})

test('initial: every current offender at its score', () => {
  const entries = [...identify('a.js', [fn('big', 40), fn('small', 5)]), ...identify('b.js', [fn('huge', 100)])]
  assert.deepEqual(initial(entries, 30), { 'a.js': { big: 40 }, 'b.js': { huge: 100 } })
})
