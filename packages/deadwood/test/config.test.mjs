// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, DEFAULTS, commentRulesFor, loadConfig, resolveConfig } from '../src/config.mjs'
import { matcher } from '../src/glob.mjs'

const fsOf = (files) => (path) => files[path.replace(/^\/repo\//, '')] ?? null

test('defaults when no config exists', () => {
  const { config, source } = loadConfig('/repo', { readFile: fsOf({ 'package.json': '{}' }) })
  assert.equal(source, 'defaults')
  assert.deepEqual(config.comments, DEFAULTS.comments)
  assert.equal(config.baseline, 'deadwood.baseline.json')
})

test('reads the "deadwood" key of package.json, or deadwood.json — never both', () => {
  const pkg = JSON.stringify({ deadwood: { comments: { maxDensity: 0.2 } } })
  assert.equal(loadConfig('/repo', { readFile: fsOf({ 'package.json': pkg }) }).config.comments.maxDensity, 0.2)
  const own = JSON.stringify({ markdown: { allow: ['x.md'] } })
  const viaFile = loadConfig('/repo', { readFile: fsOf({ 'deadwood.json': own }) })
  assert.equal(viaFile.source, 'deadwood.json')
  assert.deepEqual(viaFile.config.markdown.allow, ['x.md'])
  assert.throws(
    () => loadConfig('/repo', { readFile: fsOf({ 'deadwood.json': own, 'package.json': pkg }) }),
    ConfigError,
  )
})

test('rejects unknown keys and bad values', () => {
  assert.throws(() => resolveConfig({ commments: {} }), /unknown key "commments"/)
  assert.throws(() => resolveConfig({ comments: { maxDensity: 2 } }), /maxDensity/)
  assert.throws(() => resolveConfig({ comments: { minLines: -1 } }), /minLines/)
  assert.throws(() => resolveConfig({ include: 'src/**' }), /include/)
  assert.throws(() => resolveConfig({ overrides: [{ files: ['a'], markdown: {} }] }), /overrides\[0\]/)
})

test('overrides apply in order; false switches the density check off', () => {
  const config = resolveConfig({
    comments: { maxDensity: 0.1, minLines: 5 },
    overrides: [
      { files: ['legacy/**'], comments: { maxDensity: 0.4 } },
      { files: ['legacy/vendor/**'], comments: false },
      { files: ['legacy/vendor/keep.mjs'], comments: { minLines: 0 } },
    ],
  })
  const rules = commentRulesFor(config, matcher)
  assert.deepEqual(rules('src/a.mjs'), { maxDensity: 0.1, minLines: 5 })
  assert.deepEqual(rules('legacy/a.mjs'), { maxDensity: 0.4, minLines: 5 })
  assert.equal(rules('legacy/vendor/a.mjs'), null)
  assert.deepEqual(rules('legacy/vendor/keep.mjs'), { maxDensity: 0.1, minLines: 0 })
})
