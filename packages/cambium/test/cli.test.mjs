// @ts-check
/** The verbs and the daemon loop, against a temp config and the fake collaborators. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.mjs'
import { acquireLock, makeLogger, readHeartbeat, runDaemon, writeHeartbeat } from '../src/daemon.mjs'
import { openStore } from '../src/store.mjs'
import { harness, SLUG } from './fakes.mjs'

function setup(/** @type {any} */ extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cambium-'))
  const cfg = join(home, 'config.json')
  writeFileSync(cfg, JSON.stringify({ host: 'mac', repos: [{ slug: SLUG, path: '/repo' }], paths: { home }, ...extra }))
  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  const err = []
  const io = {
    out: (/** @type {string} */ l) => out.push(l),
    err: (/** @type {string} */ l) => err.push(l),
    env: { CAMBIUM_CONFIG: cfg, HOME: home, PATH: '/usr/bin' },
  }
  return { home, cfg, out, err, io }
}

test('pause / drain / resume write the mode the daemon reads; status reports it', async () => {
  const s = setup()
  assert.equal(await main(['pause'], s.io), 0)
  assert.equal(openStore(join(s.home, 'cambium.db')).mode(), 'paused')
  assert.equal(await main(['drain'], s.io), 0)
  assert.equal(await main(['resume'], s.io), 0)
  assert.deepEqual(s.out, ['mode: paused', 'mode: draining', 'mode: running'])
  s.out.length = 0
  assert.equal(await main(['status'], s.io), 1, 'no heartbeat yet')
  assert.match(s.out.join('\n'), /no heartbeat/)
})

