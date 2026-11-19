// @ts-check
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { fingerprint } from '../src/envelope.mjs'
import { createIntake } from '../src/intake.mjs'
import { REPORTING_SCOPE } from '../src/jwt.mjs'
import { pass } from '../src/runner.mjs'
import { playConfig } from '../src/sources/play.mjs'
import { VITALS_FORGET_MS, VITALS_PERMISSION, vitalsSource } from '../src/sources/vitals.mjs'
import { memoryState } from '../src/state.mjs'
import { fakeFetch, fakeGithub, fixture } from './helpers.mjs'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const account = {
  type: 'service_account',
  client_email: 'intake@example-project.iam.gserviceaccount.com',
  private_key: /** @type {string} */ (privateKey.export({ type: 'pkcs8', format: 'pem' })),
  token_uri: 'https://oauth2.example.test/token',
}
const env = { MYCELIUM_PLAY_PACKAGE: 'com.example.app', MYCELIUM_PLAY_KEY_JSON: JSON.stringify(account) }
const NOW = Date.parse('2026-11-01T20:00:00Z')
const rec = fixture('vitals-error-issues.json')
const BASE = 'https://playdeveloperreporting.googleapis.com/v1beta1/apps/com.example.app'

/** @param {{ page1?: any, page2?: any, report?: any }} [over] */
const route =
  (over = {}) =>
  (/** @type {string} */ url) => {
    const r = { ...rec, ...over }
    if (url === account.token_uri) return r.token
    if (url.startsWith(`${BASE}/errorReports:search?pageSize=1&filter=errorIssueId%20%3D%201111aaaa`)) return r.report
    if (url.startsWith(`${BASE}/errorReports:search`)) return { errorReports: [] }
    if (url.includes('pageToken=PAGE2')) return r.page2
    if (url.startsWith(`${BASE}/errorIssues:search?pageSize=100`)) return r.page1
  }
const source = (/** @type {any} */ f) => vitalsSource({ fetch: f.fetch, config: /** @type {any} */ (playConfig(env)) })
const at = { now: NOW, since: NOW - 24 * 3_600_000 }

test('vitals: every issue page, oldest first, one envelope each with a sample trace; reporting scope', async () => {
  const f = fakeFetch(route())
  const items = await source(f).pull(null, at)
  assert.deepEqual(
    items.map((i) => i.envelope?.externalId),
    ['2222bbbb', '1111aaaa'],
  )
  const crash = /** @type {any} */ (items[1].envelope)
  assert.equal(crash.source, 'vitals')
  assert.equal(
    crash.title,
    'CRASH: java.lang.NullPointerException at com.example.app.feed.FeedAdapter.onBindViewHolder',
  )
  assert.equal(crash.receivedAt, '2026-11-01T18:00:00.000Z')
  assert.match(crash.url, /^https:\/\/play\.google\.com\/console\//)
  assert.match(crash.body, /12 reports, 9 users/)
  assert.match(crash.body, /FeedAdapter\.kt:88/)
  assert.deepEqual(crash.meta, {
    packageName: 'com.example.app',
    type: 'CRASH',
    change: 'new',
    errorReportCount: 12,
    distinctUsers: '9',
    appVersions: '41..42',
    osVersions: '30..35',
  })
  assert.deepEqual(items[1].cursor, {
    issues: {
      '2222bbbb': { count: 3, versions: '42', last: Date.parse('2026-11-01T17:00:00Z') },
      '1111aaaa': { count: 12, versions: '41..42', last: Date.parse('2026-11-01T18:00:00Z') },
    },
  })

  const assertion = new URLSearchParams(f.calls[0].init.body).get('assertion') ?? ''
  const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString())
  assert.equal(claims.scope, REPORTING_SCOPE)
  assert.ok(f.calls.slice(1).every((c) => c.init.method === 'GET'))
  assert.equal(f.calls[1].init.headers.Authorization, 'Bearer ya29.synthetic-reporting-token')
})

test('vitals: a higher count or new versions give an envelope; an unchanged issue gives none', async () => {
  const f = fakeFetch(route())
  const src = source(f)
  const first = await src.pull(null, at)
  const cursor = first.at(-1)?.cursor
  assert.deepEqual(await src.pull(cursor, at), [], 'nothing changed')

  const more = structuredClone(rec.page1)
  more.errorIssues[0].errorReportCount = '20'
  const page2 = structuredClone(rec.page2)
  page2.errorIssues[0].lastAppVersion.versionCode = '43'
  const changed = await source(fakeFetch(route({ page1: more, page2 }))).pull(cursor, at)
  assert.deepEqual(
    changed.map((i) => [i.envelope?.externalId, i.envelope?.meta.change]),
    [
      ['2222bbbb', 'versions'],
      ['1111aaaa', 'count'],
    ],
  )
  assert.match(String(changed[1].envelope?.body), /Up from 12 reports/)
  assert.equal(changed[1].cursor.issues['1111aaaa'].count, 20)

  // A lower count is no news; the cursor keeps the high-water mark.
  const fewer = structuredClone(rec.page1)
  fewer.errorIssues[0].errorReportCount = '5'
  assert.deepEqual(await source(fakeFetch(route({ page1: fewer }))).pull(cursor, at), [])
})

