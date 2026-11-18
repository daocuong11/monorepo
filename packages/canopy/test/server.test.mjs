// @ts-check
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { resolveSettings } from '../src/config.mjs'
import { cachedQueues } from '../src/github.mjs'
import { group } from '../src/queues.mjs'
import { buildState, createApp, hostnameOf } from '../src/server.mjs'
import { graphqlAnswer, heartbeat, T0 } from './fixtures.mjs'

const REPO = 'oakgreencc/monorepo'

function stateFile(/** @type {any} */ body) {
  const path = join(mkdtempSync(join(tmpdir(), 'canopy-')), 'state.json')
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
  return path
}

const fakeQueues = (now = () => T0) => {
  const seen = /** @type {string[][]} */ ([])
  const client = {
    queues: async (/** @type {string} */ slug) => {
      seen.push([slug])
      return group(graphqlAnswer(), slug)
    },
  }
  return { queues: cachedQueues({ client, now }), seen }
}

/**
 * Serve once on an ephemeral loopback port, run `fn`, then close every socket
 * so no handle outlives the test.
 *
 * @param {import('../src/server.mjs').AppOptions} opts
 * @param {(get: (path: string, init?: { method?: string, host?: string }) => Promise<{ status: number, type: string, body: string }>) => Promise<void>} fn
 */
async function serve(opts, fn) {
  const server = createApp(opts)
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)))
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  const get = (/** @type {string} */ path, { method = 'GET', host = `127.0.0.1:${port}` } = {}) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: { host, connection: 'close' } }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d) => {
          body += d
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }))
      })
      req.on('error', reject)
      req.end()
    })
  try {
    await fn(/** @type {any} */ (get))
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(() => r(undefined)))
  }
}

test('GET / serves one self-contained page', async () => {
  const { queues } = fakeQueues()
  await serve({ statePath: stateFile(heartbeat()), repos: [REPO], queues }, async (get) => {
    const res = await get('/')
    assert.equal(res.status, 200)
    assert.match(res.type, /text\/html/)
    assert.match(res.body, /<style>/)
    assert.match(res.body, /<script>/)
    assert.match(res.body, /\/api\/state/)
    assert.match(res.body, /prefers-color-scheme:dark/)
    assert.doesNotMatch(res.body, /<(script|link)[^>]+(src|href)=/)
    assert.doesNotMatch(res.body, /https?:\/\/(?!github\.com)[a-z]/i)
    const script = res.body.split('<script>')[1].split('</script>')[0]
    assert.doesNotThrow(() => new Function(script))
  })
})

test('GET /api/state: heartbeat and grouped queues', async () => {
  const { queues } = fakeQueues(() => Date.now())
  const hb = heartbeat({ tick: { n: 1, finishedAt: new Date().toISOString() } })
  await serve({ statePath: stateFile(hb), repos: [REPO], queues }, async (get) => {
    const res = await get('/api/state')
    assert.equal(res.status, 200)
    assert.match(res.type, /application\/json/)
    const s = JSON.parse(res.body)
    assert.equal(s.heartbeat.status, 'ok')
    assert.equal(s.heartbeat.stale, false)
    assert.equal(s.heartbeat.data.workers[0].issue, 12)
    assert.equal(s.github.columns.human[0].why, 'budget')
    assert.deepEqual(
      s.github.prs.map((/** @type {any} */ p) => p.number),
      [20, 22],
    )
    assert.deepEqual(
      s.github.stranded.map((/** @type {any} */ i) => [i.number, i.pr.number]),
      [[7, 30]],
    )
    assert.equal(s.cacheMs, 15_000)
  })
})

test('GET /api/state with an unknown version still answers 200 with the message', async () => {
  const { queues } = fakeQueues()
  await serve({ statePath: stateFile(heartbeat({ version: 9 })), repos: [REPO], queues }, async (get) => {
    const s = JSON.parse((await get('/api/state')).body)
    assert.equal(s.heartbeat.status, 'unknown-version')
    assert.equal(s.github.columns.task.length, 1)
  })
})

