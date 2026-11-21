// @ts-check
/** `oakgreen update` with a fake registry, npm and launchd; nothing leaves the process. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { globalTools, installOf, latestManifest, newer, staleTools } from '../src/update.mjs'
import { run, tempDir } from './helpers.mjs'

/**
 * @param {{ latest?: string, current?: string, global?: boolean, fail?: string,
 *   pins?: Record<string, string>, tools?: Record<string, string> }} [o]
 */
function fakeUpdater({ latest = '0.1.0', current = '0.0.31', global = true, fail, pins = {}, tools = {} } = {}) {
  const installs = /** @type {{ prefix: string, specs: string[] }[]} */ ([])
  /** @type {import('../src/update.mjs').Updater} */
  const updater = {
    current,
    installOf: () => (global ? { prefix: '/opt/homebrew', dir: '/opt/homebrew/lib/node_modules/oakgreen' } : null),
    latest: async () => ({ version: latest, dependencies: pins }),
    globals: () => tools,
    install: async (prefix, specs) => {
      if (fail) throw new Error(fail)
      installs.push({ prefix, specs })
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
  assert.deepEqual(installs, [{ prefix: '/opt/homebrew', specs: ['oakgreen@0.1.0'] }])
  assert.match(r.out, /✓ oakgreen 0\.0\.31 → 0\.1\.0/)
  assert.match(r.out, /✓ cambium {2}restarted, pid 101 → 102/)
  assert.doesNotMatch(r.out, /mycelium|otelcol/)
  assert.deepEqual(
    lc.calls.filter((c) => c[1] === 'kill'),
    [['launchctl', 'kill', 'TERM', 'gui/501/com.oakgreencc.cambium']],
  )
})

test('standalone tools older than the pins are upgraded in the same install; newer or unpinned ones are left', async () => {
  const { updater, installs } = fakeUpdater({
    pins: { '@oakgreencc/cambium': '0.0.45', '@oakgreencc/graft': '0.2.21', '@oakgreencc/canopy': '0.0.29' },
    tools: { '@oakgreencc/cambium': '0.0.38', '@oakgreencc/graft': '0.2.30', '@oakgreencc/other': '0.0.1' },
  })
  const lc = fakeLaunchctl(['cambium'])
  const r = await run(['update'], ports({ updater, exec: lc.exec }))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(installs, [{ prefix: '/opt/homebrew', specs: ['oakgreen@0.1.0', '@oakgreencc/cambium@0.0.45'] }])
  assert.match(r.out, /✓ @oakgreencc\/cambium 0\.0\.38 → 0\.0\.45/)
  assert.doesNotMatch(r.out, /graft|canopy|other/)
  assert.match(r.out, /✓ cambium {2}restarted/)
})

test('oakgreen current but a standalone tool behind: upgrades the tool and restarts', async () => {
  const { updater, installs } = fakeUpdater({
    latest: '0.0.31',
    pins: { '@oakgreencc/cambium': '0.0.45' },
    tools: { '@oakgreencc/cambium': '0.0.38' },
  })
  const lc = fakeLaunchctl(['cambium'])
  const r = await run(['update'], ports({ updater, exec: lc.exec }))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(installs, [{ prefix: '/opt/homebrew', specs: ['@oakgreencc/cambium@0.0.45'] }])
  assert.doesNotMatch(r.out, /up to date|✓ oakgreen/)
  assert.equal(lc.calls.filter((c) => c[1] === 'kill').length, 1)
})

test('--check lists stale standalone tools too', async () => {
  const { updater, installs } = fakeUpdater({
    latest: '0.0.31',
    pins: { '@oakgreencc/cambium': '0.0.45' },
    tools: { '@oakgreencc/cambium': '0.0.38' },
  })
  const r = await run(['update', '--check'], ports({ updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(r.code, 0)
  assert.match(r.out, /@oakgreencc\/cambium 0\.0\.38 → 0\.0\.45 available/)
  assert.deepEqual(installs, [])
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

test('staleTools: only older, exactly pinned tools', () => {
  assert.deepEqual(
    staleTools(
      { '@oakgreencc/a': '1.0.0', '@oakgreencc/b': '1.0.0', '@oakgreencc/c': 'workspace:*', '@oakgreencc/d': '^2.0.0' },
      { '@oakgreencc/a': '0.9.0', '@oakgreencc/b': '1.0.0', '@oakgreencc/c': '0.1.0', '@oakgreencc/d': '1.0.0' },
    ),
    [{ name: '@oakgreencc/a', from: '0.9.0', to: '1.0.0' }],
  )
})

test('globalTools reads each scoped package version under the prefix', () => {
  const prefix = tempDir({
    'lib/node_modules/@oakgreencc/cambium/package.json': JSON.stringify({ version: '0.0.38' }),
    'lib/node_modules/@oakgreencc/broken/package.json': '{',
    'lib/node_modules/oakgreen/package.json': JSON.stringify({ version: '0.0.63' }),
  })
  assert.deepEqual(globalTools(prefix), { '@oakgreencc/cambium': '0.0.38' })
  assert.deepEqual(globalTools(`${prefix}/missing`), {})
})

test('latestManifest reads the latest dist-tag', async () => {
  /** @type {string[]} */
  const urls = []
  const fetch = /** @type {any} */ (
    async (/** @type {string} */ url) => {
      urls.push(url)
      return { ok: true, json: async () => ({ version: '0.2.0', dependencies: { '@oakgreencc/cambium': '0.0.45' } }) }
    }
  )
  assert.deepEqual(await latestManifest({ fetch }), {
    version: '0.2.0',
    dependencies: { '@oakgreencc/cambium': '0.0.45' },
  })
  assert.deepEqual(urls, ['https://registry.npmjs.org/oakgreen/latest'])
  const bad = /** @type {any} */ (async () => ({ ok: false, status: 503 }))
  await assert.rejects(latestManifest({ fetch: bad }), /503/)
})
