// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { envelope, fingerprint, identity } from '../src/envelope.mjs'

const asc = (over = {}) =>
  envelope({
    source: 'asc',
    externalId: 'REVIEW-1',
    receivedAt: '2026-11-01T12:00:00Z',
    meta: { appId: '1000000001' },
    ...over,
  })

test('envelope: normalized shape, required fields enforced', () => {
  const e = asc({ title: '  Hi  ', url: '' })
  assert.deepEqual(Object.keys(e), ['source', 'externalId', 'receivedAt', 'author', 'title', 'body', 'url', 'meta'])
  assert.equal(e.title, 'Hi')
  assert.equal(e.url, null)
  assert.equal(e.receivedAt, '2026-11-01T12:00:00.000Z')
  assert.throws(() => envelope({ source: 'asc', receivedAt: '2026-11-01T00:00:00Z' }), /externalId/)
  assert.throws(() => asc({ receivedAt: 'not a date' }), /not a date/)
})

test('fingerprint: pinned value, so a code change cannot silently re-file every intent', () => {
  assert.equal(identity(asc()), 'asc:1000000001/review-1')
  assert.equal(fingerprint(asc()), '2ccbc9b5320fa1c995a728b1')
})

test('fingerprint: only the identity counts — text, author, time do not', () => {
  const a = asc()
  const b = asc({ title: 'edited', body: 'new text', author: 'x', receivedAt: '2026-11-02T00:00:00Z' })
  assert.equal(fingerprint(a), fingerprint(b))
  assert.equal(fingerprint(asc({ externalId: ' review-1 ' })), fingerprint(a))
  assert.notEqual(fingerprint(asc({ externalId: 'REVIEW-2' })), fingerprint(a))
  assert.notEqual(fingerprint(asc({ meta: { appId: '2' } })), fingerprint(a))
})

test('fingerprint: per-connector identities', () => {
  const d = (/** @type {any} */ meta, id = '2') =>
    envelope({ source: 'discord', externalId: id, receivedAt: '2026-11-01T00:00:00Z', meta })
  assert.equal(identity(d({ channelId: '9' }, '1')), 'discord:9/1')
  assert.equal(fingerprint(d({ channelId: '9', rootId: '1' })), fingerprint(d({ channelId: '9' }, '1')))
  const p = envelope({
    source: 'play',
    externalId: 'gp:AB',
    receivedAt: '2026-11-01T00:00:00Z',
    meta: { packageName: 'com.example.app' },
  })
  assert.equal(identity(p), 'play:com.example.app/gp:ab')
  assert.throws(
    () => fingerprint(envelope({ source: 'fax', externalId: '1', receivedAt: '2026-11-01T00:00:00Z' })),
    /fax/,
  )
})
