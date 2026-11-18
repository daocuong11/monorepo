// @ts-check
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SpanStatusCode } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace'
import { main } from '../src/cli.mjs'
import { envelope, fingerprint } from '../src/envelope.mjs'
import * as entry from '../src/index.mjs'
import { createIntake, fingerprintOf, issueBody, marker, parseTraceparent } from '../src/intake.mjs'
import { createTracing, NO_TRACING, otlpConfigured } from '../src/telemetry.mjs'
import { fakeFetch, fakeGithub, fixture } from './helpers.mjs'

const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
const FP = 'a1b2c3d4e5f6a1b2c3d4e5f6'

const review = (/** @type {string} */ id, over = {}) =>
  envelope({
    source: 'asc',
    externalId: id,
    receivedAt: '2026-11-01T12:00:00Z',
    author: 'someone',
    title: 'Crash',
    body: 'It crashes.',
    meta: { appId: '1', rating: 1 },
    ...over,
  })

/** An in-memory exporter behind the real (batching) provider. */
async function recording() {
  const exporter = new InMemorySpanExporter()
  const tracing = await createTracing({ exporter })
  const spans = async () => {
    await tracing.flush()
    return exporter.getFinishedSpans()
  }
  return { exporter, tracing, spans }
}

test('marker: old bodies (no traceparent) and new ones both parse', () => {
  const old = `${marker(FP)}\n## Intake`
  const traced = `${marker(FP, TP)}\n## Intake`
  assert.equal(traced.split('\n')[0], `<!-- mycelium:fingerprint=${FP} traceparent=${TP} -->`)
  assert.equal(fingerprintOf(old), FP)
  assert.equal(fingerprintOf(traced), FP)
  assert.equal(parseTraceparent(old), null)
  assert.deepEqual(parseTraceparent(traced), {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    traceFlags: 1,
    isRemote: true,
    traceparent: TP,
  })
})

test('parseTraceparent: only the first line counts; malformed or zero ids are null, the fingerprint survives', () => {
  assert.equal(parseTraceparent(`text\n${marker(FP, TP)}`), null)
  assert.equal(parseTraceparent(null), null)
  const bad = `<!-- mycelium:fingerprint=${FP} traceparent=00-zz -->\n`
  assert.equal(parseTraceparent(bad), null)
  assert.equal(fingerprintOf(bad), FP)
  assert.equal(parseTraceparent(marker(FP, `00-${'0'.repeat(32)}-b7ad6b7169203331-01`)), null)
  assert.equal(entry.parseTraceparent, parseTraceparent)
})

test('no OTLP endpoint: no-op tracing, the SDK is not loaded, and the marker has no traceparent', async () => {
  assert.equal(otlpConfigured({}), false)
  assert.equal(otlpConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }), true)
  assert.equal(otlpConfigured({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://c:4318/v1/traces' }), true)
  assert.equal(otlpConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_SDK_DISABLED: 'true' }), false)
  assert.equal(otlpConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_TRACES_EXPORTER: 'none' }), false)
  assert.equal(await createTracing({ env: {} }), NO_TRACING)

  const gh = fakeGithub()
  const intake = createIntake(gh.client)
  const e = review('R1')
  await intake.apply(await intake.plan(e))
  assert.equal(gh.state.issues[0].body.split('\n')[0], marker(fingerprint(e)))
})

test('create: one mycelium.intake root span; its traceparent is on the body first line; issue number set after create', async () => {
  const { tracing, spans } = await recording()
  const gh = fakeGithub()
  const intake = createIntake(gh.client, { tracer: tracing.tracer })
  const e = review('R1')
  const fp = fingerprint(e)
  const done = await intake.apply(await intake.plan(e))
  const [span, ...rest] = await spans()
  assert.equal(rest.length, 0)
  assert.equal(span.name, 'mycelium.intake')
  assert.equal(span.parentSpanContext, undefined)
  assert.equal(span.resource.attributes['service.name'], 'mycelium')
  assert.deepEqual(span.attributes, {
    'mycelium.source': 'asc',
    'mycelium.external_id': 'R1',
    'mycelium.fingerprint': fp,
    'mycelium.action': 'create',
    'mycelium.issue.number': done.issue,
  })
  const body = gh.state.issues[0].body
  const sc = span.spanContext()
  assert.equal(body.split('\n')[0], marker(fp, `00-${sc.traceId}-${sc.spanId}-01`))
  assert.equal(fingerprintOf(body), fp)
  assert.equal(parseTraceparent(body)?.spanId, sc.spanId)
  assert.ok(body.slice(body.indexOf('\n')).startsWith('\n## Intake\n'))
  await tracing.shutdown()
})

