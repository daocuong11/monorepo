// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyBaseline, toBaseline } from '../src/baseline.mjs'
import { check, describe } from '../src/check.mjs'
import { resolveConfig } from '../src/config.mjs'

const code = (n) => Array.from({ length: n }, (_, k) => `f(${k})`)
const source = (commentLines, codeLines) => [...Array(commentLines).fill('// note'), ...code(codeLines)].join('\n')

const run = (files, raw = {}) =>
  check({ files: Object.keys(files), config: resolveConfig(raw), read: (p) => files[p] ?? null })

test('markdown allowlist: anything outside markdown.allow is an offender, .mdx included', () => {
  const { offenders } = run({
    'README.md': '',
    'AGENTS.md': '',
    'pkg/README.md': '',
    'pkg/docs/design.md': '',
    'notes.MDX': '',
    'src/a.txt': '',
  })
  assert.deepEqual(
    offenders.map((o) => o.path),
    ['pkg/docs/design.md', 'notes.MDX'],
  )
  assert.equal(describe(offenders[0]), 'markdown file outside markdown.allow')
})

test('markdown allowlist is configurable', () => {
  const files = { 'README.md': '', 'docs/a.md': '' }
  assert.deepEqual(
    run(files, { markdown: { allow: ['docs/**'] } }).offenders.map((o) => o.path),
    ['README.md'],
  )
})

test('density ceiling: over fails, at or under passes', () => {
  const { offenders } = run({ 'over.mjs': source(4, 16), 'at.ts': source(3, 17), 'under.tsx': source(1, 19) })
  assert.deepEqual(offenders, [
    { path: 'over.mjs', rule: 'comments', density: 0.2, ceiling: 0.15, commentLines: 4, lines: 20 },
  ])
  assert.equal(describe(offenders[0]), 'comment density 0.200 > 0.150 (4/20 lines)')
})

test('files under minLines are skipped; non-JS/TS files are never measured', () => {
  const { offenders, checked } = run({ 'tiny.mjs': source(5, 4), 'a.py': source(10, 10), 'a.json': '{}' })
  assert.deepEqual(offenders, [])
  assert.equal(checked, 1)
})

test('include, exclude and per-file overrides', () => {
  const files = { 'src/a.mjs': source(5, 15), 'src/gen/b.mjs': source(5, 15), 'scripts/c.mjs': source(5, 15) }
  const { offenders } = run(files, {
    include: ['src/**', 'scripts/**'],
    exclude: ['src/gen/**'],
    overrides: [{ files: ['scripts/**'], comments: { maxDensity: 0.5 } }],
  })
  assert.deepEqual(
    offenders.map((o) => o.path),
    ['src/a.mjs'],
  )
})

test('a tracked file missing from disk is skipped', () => {
  assert.deepEqual(check({ files: ['gone.mjs'], config: resolveConfig({}), read: () => null }).offenders, [])
})

const md = (path) => ({ path, rule: /** @type {const} */ ('markdown') })
const dense = (path, density) => ({
  path,
  rule: /** @type {const} */ ('comments'),
  density,
  ceiling: 0.15,
  commentLines: 1,
  lines: 1,
})

test('ratchet: baselined offenders are tolerated, new ones fail', () => {
  const baseline = toBaseline([md('old.md'), dense('old.mjs', 0.3)])
  assert.deepEqual(baseline, { markdown: ['old.md'], comments: { 'old.mjs': 0.3 } })
  const { failing, tolerated, stale } = applyBaseline(
    [md('old.md'), md('new.md'), dense('old.mjs', 0.3), dense('new.mjs', 0.2)],
    baseline,
  )
  assert.deepEqual(
    failing.map((o) => o.path),
    ['new.md', 'new.mjs'],
  )
  assert.deepEqual(
    tolerated.map((o) => o.path),
    ['old.md', 'old.mjs'],
  )
  assert.deepEqual(stale, [])
})

test('ratchet: a baselined file whose density grew fails', () => {
  const { failing } = applyBaseline([dense('old.mjs', 0.31)], { markdown: [], comments: { 'old.mjs': 0.3 } })
  assert.deepEqual(
    failing.map((o) => o.path),
    ['old.mjs'],
  )
})

test('ratchet: fixed or improved entries are stale, and the shrunk baseline drops or lowers them', () => {
  const baseline = { markdown: ['a.md', 'b.md'], comments: { 'x.mjs': 0.3, 'y.mjs': 0.4 } }
  const { failing, stale, shrunk } = applyBaseline([md('a.md'), dense('x.mjs', 0.25)], baseline)
  assert.deepEqual(failing, [])
  assert.deepEqual(stale, [
    { path: 'b.md', rule: 'markdown' },
    { path: 'x.mjs', rule: 'comments', was: 0.3, now: 0.25 },
    { path: 'y.mjs', rule: 'comments', was: 0.4, now: null },
  ])
  assert.deepEqual(shrunk, { markdown: ['a.md'], comments: { 'x.mjs': 0.25 } })
})

test('ratchet: stored densities round up, so the file that wrote them still passes', () => {
  const d = 2 / 7
  const { failing } = applyBaseline([dense('x.mjs', d)], toBaseline([dense('x.mjs', d)]))
  assert.deepEqual(failing, [])
})
