// @ts-check
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { fingerprint, identity } from '../src/envelope.mjs'
import { createIntake } from '../src/intake.mjs'
import { pass } from '../src/runner.mjs'
import { ascConfig } from '../src/sources/asc.mjs'
import {
  clip,
  crashEnvelope,
  crashSignature,
  LOG_MAX,
  normalizeFrame,
  testflightSource,
} from '../src/sources/testflight.mjs'
import { memoryState } from '../src/state.mjs'
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
const SINCE = NOW - 48 * 3_600_000
const tf = fixture('testflight.json')

/** @param {string} url */
const route = (url) => {
  const log = /betaFeedbackCrashSubmissions\/([^/]+)\/crashLog$/.exec(url)
  if (log) return tf.crashLogs[log[1]]
  const feed = url.includes('/betaFeedbackScreenshotSubmissions') ? tf.feedback : tf.crash
  if (url.includes('cursor=PAGE2')) return feed.page2
  if (url.includes('cursor=')) return undefined
  return feed.page1
}
const source = () => {
  const f = fakeFetch(route)
  return { f, src: testflightSource({ fetch: f.fetch, config: /** @type {any} */ (ascConfig(env)) }) }
}

test('testflight: both feeds paged via links.next, oldest first across them, stopping at the window', async () => {
  const { f, src } = source()
  const items = await src.pull(null, { now: NOW, since: SINCE })
  assert.deepEqual(
    items.map((i) => i.envelope?.externalId),
    ['cr-1', 'fb-1', 'fb-2', 'cr-2', 'fb-3', 'cr-3'],
  )
  const lists = f.calls.filter((c) => !c.url.endsWith('/crashLog')).map((c) => c.url)
  assert.equal(lists.length, 4, 'two pages per feed; page 3 is never read')
  assert.ok(
    lists[0].includes(
      '/v1/apps/1000000001/betaFeedbackScreenshotSubmissions?sort=-createdDate&limit=200&include=build&fields[builds]=version',
    ),
  )
  assert.ok(lists.some((u) => u.includes('/v1/apps/1000000001/betaFeedbackCrashSubmissions?sort=-createdDate')))
  assert.deepEqual(
    f.calls.filter((c) => c.url.endsWith('/crashLog')).map((c) => c.url.split('/v1/')[1]),
    [
      'betaFeedbackCrashSubmissions/cr-3/crashLog',
      'betaFeedbackCrashSubmissions/cr-2/crashLog',
      'betaFeedbackCrashSubmissions/cr-1/crashLog',
    ],
  )
  assert.ok(f.calls.every((c) => c.init.method === 'GET' && c.init.headers.Authorization.startsWith('Bearer ')))
})

test('testflight: one cursor per feed; each item carries both; nothing new past the last', async () => {
  const { src } = source()
  const items = await src.pull(null, { now: NOW, since: SINCE })
  assert.deepEqual(items[0].cursor, {
    feedback: { at: SINCE, ids: [] },
    crash: { at: Date.parse('2026-10-31T08:00:00Z'), ids: ['cr-1'] },
  })
  const last = items.at(-1)?.cursor
  assert.deepEqual(last, {
    feedback: { at: Date.parse('2026-11-01T18:00:00Z'), ids: ['fb-3'] },
    crash: { at: Date.parse('2026-11-01T19:00:00Z'), ids: ['cr-3'] },
  })
  assert.deepEqual(await source().src.pull(last, { now: NOW, since: 0 }), [], 'nothing new past the cursor')

  // Resuming mid-pass: only what lies past each feed's own cursor comes back.
  const mid = items[2].cursor
  const rest = await source().src.pull(mid, { now: NOW, since: 0 })
  assert.deepEqual(
    rest.map((i) => i.envelope?.externalId),
    ['cr-2', 'fb-3', 'cr-3'],
  )
})