test('repos default to the heartbeat when none are configured; none at all is a note', async () => {
  const { queues, seen } = fakeQueues()
  const s = await buildState({ statePath: stateFile(heartbeat()), repos: [], queues, now: () => T0 })
  assert.deepEqual(seen, [[REPO]])
  assert.equal(s.github.columns.task.length, 1)

  const none = await buildState({ statePath: '/nonexistent/state.json', repos: [], queues, now: () => T0 })
  assert.equal(none.heartbeat.status, 'missing')
  assert.match(none.notes.join(), /no repositories/)
})

test('read-only, loopback Host only, 404 elsewhere', async () => {
  const { queues } = fakeQueues()
  await serve({ statePath: stateFile(heartbeat()), repos: [REPO], queues }, async (get) => {
    assert.equal((await get('/api/state', { method: 'POST' })).status, 405)
    assert.equal((await get('/nope')).status, 404)
    assert.equal((await get('/', { host: 'evil.example' })).status, 403)
    assert.equal((await get('/', { host: 'localhost:4317' })).status, 200)
    assert.equal((await get('/', { method: 'HEAD' })).body, '')
  })
})

test('hostnameOf strips port and brackets', () => {
  assert.equal(hostnameOf('127.0.0.1:4317'), '127.0.0.1')
  assert.equal(hostnameOf('[::1]:4317'), '::1')
  assert.equal(hostnameOf('LocalHost'), 'localhost')
  assert.equal(hostnameOf(undefined), '')
})

test('resolveSettings: --state, then config paths.heartbeat, then paths.home, then ~/.cambium', () => {
  const files = /** @type {Record<string, string>} */ ({
    '/c/hb.json': JSON.stringify({ paths: { heartbeat: '~/x/state.json' }, repos: [{ slug: REPO }] }),
    '/c/home.json': JSON.stringify({ paths: { home: '/srv/cambium' } }),
  })
  const read = (/** @type {string} */ p) => {
    if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    return files[p]
  }
  const deps = { home: '/home/me', read, env: {} }
  assert.equal(resolveSettings({ state: '/s.json', config: '/c/hb.json' }, deps).statePath, '/s.json')
  const fromCfg = resolveSettings({}, { ...deps, env: { CAMBIUM_CONFIG: '/c/hb.json' } })
  assert.equal(fromCfg.statePath, '/home/me/x/state.json')
  assert.deepEqual(fromCfg.repos, [REPO])
  assert.equal(resolveSettings({ config: '/c/home.json' }, deps).statePath, '/srv/cambium/state.json')
  const dflt = resolveSettings({}, deps)
  assert.equal(dflt.statePath, '/home/me/.cambium/state.json')
  assert.equal(dflt.configError, null)
  assert.match(String(resolveSettings({ config: '/c/missing.json' }, deps).configError), /ENOENT/)
  assert.deepEqual(resolveSettings({ repos: ['a/b', 'a/b'] }, deps).repos, ['a/b'])
  assert.throws(() => resolveSettings({ repos: ['nope'] }, deps), /owner\/name/)
})

test('cli: defaults to 127.0.0.1:4317, honours --port/--host, rejects bad flags', () => {
  const client = { queues: async () => group(graphqlAnswer(), REPO) }
  const quiet = { env: {}, client, out: () => {}, err: () => {} }
  const d = main(['--config', '/nonexistent/c.json'], quiet)
  assert.ok(typeof d === 'object')
  assert.deepEqual([d.host, d.port], ['127.0.0.1', 4317])
  const c = main(['--config', '/nonexistent/c.json', '--port', '0', '--host', '::1', '--repo', REPO], quiet)
  assert.ok(typeof c === 'object')
  assert.deepEqual([c.host, c.port], ['::1', 0])
  assert.equal(main(['--port', 'x'], quiet), 2)
  assert.equal(main(['--bogus'], quiet), 2)
  assert.equal(main(['--repo', 'bad'], quiet), 2)
  assert.equal(main(['--help'], quiet), 0)
})
