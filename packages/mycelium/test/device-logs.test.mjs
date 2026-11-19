// @ts-check
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { claimSignature, g, hexHash, hkdf, k, modPow, N, padHex, passwordX, totp } from '../src/cognito.mjs'
import { createIntake } from '../src/intake.mjs'
import { pass, sourceFromEnv } from '../src/runner.mjs'
import { crashSignature, deviceLogConfig, deviceLogsSource, parseReport } from '../src/sources/device-logs.mjs'
import { memoryState } from '../src/state.mjs'
import { fakeFetch, fakeGithub, fixture } from './helpers.mjs'

const env = {
  MYCELIUM_DEVICELOG_API: 'https://api.example.test',
  MYCELIUM_DEVICELOG_POOL_ID: 'us-east-1_TESTPOOL',
  MYCELIUM_DEVICELOG_CLIENT_ID: 'client123',
  MYCELIUM_DEVICELOG_USER: 'log-reader',
  MYCELIUM_DEVICELOG_PASSWORD: 'correct horse',
  MYCELIUM_DEVICELOG_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
}
const NOW = Date.parse('2026-11-01T20:00:00Z')
const DAY = 24 * 3_600_000
const API = 'https://api.example.test/v3'
const COGNITO = 'https://cognito-idp.us-east-1.amazonaws.com/'
const S3 = 'https://bucket.s3.example.test/'
const rec = fixture('device-logs.json')

/** Cognito's server side of USER_SRP_AUTH + SOFTWARE_TOKEN_MFA, for one user. */
function fakeCognito({ password = env.MYCELIUM_DEVICELOG_PASSWORD } = {}) {
  const userId = 'srp-user-0001'
  const salt = randomBytes(16).toString('hex')
  const secretBlock = randomBytes(32).toString('base64')
  const v = modPow(g, passwordX('TESTPOOL', userId, password, salt), N)
  const b = BigInt(`0x${randomBytes(64).toString('hex')}`)
  const B = (k * v + modPow(g, b, N)) % N
  /** @type {bigint} */
  let A = 0n
  const signIns = { count: 0 }
  /** @param {any} init */
  const answer = (init) => {
    const op = init.headers['X-Amz-Target'].split('.').pop()
    const body = JSON.parse(init.body)
    assert.equal(body.ClientId, 'client123')
    if (op === 'InitiateAuth') {
      assert.equal(body.AuthFlow, 'USER_SRP_AUTH')
      A = BigInt(`0x${body.AuthParameters.SRP_A}`)
      return {
        ChallengeName: 'PASSWORD_VERIFIER',
        ChallengeParameters: {
          SALT: salt,
          SRP_B: B.toString(16),
          SECRET_BLOCK: secretBlock,
          USER_ID_FOR_SRP: userId,
          USERNAME: userId,
        },
      }
    }
    if (body.ChallengeName === 'PASSWORD_VERIFIER') {
      const r = body.ChallengeResponses
      const u = BigInt(`0x${hexHash(padHex(A) + padHex(B))}`)
      const S = modPow(A * modPow(v, u, N), b, N)
      const expected = claimSignature(hkdf(S, u), 'TESTPOOL', userId, secretBlock, r.TIMESTAMP)
      assert.match(r.TIMESTAMP, /^Sun Nov 1 20:00:00 UTC 2026$/)
      if (r.PASSWORD_CLAIM_SIGNATURE !== expected)
        return {
          status: 400,
          body: { __type: 'NotAuthorizedException', message: 'Incorrect username or password.' },
        }
      return { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'mfa-session', ChallengeParameters: {} }
    }
    assert.equal(body.ChallengeName, 'SOFTWARE_TOKEN_MFA')
    assert.equal(body.Session, 'mfa-session')
    if (body.ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE !== totp(env.MYCELIUM_DEVICELOG_TOTP_SECRET, NOW))
      return { status: 400, body: { __type: 'CodeMismatchException', message: 'Invalid code received for user' } }
    signIns.count++
    return { AuthenticationResult: { IdToken: 'id-token', AccessToken: 'access', ExpiresIn: 3600 } }
  }
  return { answer, signIns }
}

/**
 * The admin API and S3, in memory.
 *
 * @param {{ cognito?: ReturnType<typeof fakeCognito>, items?: (kind: string | null, cursor: string | null) => any }} [opts]
 */