test('testflight: feedback envelope has build, device and OS; screenshot URLs flagged as expiring; no email', async () => {
  const items = await source().src.pull(null, { now: NOW, since: SINCE })
  const fb = items.find((i) => i.envelope?.externalId === 'fb-3')?.envelope
  assert.ok(fb)
  assert.equal(identity(fb), 'testflight:1000000001/fb-3')
  assert.deepEqual(fb.meta, {
    kind: 'feedback',
    appId: '1000000001',
    build: '42',
    deviceModel: 'iPhone16,2',
    osVersion: '18.1',
    devicePlatform: 'IOS',
    locale: 'en-US',
    screenshots: 2,
  })
  assert.match(fb.body, /^The save button is hidden behind the keyboard\./)
  assert.match(fb.body, /Apple's signed URLs and they expire \(2026-11-02T20:00:00Z\)/)
  assert.match(fb.body, /- https:\/\/tf-feedback\.itunes\.apple\.com\/eimg\/a\.jpg/)
  const action = await createIntake(fakeGithub().client).plan(fb)
  assert.ok(action.action === 'create')
  assert.match(action.body, /\| meta\.build \| `42` \|/)
  assert.match(action.body, /\| meta\.deviceModel \| `iPhone16,2` \|/)
  assert.match(action.body, /\| meta\.osVersion \| `18\.1` \|/)
  for (const i of items) assert.doesNotMatch(JSON.stringify(i.envelope), /tester@example\.com|email/i)
  const blank = items.find((i) => i.envelope?.externalId === 'fb-2')?.envelope
  assert.equal(blank?.title, 'TestFlight feedback')
})

test('testflight: crash signature ignores addresses, offsets, line numbers and numbers in the reason', () => {
  const logs = tf.crashLogs
  const [a, b, c] = ['cr-1', 'cr-2', 'cr-3'].map((k) => crashSignature(logs[k].data.attributes.logText))
  assert.match(String(a), /^[0-9a-f]{16}$/)
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(
    normalizeFrame('2   SeKtor   \t0x0000000102aa11c0 SyncEngine.flush() + 120 (SyncEngine.swift:42)'),
    'sektor syncengine.flush()',
  )
  assert.equal(normalizeFrame('3   SeKtor   0x0000000102aa11f0 0x102000000 + 61680'), 'sektor')
  assert.equal(normalizeFrame('Thread 0 Crashed:'), null)
  assert.equal(crashSignature('no recognisable report'), null)
})

test('testflight: a crash envelope has the clipped, fenced logText and the device table', async () => {
  const items = await source().src.pull(null, { now: NOW, since: SINCE })
  const cr = items.find((i) => i.envelope?.externalId === 'cr-2')?.envelope
  assert.ok(cr)
  assert.equal(
    cr.title,
    'Crash: EXC_CRASH (SIGABRT): *** -[__NSArrayM objectAtIndex:]: index 12 beyond bounds [0 .. 9]',
  )
  assert.deepEqual(
    { ...cr.meta, signature: typeof cr.meta.signature },
    {
      kind: 'crash',
      signature: 'string',
      appId: '1000000001',
      build: '42',
      deviceModel: 'iPhone15,3',
      osVersion: '18.0.1',
      devicePlatform: 'IOS',
      locale: 'en-US',
    },
  )
  assert.match(cr.body, /Tester comment:\nIt crashed again while syncing\./)
  assert.match(cr.body, /Crash log:\nIncident Identifier:/)
  const action = await createIntake(fakeGithub().client).plan(cr)
  assert.ok(action.action === 'create')
  assert.match(action.body, /## Report\n\n```text\n[\s\S]*Exception Type: {2}EXC_CRASH[\s\S]*\n```\n/)
  assert.match(action.body, /\| meta\.build \| `42` \|/)
  assert.match(action.body, /\| meta\.deviceModel \| `iPhone15,3` \|/)
  assert.match(action.body, /\| meta\.osVersion \| `18\.0\.1` \|/)

  const long = `Exception Type: EXC_BAD_ACCESS\n${'x'.repeat(LOG_MAX + 500)}`
  const big = crashEnvelope({ id: 'cr-9', attributes: { createdDate: '2026-11-01T00:00:00Z' } }, '1', '1', long)
  assert.ok(big.body.length < LOG_MAX + 200)
  assert.match(big.body, /\[clipped: 531 more characters\]$/)
  assert.equal(clip('short'), 'short')
})

test('testflight: two crashes with one signature give one create and one comment; another signature a new issue', async () => {
  const gh = fakeGithub()
  const tally = await pass(source().src, {
    intake: createIntake(gh.client),
    state: memoryState(),
    now: NOW,
    backfillMs: 48 * 3_600_000,
  })
  assert.deepEqual(tally, { source: 'testflight', created: 5, commented: 1, skipped: 0 })
  const crashes = gh.state.issues.filter((i) => i.title.startsWith('[testflight] Crash:'))
  assert.equal(crashes.length, 2)
  assert.equal(gh.state.comments.length, 1)
  assert.equal(gh.state.comments[0].number, crashes[0].number)
  assert.match(gh.state.comments[0].body, /\| external id \| `cr-2` \|/)
  assert.match(gh.state.comments[0].body, /Crash log:/)
})

test('testflight: crash identity is the signature; feedback identity the submission', () => {
  const log = tf.crashLogs['cr-1'].data.attributes.logText
  const at = { attributes: { createdDate: '2026-11-01T00:00:00Z' } }
  const one = crashEnvelope({ id: 'a', ...at }, '7', '1', log)
  const two = crashEnvelope({ id: 'b', ...at }, '7', '2', log)
  assert.equal(identity(one), `testflight:7/crash/${crashSignature(log)}`)
  assert.equal(fingerprint(one), fingerprint(two))
  const bare = crashEnvelope({ id: 'c', ...at }, '7', '1', '')
  assert.equal(identity(bare), 'testflight:7/crash/submission-c')
})

test('cli: poll testflight --dry-run prints feedback and crash envelopes from the fixtures', async () => {
  const lines = /** @type {string[]} */ ([])
  const code = await main(['poll', 'testflight', '--dry-run'], {
    env,
    fetch: fakeFetch(route).fetch,
    now: () => NOW,
    out: (l) => lines.push(l),
    err: () => {},
  })
  assert.equal(code, 0)
  const records = lines.map((l) => JSON.parse(l))
  assert.deepEqual(
    records.map((r) => [r.action, r.envelope.meta.kind, r.envelope.externalId]),
    [
      ['create', 'crash', 'cr-1'],
      ['create', 'feedback', 'fb-1'],
      ['create', 'feedback', 'fb-2'],
      ['comment', 'crash', 'cr-2'],
      ['create', 'feedback', 'fb-3'],
      ['create', 'crash', 'cr-3'],
    ],
  )
  assert.equal(records[3].issue, 0)
  await assert.rejects(
    main(['poll', 'testflight', '--dry-run'], { env: {}, out: () => {}, err: () => {} }),
    /MYCELIUM_ASC_KEY_ID/,
  )
})
