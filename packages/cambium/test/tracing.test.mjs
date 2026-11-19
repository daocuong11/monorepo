// @ts-check
/** cambium tracing: node/wait/issue spans, the not-ready counter, and the advance instrument hook. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SpanStatusCode } from '@opentelemetry/api'
import { marker } from '@oakgreencc/mycelium'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace'
import { z } from 'zod'
import { advance, defineGraph, defineNode, defineWait } from '@oakgreencc/cambium/graph'
import { advanceHooks, createTelemetry, otlpMetricsConfigured, traceparentFor, workerSpans } from '../src/tracing.mjs'

const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
const BASE = { graph: 'task', graphVersion: 3, attempt: 2, repo: 'o/r', issue: 7 }

async function recording(now = Date.now) {
  const exporter = new InMemorySpanExporter()
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 })
  const t = await createTelemetry({ env: {}, exporter, metricReader, now })
  const spans = async () => {
    await t.flush()
    return exporter.getFinishedSpans()
  }
  const notReadyCount = async () => {
    await t.flush()
    const points = metricExporter
      .getMetrics()
      .flatMap((rm) => rm.scopeMetrics.flatMap((s) => s.metrics))
      .filter((m) => m.descriptor.name === 'cambium.wait.not_ready')
      .flatMap((m) => m.dataPoints)
    return points.length ? Math.max(...points.map((p) => Number(p.value))) : 0
  }
  return { t, spans, notReadyCount }
}

test('no OTLP env: no-op, nodeSpan just runs, traceparents are null', async () => {
  const t = await createTelemetry({ env: {} })
  assert.equal(t.enabled, false)
  assert.equal(t.metricsEnabled, false)
  const seen = await t.nodeSpan({ ...BASE, node: 'n' }, (run) => [run.issueTraceparent, run.traceparent])
  assert.deepEqual(seen, [null, null])
  assert.equal(t.waitSpan({ ...BASE, node: 'w', enteredAt: new Date().toISOString() }), null)
  t.notReady({ node: 'w' })
  assert.equal(t.issueTrace({ ...BASE, traceparent: TP }), TP, 'a stored traceparent is kept even when off')
  await t.shutdown()
  assert.equal(otlpMetricsConfigured({}), false)
  assert.equal(otlpMetricsConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }), true)
  assert.equal(otlpMetricsConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_METRICS_EXPORTER: 'none' }), false)
  assert.equal(otlpMetricsConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_SDK_DISABLED: 'true' }), false)
})

test('nodeSpan parents on the marker traceparent and carries every attribute', async () => {
  const { t, spans } = await recording()
  const out = await t.nodeSpan({ ...BASE, node: 'start-worker', traceparent: TP }, (run) => {
    assert.equal(run.issueTraceparent, TP)
    assert.match(String(run.traceparent), /^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/)
    run.set({ edge: 2, outcome: 'started' })
    return 42
  })
  assert.equal(out, 42)
  const [s] = await spans()
  assert.equal(s.name, 'cambium.node')
  assert.equal(s.spanContext().traceId, '0af7651916cd43dd8448eb211c80319c')
  assert.equal(s.parentSpanContext?.spanId, 'b7ad6b7169203331')
  assert.deepEqual(s.attributes, {
    'cambium.graph': 'task',
    'cambium.graph.version': 3,
    'cambium.node': 'start-worker',
    'cambium.attempt': 2,
    'cambium.repo': 'o/r',
    'cambium.issue.number': 7,
    'cambium.edge': 2,
    'cambium.outcome': 'started',
  })
  assert.equal(s.resource.attributes['service.name'], 'cambium')
  await t.shutdown()
})

test('no traceparent: a root cambium.issue span is started, ended, and its traceparent handed back', async () => {
  const { t, spans } = await recording()
  let issueTp = null
  await t.nodeSpan({ ...BASE, node: 'a' }, (run) => {
    issueTp = run.issueTraceparent
  })
  const all = await spans()
  const root = all.find((s) => s.name === 'cambium.issue')
  const node = all.find((s) => s.name === 'cambium.node')
  assert.ok(root && node)
  assert.equal(root.parentSpanContext, undefined)
  assert.equal(issueTp, traceparentFor(root.spanContext()))
  assert.equal(node.parentSpanContext?.spanId, root.spanContext().spanId)
  assert.equal(node.attributes['cambium.outcome'], 'ok')
  await t.shutdown()
})

test("a new issue trace continues mycelium's intake trace from the issue body", async () => {
  const { t, spans } = await recording()
  const tp = t.issueTrace({ ...BASE, issueBody: `${marker('a1b2c3d4e5f6', TP)}\n## Intake` })
  const [root] = await spans()
  assert.equal(root.name, 'cambium.issue')
  assert.equal(root.spanContext().traceId, '0af7651916cd43dd8448eb211c80319c')
  assert.equal(root.parentSpanContext?.spanId, 'b7ad6b7169203331')
  assert.equal(tp, traceparentFor(root.spanContext()))
  await t.shutdown()
})

test('nodeSpan: a throw marks the span an error and is rethrown', async () => {
  const { t, spans } = await recording()
  await assert.rejects(
    t.nodeSpan({ ...BASE, node: 'boom', traceparent: TP }, () => {
      throw new Error('nope')
    }),
    /nope/,
  )
  const [s] = await spans()
  assert.equal(s.status.code, SpanStatusCode.ERROR)
  assert.equal(s.attributes['cambium.outcome'], 'error')
  await t.shutdown()
})

test('waitSpan starts at enteredAt and ends now; notReady counts polls', async () => {
  const clock = Date.parse('2026-11-17T12:00:00Z')
  const { t, spans, notReadyCount } = await recording(() => clock)
  t.notReady({ ...BASE, node: 'ci-running' })
  t.notReady({ ...BASE, node: 'ci-running' })
  const tp = t.waitSpan({ ...BASE, node: 'ci-running', traceparent: TP, enteredAt: '2026-11-17T11:00:00Z', polls: 2 })
  assert.equal(tp, TP)
  const [s] = await spans()
  assert.equal(s.name, 'cambium.wait')
  assert.equal(s.parentSpanContext?.spanId, 'b7ad6b7169203331')
  const ms = (/** @type {[number, number]} */ [sec, ns]) => sec * 1000 + ns / 1e6
  assert.equal(ms(s.startTime), Date.parse('2026-11-17T11:00:00Z'))
  assert.equal(ms(s.endTime), clock)
  assert.equal(s.attributes['cambium.wait.polls'], 2)
  assert.equal(await notReadyCount(), 2)
  await t.shutdown()
})

