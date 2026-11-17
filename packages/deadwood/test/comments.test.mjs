// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commentDensity, scanComments } from '../src/comments.mjs'

const texts = (src) => scanComments(src).map((c) => c.text.trim())

test('line, block and JSDoc comments are found', () => {
  assert.deepEqual(texts('a() // one\n/* two */ b()\n/**\n * three\n */\nc()'), ['one', 'two', '*\n * three'])
})

test('comment markers inside strings are code', () => {
  assert.deepEqual(texts(`const u = 'http://x.dev' // real\nconst g = "/* not */"`), ['real'])
  assert.deepEqual(texts(`const s = 'it\\'s // still a string'`), [])
})

test('comment markers inside template literals are code, including nested substitutions', () => {
  assert.deepEqual(texts('const t = `a // b ${x /* c */} /* d */ ${`e // f ${y}`}` // g'), ['c', 'g'])
  assert.deepEqual(texts('const t = `${{ a: 1 }.a} // no`'), [])
})

test('comment markers inside regex literals are code', () => {
  assert.deepEqual(texts('const re = /\\/\\/ not/g // yes'), ['yes'])
  assert.deepEqual(texts('const re = /[/*]+/ // yes'), ['yes'])
  assert.deepEqual(texts('if (x) return /\\/*/.test(y) // yes'), ['yes'])
  assert.deepEqual(texts('foo(/a/, /b/) // yes'), ['yes'])
})

test('division is not a regex', () => {
  assert.deepEqual(texts('const r = a / b // half\nconst q = (c) / 2 /* q */'), ['half', 'q'])
  assert.deepEqual(texts('let i = x++ / 2 // k'), ['k'])
  assert.deepEqual(texts('const h = arr[0] / 2 // h'), ['h'])
  assert.deepEqual(texts('const n = 1.5 / 2 // n'), ['n'])
})

test('directives and the shebang do not count', () => {
  const src = [
    '#!/usr/bin/env node',
    '// @ts-check',
    '/// <reference types="node" />',
    '// biome-ignore lint/style: reason',
    '// @ts-expect-error wrong on purpose',
    '/* eslint-disable no-console */',
    '// a real comment',
  ].join('\n')
  assert.deepEqual(
    scanComments(src)
      .filter((c) => !c.directive)
      .map((c) => c.text.trim()),
    ['a real comment'],
  )
  assert.equal(commentDensity(src).commentLines, 1)
})

test('JSDoc type annotations are types, not prose: type-only blocks and rows do not count', () => {
  const typeOnly = [
    '/**',
    ' * @typedef {{',
    ' *   a: string,',
    ' * }} Foo',
    ' * @template T',
    ' * @param {T} x',
    ' * @param {string} [y]',
    ' *',
    ' * @returns {Promise<T>}',
    ' */',
    'f()',
  ].join('\n')
  assert.equal(commentDensity(typeOnly).commentLines, 0)
  assert.equal(commentDensity('const x = /** @type {Foo} */ (y)').commentLines, 0)
  const mixed = ['/**', ' * Explains things.', ' * @param {string} a', ' * @returns {number} the count', ' */', 'f()']
  assert.equal(commentDensity(mixed.join('\n')).commentLines, 4)
  assert.equal(commentDensity('// @param {string} a\nf()').commentLines, 1)
  assert.equal(commentDensity('/* @param {string} a */\nf()').commentLines, 1)
})

test('density: comment lines over non-blank lines; blank lines count for neither', () => {
  const src = ['// one', 'a()', '', '/*', '', ' * two', ' */', 'b() // trailing', 'c()', '   '].join('\n')
  assert.deepEqual(commentDensity(src), { lines: 7, commentLines: 5, density: 5 / 7 })
})

test('density of an empty or comment-free file is zero', () => {
  assert.deepEqual(commentDensity(''), { lines: 0, commentLines: 0, density: 0 })
  assert.equal(commentDensity('a()\nb()').density, 0)
})

test('unterminated constructs do not throw', () => {
  assert.doesNotThrow(() => commentDensity('const a = "abc\n/* open'))
  assert.doesNotThrow(() => commentDensity('const t = `abc ${'))
  assert.doesNotThrow(() => commentDensity('const r = /abc'))
})