test('vitals: a later report with nothing else new moves the cursor without an envelope; old issues are forgotten', async () => {
  const later = structuredClone(rec.page1)
  later.errorIssues[0].lastErrorReportTime = '2026-11-01T19:00:00Z'
  const stale = { count: 1, versions: '1', last: NOW - VITALS_FORGET_MS - 1 }
  const cursor = {
    issues: {
      '1111aaaa': { count: 12, versions: '41..42', last: Date.parse('2026-11-01T18:00:00Z') },
      '2222bbbb': { count: 3, versions: '42', last: Date.parse('2026-11-01T17:00:00Z') },
      gone: stale,
    },
  }
  const items = await source(fakeFetch(route({ page1: later }))).pull(cursor, at)
  assert.equal(items.length, 1)
  assert.equal(items[0].envelope, null)
  assert.equal(items[0].cursor.issues['1111aaaa'].last, Date.parse('2026-11-01T19:00:00Z'))
  assert.equal(items[0].cursor.issues.gone, undefined)
})

test('vitals: a repeat issue comments on its intent, an unchanged one files nothing', async () => {
  const gh = fakeGithub()
  const state = memoryState()
  const ctx = { intake: createIntake(gh.client), state, now: NOW, backfillMs: 0 }
  assert.deepEqual(await pass(source(fakeFetch(route())), ctx), {
    source: 'vitals',
    created: 2,
    commented: 0,
    skipped: 0,
  })
  const more = structuredClone(rec.page1)
  more.errorIssues[0].errorReportCount = '30'
  ctx.intake.reset()
  assert.deepEqual(await pass(source(fakeFetch(route({ page1: more }))), ctx), {
    source: 'vitals',
    created: 0,
    commented: 1,
    skipped: 0,
  })
  assert.equal(gh.state.comments.length, 1)
  assert.match(gh.state.comments[0].body, /Up from 12 reports/)
  ctx.intake.reset()
  assert.deepEqual(await pass(source(fakeFetch(route({ page1: more }))), ctx), {
    source: 'vitals',
    created: 0,
    commented: 0,
    skipped: 0,
  })
  assert.equal(gh.state.issues.length, 2)
})

test('vitals: a 403 names the Play Console permission the service account needs', async () => {
  const f = fakeFetch((url) =>
    url === account.token_uri
      ? rec.token
      : { status: 403, body: { error: { code: 403, message: 'The caller does not have permission' } } },
  )
  await assert.rejects(source(f).pull(null, at), (err) => {
    const m = /** @type {Error} */ (err).message
    assert.ok(m.includes(VITALS_PERMISSION), m)
    assert.ok(m.includes(account.client_email), m)
    assert.match(m, /Users and permissions/)
    return true
  })
})

test('cli: poll vitals --dry-run plans a create per issue, then a comment for a repeat', async () => {
  const lines = /** @type {string[]} */ ([])
  const prior = (/** @type {string} */ id) =>
    fingerprint(/** @type {any} */ ({ source: 'vitals', externalId: id, meta: { packageName: 'com.example.app' } }))
  const gh = fakeGithub([{ number: 7, body: `<!-- mycelium:fingerprint=${prior('2222bbbb')} -->\n` }])
  const code = await main(['poll', 'vitals', '--dry-run'], {
    env,
    fetch: fakeFetch(route()).fetch,
    github: gh.client,
    now: () => NOW,
    out: (l) => lines.push(l),
    err: () => {},
  })
  assert.equal(code, 0)
  const records = lines.map((l) => JSON.parse(l))
  assert.deepEqual(
    records.map((r) => [r.action, r.envelope.externalId, r.issue ?? null]),
    [
      ['comment', '2222bbbb', 7],
      ['create', '1111aaaa', null],
    ],
  )
  assert.equal(
    records[1].title,
    '[vitals] CRASH: java.lang.NullPointerException at com.example.app.feed.FeedAdapter.onBindViewHolder',
  )
  assert.equal(gh.state.issues.length, 1)
  assert.equal(gh.state.comments.length, 0)
})

test('cli: poll vitals needs the Play settings', async () => {
  await assert.rejects(
    main(['poll', 'vitals', '--dry-run'], { env: {}, out: () => {}, err: () => {} }),
    /vitals: not configured; set MYCELIUM_PLAY_PACKAGE/,
  )
})
