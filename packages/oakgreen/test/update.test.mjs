// @ts-check
/** `oakgreen update` with a fake registry, npm and launchd; nothing leaves the process. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installOf, latestVersion, newer } from '../src/update.mjs'
import { run } from './helpers.mjs'

/** @param {{ latest?: string, current?: string, global?: boolean, fail?: string }} [o] */
function fakeUpdater({ latest = '0.1.0', current = '0.0.31', global = true, fail } = {}) {
  const installs = /** @type {{ prefix: string, version: string }[]} */ ([])
  /** @type {import('../src/update.mjs').Updater} */
  const updater = {
    current,
    installOf: () => (global ? { prefix: '/opt/homebrew', dir: '/opt/homebrew/lib/node_modules/oakgreen' } : null),
    latest: async () => latest,
    install: async (prefix, version) => {
      if (fail) throw new Error(fail)
      installs.push({ prefix, version })
    },
  }
  return { updater, installs }
}

/** launchctl where `running` agents have a pid and a TERM gives them a new one. @param {string[]} running */
function fakeLaunchctl(running) {
  const pids = /** @type {Record<string, number>} */ ({})
  let next = 100
  for (const n of running) pids[`com.oakgreencc.${n}`] = ++next
  const calls = /** @type {string[][]} */ ([])
  /** @type {import('../src/tools.mjs').Exec} */
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    const label = /** @type {string} */ (args.at(-1)).split('/').at(-1) ?? ''
    if (args[0] === 'print')
      return label in pids
        ? { code: 0, stdout: `\tstate = running\n\tpid = ${pids[label]}\n`, stderr: '' }
        : { code: 113, stdout: '', stderr: 'Could not find service' }
    if (args[0] === 'kill') {
      pids[label] = ++next
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` }
  }
  return { exec, calls }
}

const ports = (/** @type {any} */ o) => ({
  platform: 'darwin',
  uid: 501,
  home: '/Users/me',
  exists: () => true,
  sleep: async () => {},
  ...o,
})

test('up to date: says so, installs nothing', async () => {
  const { updater, installs } = fakeUpdater({ latest: '0.0.31' })
  const r = await run(['update'], ports({ updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(r.code, 0)
  assert.match(r.out, /oakgreen 0\.0\.31 is up to date/)
  assert.deepEqual(installs, [])
})

test('--check reports a newer version without installing', async () => {
  const { updater, installs } = fakeUpdater()
  const r = await run(['update', '--check'], ports({ updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(r.code, 0)
  assert.match(r.out, /0\.0\.31 → 0\.1\.0 available/)
  assert.deepEqual(installs, [])
})

test('installs into the same prefix, then restarts only the running services', async () => {
  const { updater, installs } = fakeUpdater()
  const lc = fakeLaunchctl(['cambium'])
  const r = await run(['update'], ports({ updater, exec: lc.exec }))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(installs, [{ prefix: '/opt/homebrew', version: '0.1.0' }])
  assert.match(r.out, /✓ oakgreen 0\.0\.31 → 0\.1\.0/)
  assert.match(r.out, /✓ cambium {2}restarted, pid 101 → 102/)
  assert.doesNotMatch(r.out, /mycelium|otelcol/)
  assert.deepEqual(
    lc.calls.filter((c) => c[1] === 'kill'),
    [['launchctl', 'kill', 'TERM', 'gui/501/com.oakgreencc.cambium']],
  )
})

test('not a global install: refuses, installs nothing', async () => {
  const { updater, installs } = fakeUpdater({ global: false })
  const r = await run(['update'], ports({ updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(r.code, 1)
  assert.match(r.err, /not a global npm install/)
  assert.deepEqual(installs, [])
})

test('a failed npm install exits 1 and restarts nothing', async () => {
  const { updater } = fakeUpdater({ fail: 'npm install oakgreen@0.1.0 failed: EACCES' })
  const lc = fakeLaunchctl(['cambium'])
  const r = await run(['update'], ports({ updater, exec: lc.exec }))
  assert.equal(r.code, 1)
  assert.match(r.err, /EACCES/)
  assert.equal(lc.calls.filter((c) => c[1] === 'kill').length, 0)
})

test('off macOS: installs, skips services', async () => {
  const { updater, installs } = fakeUpdater()
  const lc = fakeLaunchctl(['cambium'])
  const r = await run(['update'], ports({ updater, exec: lc.exec, platform: 'linux' }))
  assert.equal(r.code, 0)
  assert.equal(installs.length, 1)
  assert.deepEqual(lc.calls, [])
})

test('unknown argument is a usage error', async () => {
  const r = await run(['update', '--force'], ports({ updater: fakeUpdater().updater }))
  assert.equal(r.code, 2)
  assert.match(r.err, /unknown argument --force/)
})

test('installOf: only <prefix>/lib/node_modules/oakgreen', () => {
  assert.deepEqual(installOf('/opt/homebrew/lib/node_modules/oakgreen'), {
    prefix: '/opt/homebrew',
    dir: '/opt/homebrew/lib/node_modules/oakgreen',
  })
  assert.equal(installOf('/src/monorepo/packages/oakgreen'), null)
  assert.equal(installOf('/x/lib/node_modules/other/node_modules/oakgreen'), null)
})

test('newer compares x.y.z numerically', () => {
  assert.equal(newer('0.0.10', '0.0.9'), true)
  assert.equal(newer('0.0.9', '0.0.10'), false)
  assert.equal(newer('1.0.0', '1.0.0'), false)
  assert.equal(newer('1.0.0-rc.1', '0.9.9'), true)
})

test('latestVersion reads the latest dist-tag', async () => {
  /** @type {string[]} */
  const urls = []
  const fetch = /** @type {any} */ (
    async (/** @type {string} */ url) => {
      urls.push(url)
      return { ok: true, json: async () => ({ version: '0.2.0' }) }
    }
  )
  assert.equal(await latestVersion({ fetch }), '0.2.0')
  assert.deepEqual(urls, ['https://registry.npmjs.org/oakgreen/latest'])
  const bad = /** @type {any} */ (async () => ({ ok: false, status: 503 }))
  await assert.rejects(latestVersion({ fetch: bad }), /503/)
})