const Num = z.object({ n: z.number(), outcome: z.string().optional() })
const graph = () =>
  defineGraph({
    name: 'task',
    version: 3,
    entry: { queue: 'q:task', node: 'start' },
    nodes: [
      defineNode({
        name: 'start',
        input: Num,
        output: Num,
        run: ({ n }, ctx) => ({ n: n + 1, outcome: `tp:${ctx.traceparent ? 'yes' : 'no'}` }),
      }),
      defineWait({
        name: 'gate',
        input: Num,
        output: Num,
        poll: (input, ctx) => (ctx.open ? { ready: true, output: input } : { ready: false }),
      }),
      defineNode({ name: 'done', input: Num, output: Num, run: (x) => x }),
    ],
    edges: [
      ['start', 'gate'],
      ['gate', 'done'],
    ],
  })

test('advanceHooks: traces an advance; the worker node sees ctx.traceparent; the root traceparent is kept', async () => {
  const { t, spans, notReadyCount } = await recording()
  const hooks = advanceHooks(t, { ...BASE, traceparent: null, enteredAt: null })
  const r1 = await advance(
    graph(),
    { node: 'start', input: { n: 1 } },
    { open: false },
    { instrument: hooks.instrument },
  )
  assert.equal(r1.reason, 'waiting')
  assert.equal(r1.transitions[0].output.outcome, 'tp:yes')
  assert.equal(await notReadyCount(), 1)
  const stored = hooks.traceparent
  assert.ok(stored)

  const enteredAt = '2026-11-17T10:00:00Z'
  const hooks2 = advanceHooks(t, { ...BASE, traceparent: stored, enteredAt })
  const r2 = await advance(
    graph(),
    { node: 'gate', input: r1.input },
    { open: true },
    { instrument: hooks2.instrument },
  )
  assert.equal(r2.reason, 'end')
  assert.equal(hooks2.traceparent, stored)

  const all = await spans()
  assert.deepEqual(
    all.map((s) => s.name),
    ['cambium.issue', 'cambium.node', 'cambium.wait', 'cambium.node'],
  )
  const traceIds = new Set(all.map((s) => s.spanContext().traceId))
  assert.equal(traceIds.size, 1, 'one trace per issue across ticks')
  const [, start, wait, done] = all
  assert.equal(start.attributes['cambium.edge'], 0)
  assert.equal(start.attributes['cambium.outcome'], 'tp:yes')
  assert.equal(wait.attributes['cambium.node'], 'gate')
  assert.equal(wait.attributes['cambium.outcome'], 'ready')
  assert.equal(wait.startTime[0] * 1000, Date.parse(enteredAt))
  assert.equal(done.attributes['cambium.edge'], undefined, 'a terminal node has no edge')
  await t.shutdown()
})

