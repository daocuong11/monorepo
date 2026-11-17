// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globToRegExp, matcher } from '../src/glob.mjs'

const m = (glob, path) => globToRegExp(glob).test(path)

test('a bare name matches only at the root', () => {
  assert.equal(m('README.md', 'README.md'), true)
  assert.equal(m('README.md', 'pkg/README.md'), false)
})

test('**/ matches zero or more directories', () => {
  assert.equal(m('**/README.md', 'README.md'), true)
  assert.equal(m('**/README.md', 'a/b/README.md'), true)
  assert.equal(m('docs/**', 'docs/a/b.md'), true)
  assert.equal(m('docs/**', 'other/docs/a.md'), false)
  assert.equal(m('a/**/b.md', 'a/b.md'), true)
  assert.equal(m('a/**/b.md', 'a/x/y/b.md'), true)
})

test('* and ? stay within a segment; dots are literal', () => {
  assert.equal(m('packages/*/README.md', 'packages/x/README.md'), true)
  assert.equal(m('packages/*/README.md', 'packages/x/y/README.md'), false)
  assert.equal(m('?.md', 'a.md'), true)
  assert.equal(m('*.md', 'amd'), false)
})

test('braces alternate', () => {
  assert.equal(m('src/**/*.{ts,mjs}', 'src/a/b.mjs'), true)
  assert.equal(m('src/**/*.{ts,mjs}', 'src/a/b.js'), false)
})

test('matcher is true when any glob matches', () => {
  const match = matcher(['a/**', 'b.md'])
  assert.equal(match('a/x'), true)
  assert.equal(match('b.md'), true)
  assert.equal(match('c.md'), false)
  assert.equal(matcher([])('a'), false)
})
