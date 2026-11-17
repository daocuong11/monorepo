// @ts-check
/**
 * `graft setup project` asks where the policy lives; these are the pure parts:
 * reading the answer, and the writes that leave exactly one place holding it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configLocation, placePolicy } from '../src/setup/project.mjs'

test('configLocation: the two places, loosely spelled; anything else is null', () => {
  assert.equal(configLocation('.graft.json'), '.graft.json')
  assert.equal(configLocation(' graft '), '.graft.json')
  assert.equal(configLocation('package.json'), 'package.json')
  assert.equal(configLocation('Package'), 'package.json')
  assert.equal(configLocation('yaml'), null)
})

test('placePolicy: into package.json keeps its keys, order and indentation, and removes .graft.json', () => {
  const pkgText = '{\n    "name": "x",\n    "scripts": { "test": "t" }\n}\n'
  const w = placePolicy({ target: 'package.json', policy: { baseBranch: 'develop' }, graftText: '{}', pkgText })
  assert.deepEqual(
    w.map((x) => [x.path, x.content === null]),
    [
      ['package.json', false],
      ['.graft.json', true],
    ],
  )
  const out = /** @type {string} */ (w[0].content)
  assert.deepEqual(Object.keys(JSON.parse(out)), ['name', 'scripts', 'graft'])
  assert.match(out, /^ {4}"name"/m)
  assert.ok(out.endsWith('}\n'))
})

test('placePolicy: into package.json with no package.json is refused', () => {
  assert.throws(
    () => placePolicy({ target: 'package.json', policy: {}, graftText: null, pkgText: null }),
    /no package\.json/,
  )
})

test('placePolicy: into .graft.json strips the "graft" key from package.json, and leaves a package.json without one alone', () => {
  const moved = placePolicy({
    target: '.graft.json',
    policy: { baseBranch: 'develop' },
    graftText: null,
    pkgText: '{\n  "name": "x",\n  "graft": { "baseBranch": "main" }\n}\n',
  })
  assert.equal(moved[0].path, '.graft.json')
  assert.deepEqual(JSON.parse(/** @type {string} */ (moved[0].content)), { baseBranch: 'develop' })
  assert.deepEqual(JSON.parse(/** @type {string} */ (moved[1].content)), { name: 'x' })
  const plain = placePolicy({ target: '.graft.json', policy: {}, graftText: null, pkgText: '{"name":"x"}' })
  assert.equal(plain.length, 1)
})
