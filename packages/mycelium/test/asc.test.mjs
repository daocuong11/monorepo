// @ts-check
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { test } from 'node:test'
import { ascConfig, ascSource } from '../src/sources/asc.mjs'
import { fakeFetch, fixture } from './helpers.mjs'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const pem = /** @type {string} */ (privateKey.export({ type: 'pkcs8', format: 'pem' }))
const env = {
  MYCELIUM_ASC_KEY_ID: 'KEYID12345',
  MYCELIUM_ASC_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
  MYCELIUM_ASC_KEY_P8: Buffer.from(pem).toString('base64'),
  MYCELIUM_ASC_APP_ID: '1000000001',
}
const NOW = Date.parse('2026-11-01T20:00:00Z')
const pages = fixture('asc-reviews.json')
const route = (/** @type {string} */ url) =>
  url.includes('cursor=PAGE2') ? pages.page2 : url.includes('cursor=') ? undefined : pages.page1

test('asc config: every part from env, the key as PEM or base64; null when one is missing', () => {
  assert.equal(ascConfig(env)?.privateKey, pem)
  assert.equal(ascConfig({ ...env, MYCELIUM_ASC_KEY_P8: pem })?.privateKey, pem)
  assert.equal(ascConfig({ ...env, MYCELIUM_ASC_APP_ID: '' }), null)
})

test('asc: reviews past the window, oldest first, stopping at the first older one', async () => {
  const f = fakeFetch(route)
  const src = ascSource({ fetch: f.fetch, config: /** @type {any} */ (ascConfig(env)) })
  const items = await src.pull(null, { now: NOW, since: NOW - 48 * 3_600_000 })
  assert.deepEqual(
    items.map((i) => i.envelope?.externalId.slice(-1)),
    ['2', '3', '4'],
  )
  assert.equal(f.calls.length, 2, 'page 3 is never read: page 2 already reached the window')
  assert.ok(f.calls[0].url.includes('/v1/apps/1000000001/customerReviews?sort=-createdDate'))
  assert.ok(f.calls.every((c) => c.init.method === 'GET'))
  const last = items.at(-1)
  assert.deepEqual(last?.envelope, {
    source: 'asc',
    externalId: '00000000-aaaa-4000-8000-000000000004',
    receivedAt: '2026-11-01T19:30:00.000Z',
    author: 'reviewer_four',
    title: 'Crashes on launch',
    body: 'Since the last update the app closes right after the splash screen.',
    url: null,
    meta: { appId: '1000000001', rating: 1, territory: 'USA' },
  })
  assert.deepEqual(last?.cursor, {
    at: Date.parse('2026-11-01T19:30:00Z'),
    ids: ['00000000-aaaa-4000-8000-000000000004'],
  })

  const again = await src.pull(last?.cursor, { now: NOW, since: 0 })
  assert.deepEqual(again, [], 'nothing new past the cursor')
})

test('asc: the bearer is an ES256 App Store Connect token signed with the configured key', async () => {
  const f = fakeFetch(route)
  await ascSource({ fetch: f.fetch, config: /** @type {any} */ (ascConfig(env)) }).pull(null, { now: NOW, since: NOW })
  const jwt = f.calls[0].init.headers.Authorization.replace('Bearer ', '')
  const [h, c, s] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'ES256', kid: 'KEYID12345', typ: 'JWT' })
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString())
  assert.equal(claims.aud, 'appstoreconnect-v1')
  assert.equal(claims.exp - claims.iat, 900)
  assert.ok(
    verify(
      'sha256',
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    ),
  )
})

test('asc: a 429 waits Retry-After and repeats; another error names the status', async () => {
  let n = 0
  const slept = /** @type {number[]} */ ([])
  const f = fakeFetch(() => (n++ === 0 ? { status: 429, body: '', headers: { 'retry-after': '2' } } : { data: [] }))
  const src = ascSource({
    fetch: f.fetch,
    config: /** @type {any} */ (ascConfig(env)),
    sleep: async (ms) => void slept.push(ms),
  })
  assert.deepEqual(await src.pull(null, { now: NOW, since: NOW }), [])
  assert.deepEqual(slept, [2000])
  const bad = fakeFetch(() => ({ status: 401, body: '{"errors":[{"status":"401"}]}' }))
  await assert.rejects(
    ascSource({ fetch: bad.fetch, config: /** @type {any} */ (ascConfig(env)) }).pull(null, { now: NOW, since: NOW }),
    /asc: 401/,
  )
})