test('status reads the heartbeat file, flags a stale daemon', async () => {
  const s = setup()
  const h = harness({ issues: [{ number: 1, labels: ['q:task'] }] })
  h.deps.heartbeat = (state) => writeHeartbeat(join(s.home, 'state.json'), state)
  await (await import('../src/tick.mjs')).tick(h.deps)
  const finished = Date.parse(/** @type {any} */ (readHeartbeat(join(s.home, 'state.json'))).tick.finishedAt)
  assert.equal(await main(['status'], { ...s.io, now: () => finished + 5000 }), 0)
  const text = s.out.join('\n')
  assert.match(text, /last tick #0 5s ago/)
  assert.match(text, /queues: intake 0 · task 1/)
  assert.match(text, /o\/r#1 task attempt 1/)
  s.out.length = 0
  assert.equal(await main(['status'], { ...s.io, now: () => finished + 600_000 }), 1)
  assert.match(s.out.join('\n'), /STALE/)
  s.out.length = 0
  await main(['status', '--json'], s.io)
  assert.equal(JSON.parse(s.out.join('\n')).heartbeat.version, 1)
})

test('status --json exits 1 with no heartbeat or a stale one, 0 when fresh', async () => {
  const s = setup()
  assert.equal(await main(['status', '--json'], s.io), 1, 'no heartbeat')
  assert.equal(JSON.parse(s.out.join('\n')).heartbeat, null)
  const h = harness({ issues: [] })
  h.deps.heartbeat = (state) => writeHeartbeat(join(s.home, 'state.json'), state)
  await (await import('../src/tick.mjs')).tick(h.deps)
  const finished = Date.parse(/** @type {any} */ (readHeartbeat(join(s.home, 'state.json'))).tick.finishedAt)
  assert.equal(await main(['status', '--json'], { ...s.io, now: () => finished + 5000 }), 0)
  assert.equal(await main(['status', '--json'], { ...s.io, now: () => finished + 600_000 }), 1)
})

test('status creates neither the db nor the state dir when absent', async () => {
  const s = setup()
  const home = join(s.home, 'absent')
  writeFileSync(s.cfg, JSON.stringify({ repos: [{ slug: SLUG, path: '/repo' }], paths: { home } }))
  assert.equal(await main(['status'], s.io), 1)
  assert.equal(await main(['status', '--json'], s.io), 1)
  assert.equal(JSON.parse(s.out.at(-1) ?? '').mode, 'running')
  assert.equal(existsSync(home), false)
})

test('run task --issue N: claims, runs one worker in the foreground, transitions', async () => {
  const s = setup()
  const h = harness({ issues: [{ number: 5, labels: ['q:task'] }] })
  const start = h.spawner.start
  h.spawner.start = async (spec) => {
    assert.equal(spec.foreground, true)
    const started = await start(spec)
    h.gh.addPr({ number: 55, closes: [5] })
    return started
  }
  assert.equal(await main(['run', 'task', '--issue', '5'], { ...s.io, deps: () => h.deps }), 0)
  assert.equal(h.gh.marker(5)?.stage, 'submitted')
  assert.match(s.out.join('\n'), /o\/r#5: submitted · labels \(none\)/)

  assert.equal(await main(['run', 'task', '--issue', '5'], { ...s.io, deps: () => h.deps }), 1)
  assert.match(s.err.join('\n'), /not an open q:task issue/)
  assert.equal(await main(['run', 'task'], { ...s.io, deps: () => h.deps }), 1)
  assert.equal(await main(['run', 'task', '--issue', '5', '--repo', 'x/y'], { ...s.io, deps: () => h.deps }), 1)
})

test('install --dry-run prints the plist; install writes it under LaunchAgents', async () => {
  const s = setup()
  assert.equal(await main(['install', '--dry-run'], s.io), 0)
  assert.match(s.out[0], /would write .*LaunchAgents\/com\.oakgreencc\.cambium\.plist/)
  assert.match(s.out[0], /<key>KeepAlive<\/key>/)
  assert.equal(await main(['install'], s.io), 0)
  const written = readFileSync(join(s.home, 'Library', 'LaunchAgents', 'com.oakgreencc.cambium.plist'), 'utf8')
  assert.match(written, new RegExp(s.cfg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(s.out.at(-1) ?? '', /launchctl bootstrap gui/)
})

test('start with no repos refuses; unknown verbs refuse; help', async () => {
  const s = setup({ repos: [] })
  assert.equal(await main(['start'], s.io), 1)
  assert.match(s.err[0], /no repos/)
  assert.equal(await main(['frobnicate'], s.io), 1)
  assert.equal(await main(['help'], s.io), 0)
  assert.match(s.out.at(-1) ?? '', /cambium run task --issue/)
})

test('start --once: one tick through the injected deps, then out', async () => {
  const s = setup()
  const h = harness({ issues: [{ number: 3, labels: ['q:task'] }] })
  assert.equal(await main(['start', '--once'], { ...s.io, deps: () => h.deps }), 0)
  assert.equal(h.spawner.started.length, 1)
  assert.equal(h.beats.length, 1)
})

test('daemon loop: ticks until aborted, never waits on a worker, survives a throwing tick', async () => {
  const h = harness({ issues: [{ number: 1, labels: ['q:task'] }] })
  const ac = new AbortController()
  let waits = 0
  const n = await runDaemon(h.deps, {
    signal: ac.signal,
    wait: async () => {
      if (++waits === 2)
        h.deps.store.workers = () => {
          throw new Error('db gone')
        }
      if (waits === 3) ac.abort()
    },
  })
  assert.equal(n, 3)
  assert.ok(h.events.some((e) => /db gone/.test(e.msg)))
})

test('one daemon per database; a dead holder does not block', () => {
  const store = openStore(':memory:')
  const procs = { alive: (/** @type {number} */ pid) => pid === 1, kill() {} }
  acquireLock(store, procs, 1)
  assert.throws(() => acquireLock(store, procs, 2), /pid 1/)
  const dead = { alive: () => false, kill() {} }
  acquireLock(store, dead, 2)
  assert.equal(store.get('daemon.pid'), '2')
})

test('logger: file rotation and the event ring', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cambium-')), 'logs', 'cambium.log')
  /** @type {string[]} */
  const echoed = []
  const { log, events } = makeLogger({ file, maxBytes: 10, keep: 2, now: () => 0, echo: (l) => echoed.push(l) })
  log('info', 'one', { repo: 'o/r', issue: 1 })
  log('warn', 'two')
  log('error', 'three')
  assert.deepEqual(
    events().map((e) => e.msg),
    ['two', 'three'],
  )
  assert.match(echoed[0], /info {2}o\/r#1 one/)
  assert.match(readFileSync(`${file}.1`, 'utf8'), /two/)
  assert.match(readFileSync(file, 'utf8'), /three/)
})
