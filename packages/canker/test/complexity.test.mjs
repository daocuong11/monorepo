// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze } from '../src/complexity.mjs'

const byName = (fns) => Object.fromEntries(fns.map((f) => [f.name, f.complexity]))

test('a straight-line function is 1', () => {
  assert.deepEqual(byName(analyze('function f(a) { return a + 1 }', 'a.js')), { f: 1 })
})

test('each branch adds one: if/else-if, ?:, loops, case (not default), catch, &&, ||, ??, logical assignment', () => {
  const code = `
function f(a, b) {
  if (a) {} else if (b) {} else {}
  const x = a ? 1 : 2
  for (;;) {}
  for (const k in a) {}
  for (const v of b) {}
  while (a) {}
  do {} while (b)
  switch (a) { case 1: break; case 2: break; default: }
  try {} catch {}
  const y = (a && b || x) ?? 0
  a ||= 1; b &&= 2; x ??= 3; a += 1
}`
  // 1 + if 2 + ?: 1 + loops 5 + cases 2 + catch 1 + logical 3 + logical-assign 3
  assert.deepEqual(byName(analyze(code, 'a.mjs')), { f: 18 })
})

test('nested functions own their branches; the outer one is not charged', () => {
  const code = `
function outer(a) {
  if (a) {}
  const inner = (b) => b ? 1 : (b && 2)
  return [1].map(function (x) { return x || 0 })
}`
  const fns = analyze(code, 'a.js')
  assert.deepEqual(
    fns.map((f) => [f.name, f.complexity, f.depth]),
    [
      ['outer', 2, 1],
      ['inner', 3, 2],
      ['<anonymous>', 2, 2],
    ],
  )
})

test('names: declarations, variables, object methods and properties, class members, assignments, default export', () => {
  const code = `
export default function () {}
const arrow = () => {}
const obj = { m() {}, p: function () {}, 'q': () => {} }
class A {
  constructor() {}
  method() {}
  static s() {}
  get g() { return 1 }
  set g(v) {}
  #priv() {}
  field = () => {}
}
const B = class { m() {} }
module.exports.handler = async () => {}
`
  assert.deepEqual(
    analyze(code, 'a.js').map((f) => f.name),
    [
      'default',
      'arrow',
      'm',
      'p',
      'q',
      'A.constructor',
      'A.method',
      'A.s',
      'get A.g',
      'set A.g',
      'A.#priv',
      'A.field',
      'B.m',
      'module.exports.handler',
    ],
  )
})

test('TypeScript: types, generics, overload signatures and abstract members are not functions', () => {
  const code = `
interface I { f(): void }
function over(a: string): string
function over(a: number): number
function over(a: any): any { return a ?? null }
abstract class C<T> {
  abstract m(): T
  private n<U>(u: U): U | undefined { return u as U }
}
const g = <T,>(x: T): T => x
`
  assert.deepEqual(byName(analyze(code, 'a.ts')), { over: 2, 'C.n': 1, g: 1 })
})

test('JSX in .jsx, .tsx and .js; locations are 1-based lines, 0-based columns', () => {
  const jsx = 'export const App = ({ ok }) => <div>{ok && <span />}</div>'
  for (const file of ['a.jsx', 'a.js']) assert.deepEqual(byName(analyze(jsx, file)), { App: 2 })
  const tsx = 'export const App = ({ ok }: { ok: boolean }) =>\n  <div>{ok ? <b /> : null}</div>'
  const [app] = analyze(tsx, 'a.tsx')
  assert.equal(app.complexity, 2)
  assert.deepEqual(app.start, { line: 1, column: 19 })
  assert.equal(app.end.line, 2)
})

test('CommonJS (.cjs) parses as script', () => {
  assert.deepEqual(byName(analyze('module.exports = function f(a) { return a || 1 }', 'a.cjs')), { f: 2 })
})

test('a syntax error throws', () => {
  assert.throws(() => analyze('function (', 'a.js'))
})