function world({ cognito = fakeCognito(), items } = {}) {
  const list =
    items ??
    ((/** @type {string | null} */ kind, /** @type {string | null} */ cursor) => {
      if (kind === 'bug-report') return cursor === 'PAGE2' ? rec.bugReports.page2 : rec.bugReports.page1
      if (kind === 'crash') return rec.crashes
      return rec.unmarked
    })
  const every = [
    ...rec.bugReports.page1.items,
    ...rec.bugReports.page2.items,
    ...rec.unmarked.items,
    ...rec.crashes.items,
  ]
  const f = fakeFetch((url, init) => {
    if (url === COGNITO) return cognito.answer(init)
    if (url.startsWith(S3)) {
      assert.equal(init.headers, undefined, 'a presigned URL carries its own auth')
      return { status: 200, body: rec.bodies[url.slice(S3.length).split('?')[0]] }
    }
    assert.equal(init.headers.Authorization, 'id-token')
    const u = new URL(url)
    if (u.pathname === '/v3/admin/device-logs') {
      assert.ok(u.searchParams.get('from'))
      return list(u.searchParams.get('kind'), u.searchParams.get('cursor'))
    }
    const id = decodeURIComponent(u.pathname.split('/').pop() ?? '')
    const summary = every.find((l) => l.logId === id)
    if (!summary) return { status: 404, body: '{"message":"not found"}' }
    const sig = '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef'
    return {
      ...summary,
      downloadUrl: `${S3}${id}${sig}`,
      attachments: (rec.attachments[id] ?? []).map((/** @type {any} */ a) => ({
        ...a,
        downloadUrl: `${S3}${id}/${a.attachmentId}${sig}`,
      })),
    }
  })
  return { ...f, signIns: cognito.signIns }
}

const source = (/** @type {any} */ fetch, /** @type {Record<string, string>} */ extra = {}) =>
  deviceLogsSource({
    fetch,
    config: /** @type {any} */ (deviceLogConfig({ ...env, ...extra })),
    sleep: async () => {},
  })

test('device-logs config: every part from env, /v3 added once; null when one is missing', () => {
  const c = deviceLogConfig(env)
  assert.equal(c?.apiBase, API)
  assert.equal(c?.stage, 'prod')
  assert.equal(c?.crashes, false)
  assert.equal(deviceLogConfig({ ...env, MYCELIUM_DEVICELOG_API: `${API}/` })?.apiBase, API)
  assert.equal(deviceLogConfig({ ...env, MYCELIUM_DEVICELOG_STAGE: 'staging' })?.stage, 'staging')
  assert.equal(deviceLogConfig({ ...env, MYCELIUM_DEVICELOG_TOTP_SECRET: '' }), null)
  assert.throws(() => deviceLogConfig({ ...env, MYCELIUM_DEVICELOG_POOL_ID: 'nope' }), /user pool id/)
})

test('totp: RFC 6238 SHA-1 vectors, zero-padded', () => {
  assert.equal(totp(env.MYCELIUM_DEVICELOG_TOTP_SECRET, 59_000, 8), '94287082')
  assert.equal(totp(env.MYCELIUM_DEVICELOG_TOTP_SECRET, 1111111109_000, 8), '07081804')
  assert.equal(totp(env.MYCELIUM_DEVICELOG_TOTP_SECRET, 1111111109_000), '081804')
})

test('device-logs: SRP + TOTP sign-in, every nextCursor page, oldest first; legacy kind:null only with the header', async () => {
  const w = world()
  const items = await source(w.fetch).pull(null, { now: NOW, since: NOW - DAY })
  assert.deepEqual(
    items.map((i) => [i.envelope?.externalId ?? null, i.cursor.ids[0]]),
    [
      [null, '01LOGDIAGNOS06'],
      ['01LOGLEGACY0005', '01LOGLEGACY0005'],
      ['01LOGREPORT0002', '01LOGREPORT0002'],
      ['01LOGREPORT0003', '01LOGREPORT0003'],
    ],
    'kind:null without the header first is skipped, a diagnostic is never listed, crashes are off',
  )
  assert.equal(w.signIns.count, 1, 'one sign-in for the pass')
  assert.ok(w.calls.some((c) => c.url.includes('kind=bug-report') && c.url.includes('cursor=PAGE2')))
  assert.ok(w.calls.filter((c) => c.url !== COGNITO).every((c) => c.init.method === 'GET'))
  assert.deepEqual(items.at(-1)?.cursor, { at: Date.parse('2026-11-01T19:00:00Z'), ids: ['01LOGREPORT0003'] })

  const e = items.at(-1)?.envelope
  assert.equal(e?.source, 'device-logs')
  assert.equal(e?.title, 'Lap timer froze at turn 3.')
  assert.equal(e?.url, null)
  assert.deepEqual(e?.meta, {
    stage: 'prod',
    kind: 'bug-report',
    platform: 'android',
    deviceModel: 'Pixel 9',
    appVersion: '1.5.0',
    sessionLocalId: 'sess-3',
    userId: 'us-east-1:0000aaaa-0000-4000-8000-000000000003',
    screenshots: 2,
  })
  assert.match(e?.body ?? '', /^Lap timer froze at turn 3\.\nEmail me at \[email\]\n\nroute: \/race\/recording/)
  assert.match(e?.body ?? '', /--- log tail ---\n.*\n.*gps fix lost\n.*timer stalled/)
  assert.match(e?.body ?? '', /with 2 screenshots/)
  assert.match(e?.body ?? '', /GET https:\/\/api\.example\.test\/v3\/admin\/device-logs\/01LOGREPORT0003/)

  const again = await source(w.fetch).pull(items.at(-1)?.cursor ?? null, { now: NOW, since: 0 })
  assert.deepEqual(again, [], 'nothing new past the cursor')
})

