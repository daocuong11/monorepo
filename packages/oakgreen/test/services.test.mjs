// @ts-check
/** `oakgreen services | restart | reload` against a fake launchd; nothing touches launchctl. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { parsePrint, pick } from '../src/services.mjs'

const UID = 501
const HOME = '/Users/me'

/**
 * A launchd with KeepAlive agents. `stopTicks`: polls a SIGTERMed or booted-out process takes to exit (cambium
 * finishing its tick); a bootstrap meanwhile fails with launchd's error 5, as the real one does.
 *
 * @param {Record<string, { installed?: boolean, loaded?: boolean, stopTicks?: number }>} agents by service name
 */
function fakeLaunchd(agents) {
  let nextPid = 100
  /** @type {Record<string, { installed: boolean, loaded: boolean, pid: number | null, stopping: number, unloading: boolean, stopTicks: number, disabled: boolean }>} */
  const state = {}
  for (const [name, a] of Object.entries(agents))
    state[`com.oakgreencc.${name}`] = {
      installed: a.installed ?? true,
      loaded: a.loaded ?? true,
      pid: (a.loaded ?? true) ? ++nextPid : null,
      stopping: 0,
      unloading: false,
      stopTicks: a.stopTicks ?? 0,
      disabled: false,
    }
  /** @type {string[][]} */
  const calls = []
  /** One poll's worth of time passing for every agent. */
  const step = () => {
    for (const s of Object.values(state)) {
      if (s.stopping > 0 && --s.stopping === 0) {
        if (s.unloading) Object.assign(s, { loaded: false, pid: null, unloading: false })
        else s.pid = ++nextPid // KeepAlive starts it again
      }
    }
  }
  const labelOf = (/** @type {string} */ t) => /** @type {string} */ (t.split('/').at(-1))
  /** @type {import('../src/tools.mjs').Exec} */
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    assert.equal(cmd, 'launchctl')
    const [sub, ...rest] = args
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    if (sub === 'enable' || sub === 'disable') {
      const s = state[labelOf(rest[0])]
      if (s) s.disabled = sub === 'disable'
      return ok()
    }
    if (sub === 'kickstart') {
      const s = state[labelOf(rest[0])]
      if (!s?.loaded) return { code: 113, stdout: '', stderr: 'Could not find service' }
      s.pid ??= ++nextPid
      return ok()
    }
    if (sub === 'print') {
      const s = state[labelOf(rest[0])]
      if (!s?.loaded) return { code: 113, stdout: '', stderr: 'Could not find service' }
      return ok(
        `gui/${UID}/x = {\n\tstate = ${s.pid ? 'running' : 'waiting'}\n${s.pid ? `\tpid = ${s.pid}\n` : ''}\tlast exit code = 0\n}`,
      )
    }
    if (sub === 'kill') {
      const s = state[labelOf(rest[1])]
      if (!s?.pid) return { code: 3, stdout: '', stderr: 'No such process' }
      s.stopping = Math.max(1, s.stopTicks)
      return ok()
    }
    if (sub === 'bootout') {
      const s = state[labelOf(rest[0])]
      s.unloading = true
      s.stopping = Math.max(1, s.stopTicks)
      return ok()
    }
    if (sub === 'bootstrap') {
      const label = /** @type {string} */ (rest[1].split('/').at(-1)).replace(/\.plist$/, '')
      const s = state[label]
      if (s.loaded || s.disabled) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
      Object.assign(s, { loaded: true, pid: ++nextPid })
      return ok()
    }
    throw new Error(`unexpected launchctl ${sub}`)
  }
  const ports = {
    exec,
    home: HOME,
    uid: UID,
    platform: 'darwin',
    exists: (/** @type {string} */ p) =>
      Object.entries(state).some(([l, s]) => s.installed && p.endsWith(`${l}.plist`)),
    sleep: async () => step(),
  }
  return { ports, calls, state }
}

/** @param {string[]} argv @param {object} ports */
async function run(argv, ports) {
  let out = ''
  let err = ''
  const code = await main(argv, { ...ports, stdout: (s) => (out += s), stderr: (s) => (err += s) })
  return { code, out, err }
}

test('parsePrint reads pid, state and last exit code; pick keeps stack order', () => {
  assert.deepEqual(parsePrint('x = {\n\tstate = running\n\tpid = 42\n\tlast exit code = 0\n}'), {
    pid: 42,
    state: 'running',
    lastExit: '0',
  })
  assert.deepEqual(parsePrint('x = {\n\tstate = waiting\n}').pid, null)
  assert.deepEqual(
    pick(['cambium', 'otelcol']).services.map((s) => s.name),
    ['otelcol', 'cambium'],
  )
  assert.deepEqual(pick(['x']).unknown, ['x'])
})