const STREAM = readFileSync(new URL('./fixtures/worker-stream.jsonl', import.meta.url), 'utf8')

test('workerSpans: session, tool and task spans from a stream-json log', async () => {
  const { t, spans } = await recording()
  const s = workerSpans(STREAM, { tracer: t.tracer, parent: TP })
  assert.equal(s.complete, true)
  assert.equal(s.ok, true)
  assert.equal(s.malformed, 1, 'the trailing truncated line is skipped')
  assert.equal(s.tasks, 1)
  const all = await spans()
  const session = all.find((x) => x.name === 'claude.session')
  assert.ok(session)
  assert.equal(session.parentSpanContext?.spanId, 'b7ad6b7169203331')
  assert.equal(session.status.code, SpanStatusCode.UNSET)
  assert.equal(session.attributes['claude.model'], 'claude-opus-5-5')
  assert.equal(session.attributes['claude_code.version'], '2.1.327')
  assert.equal(session.attributes['claude.terminal_reason'], 'completed')
  assert.equal(typeof session.attributes['claude.cost_usd'], 'number')
  assert.equal(typeof session.attributes['claude.tokens.output'], 'number')
  assert.equal(session.attributes['claude.session_id'], s.sessionId)
  const ms = (/** @type {[number, number]} */ [sec, ns]) => sec * 1000 + Math.round(ns / 1e6)
  assert.equal(ms(session.startTime), s.start)
  assert.equal(ms(session.endTime), s.end)

  const tools = all.filter((x) => x.name === 'claude.tool')
  assert.equal(tools.length, s.tools)
  for (const tool of tools) {
    assert.equal(tool.parentSpanContext?.spanId, session.spanContext().spanId)
    assert.equal(tool.attributes['claude.tool.name'], 'Bash')
    assert.equal(tool.attributes['claude.tool.outcome'], 'ok')
    assert.ok(String(tool.attributes['claude.tool.command']).length <= 200)
  }
  const task = all.find((x) => x.name === 'claude.task')
  assert.ok(task)
  assert.equal(task.attributes['claude.task.status'], 'completed')
  assert.ok(
    tools.some((x) => x.spanContext().spanId === task.parentSpanContext?.spanId),
    'a task nests under its tool',
  )
  await t.shutdown()
})

test('workerSpans: a killed worker (no result, unpaired tool) ends at the last timestamp with ERROR', async () => {
  const { t, spans } = await recording()
  const lines = STREAM.split('\n').filter((l) => !l.includes('"type": "result"'))
  const lastTool = lines.findLastIndex((l) => l.includes('"tool_result"'))
  lines.splice(lastTool, 1)
  const s = t.workerSpans(lines)
  assert.equal(s.complete, false)
  assert.equal(s.ok, false)
  const all = await spans()
  const session = all.find((x) => x.name === 'claude.session')
  assert.equal(session?.status.code, SpanStatusCode.ERROR)
  assert.equal(session?.parentSpanContext, undefined, 'no parent → a root span')
  const unfinished = all.filter((x) => x.attributes['claude.tool.outcome'] === 'unfinished')
  assert.equal(unfinished.length, 1)
  assert.equal(unfinished[0].status.code, SpanStatusCode.ERROR)
  assert.deepEqual(unfinished[0].endTime, session?.endTime)
  await t.shutdown()
})