test('device-logs: the issue carries the opaque userId, no email and no presigned URL', async () => {
  const gh = fakeGithub()
  const intake = createIntake(gh.client)
  const state = memoryState()
  const tally = await pass(source(world().fetch), { intake, state, now: NOW, backfillMs: DAY })
  assert.deepEqual(tally, { source: 'device-logs', created: 3, commented: 0, skipped: 1 })
  const text = gh.state.issues.map((i) => `${i.title}\n${i.body}`).join('\n')
  assert.doesNotMatch(text, /@example\.com|rider\.three/)
  assert.doesNotMatch(text, /X-Amz|s3\.example|downloadUrl=|https:\/\/bucket/)
  assert.match(text, /\| meta\.userId \| `us-east-1:0000aaaa-0000-4000-8000-000000000003` \|/)
  assert.deepEqual(state.get('device-logs')?.ids, ['01LOGREPORT0003'], 'the time cursor is stored in state')
})

test('device-logs: a refused sign-in is a clear error, never an empty list', async () => {
  const w = world({ cognito: fakeCognito({ password: 'something else' }) })
  await assert.rejects(
    source(w.fetch).pull(null, { now: NOW, since: NOW - DAY }),
    /device-logs: sign-in refused: NotAuthorizedException: Incorrect username or password\./,
  )
  assert.ok(
    w.calls.every((c) => c.url === COGNITO),
    'nothing is listed without a token',
  )
  const wrongCode = world()
  await assert.rejects(
    source(wrongCode.fetch, { MYCELIUM_DEVICELOG_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' }).pull(null, { now: NOW, since: 0 }),
    /CodeMismatchException/,
  )
  const cognito = fakeCognito()
  const denied = fakeFetch((url, init) => (url === COGNITO ? cognito.answer(init) : { status: 403, body: 'no' }))
  await assert.rejects(source(denied.fetch).pull(null, { now: NOW, since: 0 }), /device-logs: 403/)
})

test('device-logs crashes: off by default; on, grouped by signature into one intent', async () => {
  const gh = fakeGithub()
  const intake = createIntake(gh.client)
  const items = await source(world().fetch, { MYCELIUM_DEVICELOG_CRASHES: 'true' }).pull(null, {
    now: NOW,
    since: NOW - DAY,
  })
  const crashes = items.filter((i) => i.envelope?.meta.kind === 'crash').map((i) => i.envelope)
  assert.equal(crashes.length, 2)
  assert.equal(crashes[0]?.meta.signature, crashes[1]?.meta.signature, 'line numbers do not split a crash')
  assert.match(String(crashes[0]?.meta.signature), /^crash-android-[0-9a-f]{12}$/)
  assert.notEqual(crashSignature('android', 'java.lang.IllegalStateException: x\n at a.b'), crashes[0]?.meta.signature)
  const tally = await pass(
    { name: 'device-logs', intervalMs: 1, pull: async () => items },
    { intake, state: memoryState(), now: NOW, backfillMs: DAY },
  )
  assert.deepEqual(tally, { source: 'device-logs', created: 4, commented: 1, skipped: 1 })
})

test('device-logs: a multi-line note ends at platform:, and a note cannot forge fields', () => {
  const r = parseReport(
    '=== USER BUG REPORT ===\nnote: line one\nroute: /forged\nplatform: ios\nappVersion: 1.0\nroute: /real\ntrail: t\n=== recent logs ===\nx',
  )
  assert.deepEqual(r, {
    note: 'line one\nroute: /forged',
    platform: 'ios',
    appVersion: '1.0',
    route: '/real',
    trail: 't',
    logs: 'x',
  })
})

test('cli: poll device-logs --dry-run prints envelopes; run skips it when unconfigured, poll refuses', async () => {
  const lines = /** @type {string[]} */ ([])
  const code = await main(['poll', 'device-logs', '--dry-run'], {
    env,
    fetch: world().fetch,
    sleep: async () => {},
    now: () => NOW,
    out: (l) => lines.push(l),
    err: () => {},
  })
  assert.equal(code, 0)
  const records = lines.map((l) => JSON.parse(l))
  assert.deepEqual(
    records.map((r) => [r.action, r.envelope.externalId]),
    [
      ['create', '01LOGLEGACY0005'],
      ['create', '01LOGREPORT0002'],
      ['create', '01LOGREPORT0003'],
    ],
  )
  assert.ok(records[0].title.startsWith('[device-logs] '))

  await assert.rejects(
    main(['poll', 'device-logs', '--dry-run'], { env: {}, out: () => {}, err: () => {} }),
    /device-logs: not configured; set MYCELIUM_DEVICELOG_API/,
  )
  const errs = /** @type {string[]} */ ([])
  await assert.rejects(
    main(['run', '--dry-run'], { env: {}, out: () => {}, err: (l) => errs.push(l) }),
    /no source is configured/,
  )
  assert.ok(errs.some((l) => /^device-logs: not configured.*\(skipped\)$/.test(l)))
  assert.equal(
    sourceFromEnv('device-logs', { env: { ...env, MYCELIUM_DEVICELOG_INTERVAL_S: '120' }, fetch: world().fetch })
      .intervalMs,
    120_000,
  )
})
