// @ts-check
/**
 * Graph runs traced end to end (engine "graph"): one issue from mycelium's intake span through triage, the hand-off
 * to q:task and a task worker, as one trace across ticks; the issue trace kept in the marker; workers given
 * TRACEPARENT and their stream-json spans parented on the step that started them. Off by default: nothing changes.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { marker as intakeMarker } from '@oakgreencc/mycelium'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace'
import { runDaemon } from '../src/daemon.mjs'
import { tick } from '../src/tick.mjs'
import { createTelemetry } from '../src/tracing.mjs'
import { harness, SLUG } from './fakes.mjs'

const MIN = 60_000
const INTAKE_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const INTAKE_SPAN = '00f067aa0ba902b7'
const INTAKE_TP = `00-${INTAKE_TRACE}-${INTAKE_SPAN}-01`
const WORKER_LOG = readFileSync(new URL('./fixtures/worker-stream.jsonl', import.meta.url), 'utf8')

/** A triage worker's stdout: an actionable verdict (stream-json events carry timestamps). */
const ACTIONABLE = [
  { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5' },
  {
    type: 'assistant',
    timestamp: '2026-11-16T12:01:00.000Z',
    message: { content: [{ type: 'text', text: 'Looking.' }] },
  },
  {
    type: 'result',
    timestamp: '2026-11-16T12:04:00.000Z',
    subtype: 'success',
    is_error: false,
    session_id: 's1',
    result: `Read it.\n\n\`\`\`json\n${JSON.stringify({ verdict: 'actionable', reason: 'Small.', title: 'Do it', acceptance: ['It is done'] })}\n\`\`\`\n`,
  },
]
  .map((e) => JSON.stringify(e))
  .join('\n')

/** @param {ReturnType<typeof harness>} h */
async function traced(h) {
  const exporter = new InMemorySpanExporter()
  const telemetry = await createTelemetry({ env: {}, exporter, now: () => h.clock.now() })
  h.deps.telemetry = telemetry
  return async () => {
    await telemetry.flush()
    return exporter.getFinishedSpans()
  }
}

/** @param {ReturnType<typeof harness>} h @param {number} n */
async function endWorker(h, n, log = '') {
  const w = h.deps.store.worker(SLUG, n)
  assert.ok(w, `a worker is tracked for #${n}`)
  h.spawner.logs.set(w.stdout, log)
  h.procs.live.delete(w.pid)
  return w
}

const tpParts = (/** @type {string | null | undefined} */ tp) => (tp ?? '').split('-')

test('intake → triage → q:task → task worker → PR: one trace, continued from the intake span', async () => {
  const h = harness({
    issues: [
      { number: 7, labels: ['q:intake'], body: `${intakeMarker('0123abcd', INTAKE_TP)}\nMake the tick faster.` },
    ],
    config: { engine: 'graph', phases: { dispatch: { cap: 1 }, task: { cap: 0 } } },
  })
  const spans = await traced(h)

  // Tick 1: start-triage. A cambium.issue root under the intake span; the triage worker runs under its node span.
  await tick(h.deps)
  const triage = h.spawner.started[0]
  assert.equal(triage.phase, 'dispatch')
  const [, triageTrace, triageSpan] = tpParts(triage.env?.TRACEPARENT)
  assert.equal(triageTrace, INTAKE_TRACE, 'the triage worker continues the intake trace')
  assert.equal(h.deps.store.worker(SLUG, 7)?.traceparent, triage.env?.TRACEPARENT)
  const issueTp = h.gh.marker(7)?.traceparent
  assert.equal(tpParts(issueTp)[1], INTAKE_TRACE, 'the marker keeps the issue trace')

  // Tick 2: the verdict, five minutes on. triaging ends (a wait span from enteredAt), to-task hands it to q:task.
  h.clock.advance(5 * MIN)
  await endWorker(h, 7, ACTIONABLE)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels, ['q:task'])
  assert.equal(h.gh.marker(7)?.graph, 'task')
  assert.equal(h.gh.marker(7)?.traceparent, issueTp, 'the hand-off keeps the trace')

  // Tick 3: the task graph schedules it; the task worker runs under start-worker, in the same trace.
  h.deps.config.phases.task.cap = 1
  await tick(h.deps)
  const work = h.spawner.started.find((s) => s.phase === 'task')
  assert.ok(work)
  const [, workTrace, workSpan] = tpParts(work.env?.TRACEPARENT)
  assert.equal(workTrace, INTAKE_TRACE)

  // Tick 4: the worker exits with a PR, twenty minutes on: worker-running ends, its claude.* spans go under start-worker.
  h.clock.advance(20 * MIN)
  await endWorker(h, 7, WORKER_LOG)
  h.gh.addPr({ number: 70, closes: [7] })
  await tick(h.deps)
  assert.equal(h.gh.marker(7)?.node, 'submit')
  assert.equal(h.gh.marker(7)?.traceparent, issueTp)

  const all = await spans()
  assert.ok(
    all.every((s) => s.spanContext().traceId === INTAKE_TRACE),
    'every span is in the intake trace',
  )
  const roots = all.filter((s) => s.name === 'cambium.issue')
  assert.equal(roots.length, 1, 'the issue root is started once, then reused from the marker')
  assert.equal(roots[0].parentSpanContext?.spanId, INTAKE_SPAN)
  const rootId = roots[0].spanContext().spanId
  const byNode = (/** @type {string} */ name, /** @type {string} */ node) =>
    all.filter((s) => s.name === name && s.attributes['cambium.node'] === node)

  const [startTriage] = byNode('cambium.node', 'start-triage')
  assert.equal(startTriage.spanContext().spanId, triageSpan, 'TRACEPARENT is the start-triage span')
  assert.equal(startTriage.attributes['cambium.graph'], 'dispatch')
  const [waitTriage] = byNode('cambium.wait', 'triaging')
  assert.equal(waitTriage.parentSpanContext?.spanId, rootId)
  assert.equal(
    waitTriage.endTime[0] - waitTriage.startTime[0],
    5 * 60,
    'the triaging wait spans the five minutes from enteredAt',
  )
  assert.equal(byNode('cambium.node', 'to-task').length, 1)

  const [startWorker] = byNode('cambium.node', 'start-worker')
  assert.equal(startWorker.spanContext().spanId, workSpan, 'TRACEPARENT is the start-worker span')
  assert.equal(startWorker.attributes['cambium.graph'], 'task')
  assert.equal(startWorker.parentSpanContext?.spanId, rootId)
  const [waitWorker] = byNode('cambium.wait', 'worker-running')
  assert.equal(waitWorker.endTime[0] - waitWorker.startTime[0], 20 * 60)

  const sessions = all.filter((s) => s.name === 'claude.session')
  assert.equal(sessions.length, 2, 'one session per worker')
  const session = sessions.find((s) => s.parentSpanContext?.spanId === workSpan)
  assert.ok(session, "the task worker's stream-json became spans, under the start-worker span")
  assert.ok(all.some((s) => s.name === 'claude.tool' && s.spanContext().traceId === INTAKE_TRACE))
  const triageSession = all.filter((s) => s.name === 'claude.session' && s.parentSpanContext?.spanId === triageSpan)
  assert.equal(triageSession.length, 1, "the triage worker's session is under start-triage")
})

