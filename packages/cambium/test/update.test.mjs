// @ts-check
/** Self-update: where cambium may update itself, `cambium update`, and the daemon's opt-in auto-update. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { resolveConfig } from '../src/config.mjs'
import { runDaemon } from '../src/daemon.mjs'
import { autoUpdate, installOf, latestVersion, newer, runUpdate, underLaunchd } from '../src/update.mjs'
import { harness, T0 } from './fakes.mjs'

const LAUNCHD = { XPC_SERVICE_NAME: 'com.oakgreencc.cambium' }
const PREFIX = '/Users/me/.nvm/versions/node/v24.0.0'

/** @param {Partial<import('../src/update.mjs').Updater> & { latestIs?: string }} [o] */
function fakeUpdater({ latestIs = '0.0.16', ...o } = {}) {
  /** @type {[string, string][]} */
  const installs = []
  return {
    installs,
    updater: /** @type {import('../src/update.mjs').Updater} */ ({
      current: '0.0.15',
      installOf: () => ({ prefix: PREFIX, dir: `${PREFIX}/lib/node_modules/@oakgreencc/cambium` }),
      latest: async () => latestIs,
      install: async (prefix, v) => {
        installs.push([prefix, v])
      },
      ...o,
    }),
  }
}

/** @param {Record<string, number>} [codes] launchctl exit codes by subcommand */
function fakeExec(codes = {}) {
  /** @type {string[][]} */
  const calls = []
  return {
    calls,
    exec: async (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
      calls.push([cmd, ...args])
      return { code: codes[args[0]] ?? 0, stdout: '', stderr: codes[args[0]] ? 'nope' : '' }
    },
  }
}

test('installOf: a global npm install gives its prefix; anything else is null', () => {
  assert.deepEqual(installOf(`${PREFIX}/lib/node_modules/@oakgreencc/cambium`), {
    prefix: PREFIX,
    dir: `${PREFIX}/lib/node_modules/@oakgreencc/cambium`,
  })
  assert.equal(installOf('/src/monorepo/packages/cambium'), null, 'a source checkout')
  assert.equal(installOf(`${PREFIX}/lib/node_modules/oakgreen/node_modules/@oakgreencc/cambium`), null, 'a dependency')
  // A global path that is a symlink (npm link) is judged by where it points.
  const root = mkdtempSync(join(tmpdir(), 'cambium-upd-'))
  const src = join(root, 'src', 'cambium')
  mkdirSync(src, { recursive: true })
  mkdirSync(join(root, 'lib', 'node_modules', '@oakgreencc'), { recursive: true })
  symlinkSync(src, join(root, 'lib', 'node_modules', '@oakgreencc', 'cambium'))
  assert.equal(installOf(join(root, 'lib', 'node_modules', '@oakgreencc', 'cambium')), null)
})

test('newer compares x.y.z numerically', () => {
  assert.equal(newer('0.0.16', '0.0.15'), true)
  assert.equal(newer('0.0.10', '0.0.9'), true)
  assert.equal(newer('0.1.0', '0.0.99'), true)
  assert.equal(newer('0.0.15', '0.0.15'), false)
  assert.equal(newer('0.0.14', '0.0.15'), false)
  assert.equal(newer('1.0.0-rc.1', '0.9.0'), true)
})

test('latestVersion reads the latest dist-tag; a bad answer throws', async () => {
  /** @type {string[]} */
  const urls = []
  const fetch = /** @type {any} */ (
    async (/** @type {string} */ url) => {
      urls.push(url)
      return { ok: true, json: async () => ({ version: '0.0.16' }) }
    }
  )
  assert.equal(await latestVersion({ fetch, registry: 'https://r.example' }), '0.0.16')
  assert.deepEqual(urls, ['https://r.example/@oakgreencc%2fcambium/latest'])
  const bad = /** @type {any} */ (async () => ({ ok: false, status: 503 }))
  await assert.rejects(latestVersion({ fetch: bad }), /503/)
})

test('cambium update: installs the latest into the prefix, then SIGTERMs the launchd agent', async () => {
  const { updater, installs } = fakeUpdater()
  const { exec, calls } = fakeExec()
  /** @type {string[]} */
  const out = []
  const r = await runUpdate({ check: false }, { updater, exec, uid: 501, out: (s) => out.push(s) })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(installs, [[PREFIX, '0.0.16']])
  assert.deepEqual(calls, [
    ['launchctl', 'print', 'gui/501/com.oakgreencc.cambium'],
    ['launchctl', 'kill', 'TERM', 'gui/501/com.oakgreencc.cambium'],
  ])
  assert.match(out.join('\n'), /launchd starts 0\.0\.16/)
})