test('duplicate: the comment span starts its own trace with a link to the issue traceparent', async () => {
  const { tracing, spans } = await recording()
  const e = review('R1')
  const fp = fingerprint(e)
  const filed = issueBody(e, fp).replace(marker(fp), marker(fp, TP))
  const gh = fakeGithub([{ number: 7, body: filed }])
  const intake = createIntake(gh.client, { tracer: tracing.tracer })
  await intake.apply(await intake.plan(review('R1', { body: 'again' })))
  const [span] = await spans()
  assert.equal(span.parentSpanContext, undefined)
  assert.notEqual(span.spanContext().traceId, '0af7651916cd43dd8448eb211c80319c')
  assert.equal(span.links.length, 1)
  assert.equal(span.links[0].context.traceId, '0af7651916cd43dd8448eb211c80319c')
  assert.equal(span.links[0].context.spanId, 'b7ad6b7169203331')
  assert.equal(span.attributes['mycelium.action'], 'comment')
  assert.equal(span.attributes['mycelium.issue.number'], 7)
  await tracing.shutdown()
})

test('duplicate of an old (untraced) issue: no link; duplicate within a pass links to the span that filed it', async () => {
  const { tracing, spans } = await recording()
  const e = review('R1')
  const gh = fakeGithub([{ number: 7, body: issueBody(e, fingerprint(e)) }])
  const intake = createIntake(gh.client, { tracer: tracing.tracer })
  await intake.apply(await intake.plan(review('R1', { body: 'again' })))
  for (const x of [review('R2'), review('R2', { body: 'again' })]) await intake.apply(await intake.plan(x))
  const [old, created, comment] = await spans()
  assert.equal(old.links.length, 0)
  assert.equal(comment.links[0].context.spanId, created.spanContext().spanId)
  assert.notEqual(comment.spanContext().traceId, created.spanContext().traceId)
  await tracing.shutdown()
})

test('a failed write still ends its span, with an error status', async () => {
  const { tracing, spans } = await recording()
  const gh = fakeGithub()
  gh.client.createIssue = async () => {
    throw new Error('graft api: 502')
  }
  const intake = createIntake(gh.client, { tracer: tracing.tracer })
  await assert.rejects(intake.apply(await intake.plan(review('R1'))), /502/)
  const [span] = await spans()
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.equal(span.attributes['mycelium.issue.number'], undefined)
  await tracing.shutdown()
})

const pem = /** @type {string} */ (
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' })
)
const ascEnv = {
  MYCELIUM_ASC_KEY_ID: 'K',
  MYCELIUM_ASC_ISSUER_ID: 'I',
  MYCELIUM_ASC_KEY_P8: pem,
  MYCELIUM_ASC_APP_ID: '1000000001',
  MYCELIUM_BACKFILL_HOURS: '48',
}
const pages = fixture('asc-reviews.json')
const ascFetch = () => fakeFetch((url) => (url.includes('cursor=PAGE2') ? pages.page2 : pages.page1)).fetch

test('cli: batched spans are flushed before main returns; --dry-run exports nothing', async (t) => {
  const exporter = new InMemorySpanExporter()
  exporter.shutdown = async () => {} // keep what was exported past the provider's shutdown
  const tracing = await createTracing({ exporter })
  const gh = fakeGithub()
  const dir = mkdtempSync(join(tmpdir(), 'mycelium-'))
  t.after(() => rmSync(dir, { recursive: true }))
  const now = () => Date.parse('2026-11-01T20:00:00Z')
  const quiet = { out: () => {}, err: () => {} }
  const env = { ...ascEnv, MYCELIUM_STATE: join(dir, 'state.json') }
  assert.equal(await main(['poll', 'asc'], { env, fetch: ascFetch(), github: gh.client, tracing, now, ...quiet }), 0)
  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, gh.state.issues.length)
  assert.ok(spans.length > 0)

  const dry = new InMemorySpanExporter()
  dry.shutdown = async () => {}
  const dryTracing = await createTracing({ exporter: dry })
  await main(['poll', 'asc', '--dry-run'], { env, fetch: ascFetch(), tracing: dryTracing, now, ...quiet })
  await dryTracing.shutdown()
  assert.equal(dry.getFinishedSpans().length, 0)
})