test('a fresh q:task issue starts its own root; a requeue keeps the trace; the next attempt joins it', async () => {
  const h = harness({ issues: [{ number: 3, labels: ['q:task'] }], config: { engine: 'graph' } })
  const spans = await traced(h)
  await tick(h.deps)
  const tp = h.gh.marker(3)?.traceparent
  assert.ok(tp)
  await endWorker(h, 3) // no PR: failed → requeue
  await tick(h.deps)
  assert.equal(h.gh.marker(3)?.traceparent, tp)
  await tick(h.deps) // attempt 2
  assert.equal(h.gh.marker(3)?.attempt, 2)
  const all = await spans()
  const trace = tpParts(tp)[1]
  assert.ok(all.every((s) => s.spanContext().traceId === trace))
  assert.equal(all.filter((s) => s.name === 'cambium.issue').length, 1)
  assert.deepEqual(
    all
      .filter((s) => s.name === 'cambium.node' && s.attributes['cambium.node'] === 'start-worker')
      .map((s) => s.attributes['cambium.attempt']),
    [1, 2],
  )
  assert.equal(all.filter((s) => s.name === 'claude.session').length, 0, 'an empty log makes no worker spans')
})

test('tracing off (no telemetry, or no OTLP config): no traceparent anywhere, no TRACEPARENT', async () => {
  for (const telemetry of [undefined, await createTelemetry({ env: {} })]) {
    const h = harness({ issues: [{ number: 3, labels: ['q:task'] }], config: { engine: 'graph' } })
    h.deps.telemetry = telemetry
    await tick(h.deps)
    assert.equal(h.gh.marker(3)?.traceparent, null)
    assert.equal(h.spawner.started[0].env, undefined)
    assert.equal(h.deps.store.worker(SLUG, 3)?.traceparent, null)
  }
})

test('the daemon flushes telemetry after every tick, and a failing flush is only a warning', async () => {
  const h = harness({ issues: [], config: { engine: 'graph' } })
  let flushes = 0
  h.deps.telemetry = /** @type {any} */ ({
    enabled: false,
    flush: async () => {
      flushes++
      if (flushes === 2) throw new Error('collector down')
    },
  })
  let ticks = 0
  const ac = new AbortController()
  await runDaemon(h.deps, {
    signal: ac.signal,
    wait: async () => {
      if (++ticks === 2) ac.abort()
    },
  })
  assert.equal(flushes, 2)
  assert.ok(h.events.some((e) => e.level === 'warn' && /telemetry flush: collector down/.test(e.msg)))
})
