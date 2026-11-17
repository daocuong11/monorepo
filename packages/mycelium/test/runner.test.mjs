// @ts-check
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { createIntake } from '../src/intake.mjs'
import { pass, runLoop } from '../src/runner.mjs'
import { ascConfig, ascSource } from '../src/sources/asc.mjs'
import { fileState } from '../src/state.mjs'
import { fakeFetch, fakeGithub, fixture } from './helpers.mjs'

const pem = /** @type {string} */ (
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' })
)
const env = {
  MYCELIUM_ASC_KEY_ID: 'K',
  MYCELIUM_ASC_ISSUER_ID: 'I',
  MYCELIUM_ASC_KEY_P8: pem,
  MYCELIUM_ASC_APP_ID: '1000000001',
  MYCELIUM_BACKFILL_HOURS: '48',
}
const NOW = Date.parse('2026-11-01T20:00:00Z')
const pages = fixture('asc-reviews.json')
const ascFetch = () => fakeFetch((url) => (url.includes('cursor=PAGE2') ? pages.page2 : pages.page1))
const asc = () => ascSource({ fetch: ascFetch().fetch, config: /** @type {any} */ (ascConfig(env)) })
const tmp = () => mkdtempSync(join(tmpdir(), 'mycelium-'))
const ctx = (/** @type {any} */ github, /** @type {string} */ path) => ({
  intake: createIntake(github),
  state: fileState(path),
  now: NOW,
  backfillMs: 48 * 3_600_000,
})

test('restart: the cursor file means a second process files nothing again', async (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true }))
  const path = join(dir, 'state.json')
  const gh = fakeGithub()
  assert.deepEqual(await pass(asc(), ctx(gh.client, path)), { source: 'asc', created: 3, commented: 0, skipped: 0 })
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).cursors.asc.ids[0], '00000000-aaaa-4000-8000-000000000004')
  assert.deepEqual(await pass(asc(), ctx(gh.client, path)), { source: 'asc', created: 0, commented: 0, skipped: 0 })
  assert.equal(gh.state.issues.length, 3)
  assert.equal(gh.state.comments.length, 0)
})

test('a failed write stops the pass with the cursor on the last envelope that landed', async (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true }))
  const path = join(dir, 'state.json')
  const gh = fakeGithub()
  const create = gh.client.createIssue
  let n = 0
  gh.client.createIssue = async (i) => {
    if (n++ === 1) throw new Error('graft api: 502')
    return create(i)
  }
  await assert.rejects(pass(asc(), ctx(gh.client, path)), /502/)
  assert.equal(gh.state.issues.length, 1)
  assert.deepEqual(await pass(asc(), ctx(gh.client, path)), { source: 'asc', created: 2, commented: 0, skipped: 0 })
  assert.equal(gh.state.issues.length, 3)
})

test('cli: poll --dry-run prints envelope and action, writes nothing, moves no cursor', async (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true }))
  const statePath = join(dir, 'state.json')
  const lines = /** @type {string[]} */ ([])
  const gh = fakeGithub()
  const code = await main(['poll', 'asc', '--dry-run'], {
    env: { ...env, MYCELIUM_STATE: statePath },
    fetch: ascFetch().fetch,
    github: gh.client,
    now: () => NOW,
    out: (l) => lines.push(l),
    err: () => {},
  })
  assert.equal(code, 0)
  const records = lines.map((l) => JSON.parse(l))
  assert.deepEqual(
    records.map((r) => [r.action, r.envelope.externalId.slice(-1)]),
    [
      ['create', '2'],
      ['create', '3'],
      ['create', '4'],
    ],
  )
  assert.ok(records[0].body.startsWith('<!-- mycelium:fingerprint='))
  assert.equal(gh.state.issues.length, 0)
  assert.equal(existsSync(statePath), false)
})

test('cli: dry run needs no repository; a real run does; an unconfigured source names its env', async () => {
  const quiet = { out: () => {}, err: () => {}, now: () => NOW, fetch: ascFetch().fetch }
  assert.equal(await main(['poll', 'asc', '--dry-run'], { ...quiet, env }), 0)
  await assert.rejects(main(['poll', 'asc'], { ...quiet, env }), /MYCELIUM_REPO/)
  await assert.rejects(main(['poll', 'play', '--dry-run'], { ...quiet, env: {} }), /MYCELIUM_PLAY_PACKAGE/)
  await assert.rejects(main(['poll', 'fax', '--dry-run'], { ...quiet, env: {} }), /unknown source/)
  await assert.rejects(main(['dance'], { ...quiet, env: {}, github: fakeGithub().client }), /unknown verb/)
})

test('run: each source on its own interval; a failing one is reported and does not stop the others', async () => {
  let clock = 0
  const stop = new AbortController()
  const passes = /** @type {string[]} */ ([])
  /** @param {string} name @param {number} intervalMs @param {boolean} [fail] */
  const source = (name, intervalMs, fail = false) => ({
    name,
    intervalMs,
    pull: async () => {
      passes.push(`${name}@${clock}`)
      if (fail) throw new Error('boom')
      return []
    },
  })
  const report = /** @type {string[]} */ ([])
  await runLoop([source('fast', 10), source('slow', 25, true)], {
    intake: createIntake(fakeGithub().client),
    state: { get: () => null, set: () => {} },
    backfillMs: 0,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
      if (clock >= 50) stop.abort()
    },
    signal: stop.signal,
    report: (l) => report.push(l),
  })
  assert.deepEqual(passes, ['fast@0', 'slow@0', 'fast@10', 'fast@20', 'slow@25', 'fast@30', 'fast@40'])
  assert.ok(report.includes('slow: boom'))
})