test('cambium update: up to date, --check, no agent, not a global install, --version pins', async () => {
  const quiet = { exec: fakeExec().exec, uid: 501, out: () => {} }
  const same = fakeUpdater({ latestIs: '0.0.15' })
  assert.deepEqual(await runUpdate({ check: false }, { ...quiet, updater: same.updater }), { ok: true })
  assert.deepEqual(same.installs, [])

  const check = fakeUpdater()
  /** @type {string[]} */
  const said = []
  await runUpdate({ check: true }, { ...quiet, updater: check.updater, out: (s) => said.push(s) })
  assert.deepEqual(check.installs, [])
  assert.match(said[0], /0\.0\.15 → 0\.0\.16 available/)

  const noAgent = fakeUpdater()
  const ex = fakeExec({ print: 113 })
  assert.deepEqual(await runUpdate({ check: false }, { ...quiet, updater: noAgent.updater, exec: ex.exec }), {
    ok: true,
  })
  assert.equal(noAgent.installs.length, 1)
  assert.equal(ex.calls.length, 1, 'no kill when the agent is not loaded')

  const source = fakeUpdater({ installOf: () => null })
  const r = await runUpdate({ check: false }, { ...quiet, updater: source.updater })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /not a global npm install/)
  assert.deepEqual(source.installs, [])

  const pin = fakeUpdater({ latestIs: '9.9.9' })
  await runUpdate({ check: false, version: '0.0.14' }, { ...quiet, updater: pin.updater })
  assert.deepEqual(pin.installs, [[PREFIX, '0.0.14']], '--version installs exactly that, even a downgrade')
})

test('cambium update via the CLI needs no config file', async () => {
  const { updater } = fakeUpdater({ latestIs: '0.0.15' })
  /** @type {string[]} */
  const out = []
  const code = await main(['update', '--config', '/nonexistent/c.json'], {
    out: (s) => out.push(s),
    err: (s) => out.push(s),
    env: {},
    updater,
    exec: fakeExec().exec,
    uid: 501,
  })
  assert.equal(code, 0)
  assert.deepEqual(out, ['cambium 0.0.15 is up to date'])
})

test('config: update defaults off, every 6 h; checkMinutes ≥ 5; auto must be a boolean', () => {
  const base = { repos: [], paths: { home: '/tmp/x' } }
  assert.deepEqual(resolveConfig(base).update, { auto: false, checkMinutes: 360 })
  assert.deepEqual(resolveConfig({ ...base, update: { auto: true } }).update, { auto: true, checkMinutes: 360 })
  assert.throws(() => resolveConfig({ ...base, update: { checkMinutes: 1 } }), /at least 5/)
  assert.throws(() => resolveConfig({ ...base, update: { auto: 'yes' } }), /true or false/)
})

test('autoUpdate: off, not due, not launchd, not global, up to date, a failure → null; newer → installs it', async () => {
  const h = harness({ config: { update: { auto: true, checkMinutes: 60 } } })
  const run = (/** @type {any} */ u, env = LAUNCHD, now = T0) => autoUpdate(h.deps, { updater: u, env, now })

  const off = harness()
  assert.equal(await autoUpdate(off.deps, { updater: fakeUpdater().updater, env: LAUNCHD, now: T0 }), null)

  const notLaunchd = fakeUpdater()
  assert.equal(await run(notLaunchd.updater, {}), null)
  assert.ok(h.events.some((e) => /not running as the launchd agent/.test(e.msg)))
  assert.equal(await run(notLaunchd.updater, {}, T0 + 30 * 60_000), null, 'not due again for checkMinutes')
  await run(notLaunchd.updater, {}, T0 + 61 * 60_000)
  assert.equal(
    h.events.filter((e) => /not running as the launchd agent/.test(e.msg)).length,
    1,
    'the same reason is logged once',
  )

  const failing = fakeUpdater({ latest: async () => Promise.reject(new Error('offline')) })
  assert.equal(await run(failing.updater, LAUNCHD, T0 + 200 * 60_000), null)
  assert.ok(h.events.some((e) => e.level === 'warn' && /auto-update: offline/.test(e.msg)))

  const upToDate = fakeUpdater({ latestIs: '0.0.15' })
  assert.equal(await run(upToDate.updater, LAUNCHD, T0 + 300 * 60_000), null)

  const go = fakeUpdater()
  assert.equal(await run(go.updater, LAUNCHD, T0 + 400 * 60_000), '0.0.16')
  assert.deepEqual(go.installs, [[PREFIX, '0.0.16']])
  assert.ok(h.events.some((e) => /exiting so launchd starts the new version/.test(e.msg)))
  assert.equal(underLaunchd({}), false)
})

test('the daemon stops after an auto-update installs, so launchd restarts it on the new version', async () => {
  const h = harness({ config: { update: { auto: true } } })
  const { updater, installs } = fakeUpdater()
  h.deps.updater = updater
  let waits = 0
  const n = await runDaemon(h.deps, {
    env: LAUNCHD,
    wait: async () => {
      waits++
    },
  })
  assert.equal(n, 1, 'one tick, then the update ends the loop')
  assert.equal(waits, 0)
  assert.equal(installs.length, 1)
})
