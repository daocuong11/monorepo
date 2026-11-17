// @ts-check
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { test } from 'node:test'
import { playConfig, playSource } from '../src/sources/play.mjs'
import { fakeFetch, fixture } from './helpers.mjs'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const account = {
  type: 'service_account',
  client_email: 'intake@example-project.iam.gserviceaccount.com',
  private_key: /** @type {string} */ (privateKey.export({ type: 'pkcs8', format: 'pem' })),
  token_uri: 'https://oauth2.example.test/token',
}
const env = { MYCELIUM_PLAY_PACKAGE: 'com.example.app', MYCELIUM_PLAY_KEY_JSON: JSON.stringify(account) }
const NOW = Date.parse('2026-11-01T20:00:00Z')
const rec = fixture('play-reviews.json')
const route = (/** @type {string} */ url) => {
  if (url === account.token_uri) return rec.token
  if (url.includes('token=PAGE2')) return rec.page2
  if (url.includes('/applications/com.example.app/reviews?maxResults=100')) return rec.page1
}

test('play config: inline key JSON or a key path; null when either part is missing', () => {
  assert.equal(playConfig(env)?.account.client_email, account.client_email)
  const viaPath = playConfig({ MYCELIUM_PLAY_PACKAGE: 'p', MYCELIUM_PLAY_KEY_PATH: '/k.json' }, (p) =>
    p === '/k.json' ? JSON.stringify(account) : '',
  )
  assert.equal(viaPath?.packageName, 'p')
  assert.equal(playConfig({ MYCELIUM_PLAY_PACKAGE: 'p' }), null)
  assert.throws(() => playConfig({ ...env, MYCELIUM_PLAY_KEY_JSON: '{}' }), /client_email/)
})

test('play: every page, oldest first; the token minted once and verifiable', async () => {
  const f = fakeFetch(route)
  const src = playSource({ fetch: f.fetch, config: /** @type {any} */ (playConfig(env)) })
  const items = await src.pull(null, { now: NOW, since: NOW - 24 * 3_600_000 })
  assert.deepEqual(
    items.map((i) => i.envelope?.externalId),
    ['gp:SYNTHETIC-REVIEW-0001', 'gp:SYNTHETIC-REVIEW-0002'],
  )
  assert.deepEqual(items[1].envelope, {
    source: 'play',
    externalId: 'gp:SYNTHETIC-REVIEW-0002',
    receivedAt: '2026-11-01T18:00:00.500Z',
    author: 'Play User Two',
    title: '',
    body: 'Notifications never arrive on my Pixel.',
    url: null,
    meta: { packageName: 'com.example.app', rating: 2, appVersion: '1.4.0', language: 'en', device: 'example_device' },
  })
  assert.deepEqual(
    f.calls.map((c) => c.init.method),
    ['POST', 'GET', 'GET'],
  )
  assert.equal(f.calls[1].init.headers.Authorization, 'Bearer ya29.synthetic-access-token')
  const assertion = new URLSearchParams(f.calls[0].init.body).get('assertion') ?? ''
  const [h, c, s] = assertion.split('.')
  assert.equal(JSON.parse(Buffer.from(c, 'base64url').toString()).aud, account.token_uri)
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')))

  const again = await src.pull(items.at(-1)?.cursor, { now: NOW + 60_000, since: 0 })
  assert.deepEqual(again, [])
  assert.equal(f.calls.filter((x) => x.url === account.token_uri).length, 1, 'cached token reused')
})

test('play: an edited review comes back as a new event with the same id', async () => {
  const edited = structuredClone(rec.page2)
  edited.reviews[0].comments[0].userComment.lastModified.seconds = String(Date.parse('2026-11-01T19:00:00Z') / 1000)
  edited.reviews[0].comments[0].userComment.text = 'Dark mode fixed, thanks.'
  const cursor = { at: Date.parse('2026-11-01T18:00:00.500Z'), ids: ['gp:SYNTHETIC-REVIEW-0002'] }
  const f = fakeFetch((url) => (url === account.token_uri ? rec.token : edited))
  const items = await playSource({ fetch: f.fetch, config: /** @type {any} */ (playConfig(env)) }).pull(cursor, {
    now: NOW,
    since: 0,
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].envelope?.externalId, 'gp:SYNTHETIC-REVIEW-0001')
  assert.equal(items[0].envelope?.body, 'Dark mode fixed, thanks.')
})