test('services: running, loaded but down, installed but not loaded, not installed; --json', async () => {
  const { ports } = fakeLaunchd({ otelcol: { loaded: false }, cambium: {} })
  const r = await run(['services'], ports)
  assert.equal(r.code, 0)
  assert.match(r.out, /✗ otelcol {2}installed, not loaded: oakgreen start otelcol/)
  assert.match(r.out, /✓ cambium {2}running, pid \d+/)
  const none = fakeLaunchd({ otelcol: { installed: false, loaded: false }, cambium: {} })
  assert.match((await run(['services'], none.ports)).out, /· otelcol {2}not installed/)
  const j = JSON.parse((await run(['services', '--json'], ports)).out)
  assert.deepEqual(
    j.map((/** @type {any} */ s) => [s.name, s.loaded, s.installed]),
    [
      ['otelcol', false, true],
      ['cambium', true, true],
      ['mycelium', false, false],
      ['canopy', false, false],
    ],
  )
})

test('restart: SIGTERM, then wait for KeepAlive to bring up a new pid; all services in order', async () => {
  const { ports, calls, state } = fakeLaunchd({ otelcol: {}, cambium: { stopTicks: 4 } })
  const before = state['com.oakgreencc.cambium'].pid
  const r = await run(['restart'], ports)
  assert.equal(r.code, 0, r.out + r.err)
  assert.match(r.out, /✓ otelcol {2}restarted, pid \d+ → \d+/)
  assert.match(r.out, new RegExp(`✓ cambium {2}restarted, pid ${before} → \\d+`))
  assert.notEqual(state['com.oakgreencc.cambium'].pid, before)
  assert.deepEqual(
    calls.filter((c) => c[1] === 'kill').map((c) => c.at(-1)),
    [`gui/${UID}/com.oakgreencc.otelcol`, `gui/${UID}/com.oakgreencc.cambium`],
  )
  assert.equal(calls.filter((c) => c[1] === 'bootout' || c[1] === 'bootstrap').length, 0, 'restart keeps the plist')
})

test('reload: bootout, wait while cambium finishes its tick, then bootstrap once (no I/O error race)', async () => {
  const { ports, calls } = fakeLaunchd({ otelcol: {}, cambium: { stopTicks: 5 } })
  const r = await run(['reload', 'cambium'], ports)
  assert.equal(r.code, 0, r.out + r.err)
  assert.match(r.out, /✓ cambium {2}loaded, pid \d+/)
  const subs = calls.map((c) => c[1])
  assert.equal(subs.filter((s) => s === 'bootstrap').length, 1, 'bootstrapped only once launchd let go')
  assert.ok(subs.indexOf('bootstrap') > subs.lastIndexOf('bootout'))
  assert.ok(!subs.includes('kill'))
  assert.ok(!calls.some((c) => c.at(-1)?.includes('otelcol')), 'only the named service')
})

test('restart of an installed but unloaded agent loads it; a named uninstalled one fails; unnamed ones are skipped', async () => {
  const { ports } = fakeLaunchd({ otelcol: { loaded: false }, cambium: {} })
  const r = await run(['restart', 'otelcol'], ports)
  assert.equal(r.code, 0)
  assert.match(r.out, /✓ otelcol {2}loaded, pid/)

  const missing = fakeLaunchd({ otelcol: { installed: false, loaded: false }, cambium: {} })
  const named = await run(['reload', 'otelcol'], missing.ports)
  assert.equal(named.code, 1)
  assert.match(named.out, /✗ otelcol {2}not installed/)
  const all = await run(['reload'], missing.ports)
  assert.equal(all.code, 0)
  assert.match(all.out, /· otelcol {2}not installed, skipped/)
  assert.match(all.out, /✓ cambium {2}loaded/)
})

test('a process that never comes back is a failure, not a hang', async () => {
  const { ports, state } = fakeLaunchd({ cambium: {} })
  let t = 0
  const stuck = {
    ...ports,
    now: () => t,
    sleep: async () => {
      t += 1000
    },
  }
  state['com.oakgreencc.cambium'].stopTicks = 1e9
  const r = await run(['restart', 'cambium'], { ...stuck })
  assert.equal(r.code, 1)
  assert.match(r.out, /✗ cambium {2}no new process within the timeout/)
})

test('unknown service, unknown option, and not macOS', async () => {
  const { ports } = fakeLaunchd({ cambium: {} })
  const u = await run(['restart', 'deadwood'], ports)
  assert.equal(u.code, 2)
  assert.match(u.err, /unknown service deadwood \(known: otelcol, cambium, mycelium, canopy\)/)
  assert.equal((await run(['reload', '--force'], ports)).code, 2)
  const linux = await run(['services'], { ...ports, platform: 'linux' })
  assert.equal(linux.code, 2)
  assert.match(linux.err, /macOS only/)
})