test('workerSpans: a turn span per assistant message that thinks or says something', async () => {
  const { t, spans } = await recording()
  const at = (/** @type {number} */ s) => `2026-11-18T10:00:${String(s).padStart(2, '0')}.000Z`
  const said = (/** @type {number} */ s, /** @type {string} */ id, /** @type {any[]} */ content, parent = null) => ({
    type: 'assistant',
    timestamp: at(s),
    parent_tool_use_id: parent,
    message: { id, content },
  })
  const result = (/** @type {number} */ s, /** @type {string} */ id) => ({
    type: 'user',
    timestamp: at(s),
    message: { content: [{ type: 'tool_result', tool_use_id: id }] },
  })
  const s = workerSpans(
    [
      { type: 'system', subtype: 'init', session_id: 's', timestamp: at(0) },
      said(2, 'm1', [{ type: 'thinking', thinking: 'Read the issue first.', signature: 'x' }]),
      said(3, 'm1', [{ type: 'text', text: 'Reading it.' }]),
      said(4, 'm1', [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: {} }]),
      said(6, 'm2', [{ type: 'thinking', thinking: 'Sub: grep it.' }], 'tu1'),
      said(7, 'm2', [{ type: 'tool_use', id: 'tu2', name: 'Grep', input: {} }], 'tu1'),
      result(8, 'tu2'),
      result(9, 'tu1'),
      said(10, 'm3', [{ type: 'thinking', thinking: '', signature: 'redacted' }]),
      said(11, 'm3', [{ type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'ls' } }]),
      result(12, 'tu3'),
      { type: 'result', timestamp: at(13), subtype: 'success', is_error: false, session_id: 's' },
    ],
    { tracer: t.tracer, parent: TP },
  )
  assert.equal(s.turns, 2, 'a message with only redacted thinking and a tool call is no turn')
  const all = await spans()
  const turns = all.filter((x) => x.name === 'claude.turn')
  assert.equal(turns.length, 2)
  const [top, sub] = turns.sort((a, b) => a.startTime[0] - b.startTime[0])
  assert.equal(top.attributes['claude.thinking'], 'Read the issue first.')
  assert.equal(top.attributes['claude.text'], 'Reading it.')
  assert.equal(top.attributes['claude.turn.tools'], 'Agent')
  assert.equal(top.startTime[0] * 1000, Date.parse(at(0)), 'from the event before the message')
  assert.equal(top.endTime[0] * 1000, Date.parse(at(4)), 'to its last event')
  const session = all.find((x) => x.name === 'claude.session')
  assert.equal(top.parentSpanContext?.spanId, session?.spanContext().spanId)
  const agent = all.find((x) => x.attributes['claude.tool.name'] === 'Agent')
  assert.equal(sub.parentSpanContext?.spanId, agent?.spanContext().spanId, "a subagent's turn nests under its tool")
  assert.equal(sub.attributes['claude.text'], undefined)
  await t.shutdown()
})

test('workerSpans: garbage and empty logs emit nothing', async () => {
  const { t, spans } = await recording()
  assert.equal(workerSpans('', { tracer: t.tracer }).complete, false)
  assert.equal(workerSpans('not json\n{"type":"system","subtype":"init"}\n42\n', { tracer: t.tracer }).malformed, 2)
  assert.deepEqual(await spans(), [])
  await t.shutdown()
})

test('advance without instrument is unchanged; an instrument sees every visit', async () => {
  /** @type {string[]} */
  const visits = []
  const r = await advance(
    graph(),
    { node: 'start', input: { n: 1 } },
    { open: true },
    {
      instrument: async (v, step) => {
        visits.push(`${v.kind}:${v.node}`)
        return step()
      },
    },
  )
  assert.equal(r.reason, 'end')
  assert.deepEqual(visits, ['node:start', 'wait:gate', 'node:done'])
  const plain = await advance(graph(), { node: 'start', input: { n: 1 } }, { open: true })
  assert.deepEqual(
    plain.transitions.map((x) => x.edge),
    r.transitions.map((x) => x.edge),
  )
  assert.equal(plain.transitions[0].output.outcome, 'tp:no')
})