/**
 * The fake launchd's exec, plus the stack's tools: `<tool> install` writes the agent into the fake launchd (or
 * fails, as an unconfigured one does).
 * @param {ReturnType<typeof fakeLaunchd>} launchd @param {Record<string, string>} [fail] tool → stderr
 */
function installer({ ports, state }, fail = {}) {
  /** @type {string[][]} */
  const ran = []
  /** @type {import('../src/tools.mjs').Exec} */
  const exec = async (cmd, args) => {
    if (cmd === 'launchctl') return ports.exec(cmd, args)
    const tool = /\/(\w+)\.mjs$/.exec(cmd === process.execPath ? args[0] : cmd)?.[1] ?? cmd
    const rest = cmd === process.execPath ? args.slice(1) : args
    ran.push([tool, ...rest])
    if (fail[tool]) return { code: 1, stdout: '', stderr: `${tool}: ${fail[tool]}\n` }
    state[`com.oakgreencc.${tool}`] ??= {
      installed: false,
      loaded: false,
      pid: null,
      stopping: 0,
      unloading: false,
      stopTicks: 0,
      disabled: false,
    }
    state[`com.oakgreencc.${tool}`].installed = true
    return { code: 0, stdout: 'wrote it', stderr: '' }
  }
  return { exec, ran }
}

test('start: installs a missing agent through its tool, enables and loads it; running ones are left alone', async () => {
  const launchd = fakeLaunchd({
    otelcol: {},
    cambium: {},
    mycelium: { installed: false, loaded: false },
    canopy: { installed: false, loaded: false },
  })
  const { ports, state, calls } = launchd
  const before = state['com.oakgreencc.cambium'].pid
  const { exec, ran } = installer(launchd)
  const r = await run(['start'], { ...ports, exec })
  assert.equal(r.code, 0, r.out + r.err)
  assert.match(r.out, /✓ otelcol {2}already running/)
  assert.match(r.out, new RegExp(`✓ cambium {2}already running, pid ${before}`))
  assert.match(r.out, /✓ mycelium loaded, pid \d+/)
  assert.match(r.out, /✓ canopy {3}loaded, pid \d+/)
  assert.deepEqual(ran, [
    ['mycelium', 'install'],
    ['canopy', 'install'],
  ])
  const subs = calls.filter((c) => c.at(-1)?.includes('mycelium')).map((c) => c[1])
  assert.ok(subs.indexOf('enable') < subs.indexOf('bootstrap'))
})

test('start with no names skips a service its tool cannot install; named, it fails with the reason', async () => {
  const launchd = fakeLaunchd({ cambium: {}, mycelium: { installed: false, loaded: false } })
  const { ports } = launchd
  const { exec } = installer(launchd, { mycelium: 'no source is configured; write settings to ~/.mycelium/env first' })
  const all = await run(['start'], { ...ports, exec })
  assert.equal(all.code, 0, all.out)
  assert.match(all.out, /· mycelium skipped: mycelium install: mycelium: no source is configured/)
  const named = await run(['start', 'mycelium'], { ...ports, exec })
  assert.equal(named.code, 1)
  assert.match(named.out, /✗ mycelium mycelium install: .*no source is configured/)
  const otel = fakeLaunchd({ otelcol: { installed: false, loaded: false } })
  assert.match((await run(['start', 'otelcol'], otel.ports)).out, /✗ otelcol {2}not installed/)
})

test('stop: disables and unloads in reverse order; start brings it back; a loaded idle agent is kickstarted', async () => {
  const { ports, state, calls } = fakeLaunchd({ otelcol: {}, cambium: { stopTicks: 3 }, mycelium: {}, canopy: {} })
  const r = await run(['stop'], ports)
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(
    calls.filter((c) => c[1] === 'bootout').map((c) => c.at(-1)?.split('.').at(-1)),
    ['canopy', 'mycelium', 'cambium', 'otelcol'],
  )
  assert.ok(Object.values(state).every((s) => !s.loaded && s.disabled))
  assert.match((await run(['restart', 'cambium'], ports)).out, /✓ cambium {2}loaded/, 'restart re-enables too')
  assert.match((await run(['stop', 'cambium'], ports)).out, /✓ cambium {2}stopped/)
  assert.match((await run(['stop', 'cambium'], ports)).out, /✓ cambium {2}not running/)
  const back = await run(['start'], ports)
  assert.equal(back.code, 0, back.out)
  assert.ok(Object.values(state).every((s) => s.loaded && s.pid && !s.disabled))

  state['com.oakgreencc.mycelium'].pid = null
  assert.match((await run(['start', 'mycelium'], ports)).out, /✓ mycelium started, pid \d+/)
})
