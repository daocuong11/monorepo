// @ts-check
/**
 * OpenTelemetry for cambium: `cambium.node` spans per step-node run,
 * `cambium.wait` spans per wait period (emitted when it ends), a root
 * `cambium.issue` span per issue trace, and a `cambium.wait.not_ready` counter.
 *
 * Configured only by the standard `OTEL_*` env vars, with mycelium's on/off
 * rule (its `createTracing` is reused with `service.name=cambium`): no OTLP
 * endpoint, `OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` → no-op,
 * and the SDK is never imported. Metrics follow the same rule for their own
 * signal (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_METRICS_EXPORTER`).
 *
 * No span stays open across ticks: the issue root is ended as soon as it is
 * started (its traceparent, stored in the marker, is what later ticks parent
 * on), and a wait span is created only once the wait is over, back-dated to
 * the marker's `enteredAt`.
 */
import { metrics, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api'
import {
  createTracing,
  formatTraceparent,
  NO_TRACING,
  otlpConfigured,
  parseTraceparent,
  spanContextOf,
} from '@oakgreencc/mycelium'

export const SERVICE_NAME = 'cambium'

/**
 * @typedef {import('@opentelemetry/api').Span} Span
 * @typedef {import('@opentelemetry/api').SpanContext} SpanContext
 * @typedef {import('@opentelemetry/api').Counter} Counter
 * @typedef {{
 *   graph?: string, graphVersion?: number, node?: string, attempt?: number,
 *   repo?: string, issue?: number, edge?: number | string | null, outcome?: string,
 * }} NodeAttrs
 * @typedef {NodeAttrs & {
 *   traceparent?: string | null,
 *   issueBody?: string | null,
 * }} TraceInfo
 *   `traceparent` is the marker's; `issueBody` lets a new issue trace continue mycelium's intake trace.
 * @typedef {{
 *   span: Span,
 *   issueTraceparent: string | null,
 *   traceparent: string | null,
 *   set: (attrs: NodeAttrs) => void,
 * }} NodeRun
 *   `issueTraceparent` is what the marker should hold (new when a root was started); `traceparent` is this
 *   span's, for a worker's `TRACEPARENT`.
 */

/** W3C `traceparent` of a span context, or null for an invalid (no-op) one. @param {SpanContext | undefined} sc */
export const traceparentFor = (sc) => (sc ? formatTraceparent(sc) : null)

/** @param {NodeAttrs} a */
function attributes(a) {
  /** @type {Record<string, string | number>} */
  const out = {}
  const put = (/** @type {string} */ k, /** @type {unknown} */ v) => {
    if (v !== undefined && v !== null) out[k] = /** @type {string | number} */ (v)
  }
  put('cambium.graph', a.graph)
  put('cambium.graph.version', a.graphVersion)
  put('cambium.node', a.node)
  put('cambium.attempt', a.attempt)
  put('cambium.repo', a.repo)
  put('cambium.issue.number', a.issue)
  put('cambium.edge', a.edge)
  put('cambium.outcome', a.outcome)
  return out
}

/** Metrics on/off for the metrics signal, mirroring mycelium's traces rule. @param {Record<string, string | undefined>} env */
export function otlpMetricsConfigured(env) {
  if (
    String(env.OTEL_SDK_DISABLED ?? '')
      .trim()
      .toLowerCase() === 'true'
  )
    return false
  const exporters = String(env.OTEL_METRICS_EXPORTER ?? 'otlp')
    .split(',')
    .map((s) => s.trim().toLowerCase())
  if (exporters.includes('none')) return false
  return Boolean(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT)
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   exporter?: import('@opentelemetry/sdk-trace').SpanExporter,
 *   metricReader?: import('@opentelemetry/sdk-metrics').MetricReader,
 * }} [opts]
 */
async function createMeter({ env = process.env, metricReader } = {}) {
  if (!metricReader && !otlpMetricsConfigured(env)) return null
  const [sdk, res] = await Promise.all([import('@opentelemetry/sdk-metrics'), import('@opentelemetry/resources')])
  const reader =
    metricReader ??
    new sdk.PeriodicExportingMetricReader({
      exporter: new (await import('@opentelemetry/exporter-metrics-otlp-http')).OTLPMetricExporter(),
    })
  const resource = res
    .defaultResource()
    .merge(res.resourceFromAttributes({ 'service.name': SERVICE_NAME }))
    .merge(res.detectResources({ detectors: [res.envDetector] }))
  const provider = new sdk.MeterProvider({ resource, readers: [reader] })
  return { provider, meter: provider.getMeter(SERVICE_NAME) }
}

/**
 * cambium's telemetry. Without OTLP config (and no injected exporter/reader) everything is a no-op that costs a
 * function call: `nodeSpan` just runs `fn`, traceparents are null, so nothing is written to the marker.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   exporter?: import('@opentelemetry/sdk-trace').SpanExporter,
 *   metricReader?: import('@opentelemetry/sdk-metrics').MetricReader,
 *   now?: () => number,
 * }} [opts]
 */
export async function createTelemetry(opts = {}) {
  const env = opts.env ?? process.env
  const [tracing, metered] = await Promise.all([
    opts.exporter || otlpConfigured(env)
      ? createTracing({ env, exporter: opts.exporter, serviceName: SERVICE_NAME })
      : NO_TRACING,
    createMeter({ ...opts, env }),
  ])
  const { tracer } = tracing
  const now = opts.now ?? Date.now
  /** @type {Counter} */
  const notReadyCounter = (metered?.meter ?? metrics.getMeter('noop')).createCounter('cambium.wait.not_ready', {
    description: 'Polls of a wait node that found it not ready',
  })

  /**
   * The context to parent on: the marker's traceparent; failing that a new `cambium.issue` root (a child of the
   * intake trace when the issue body carries mycelium's traceparent), ended at once.
   * @param {TraceInfo} info
   */
  function issueTrace(info) {
    const known = spanContextOf(info.traceparent)
    if (known) return { parent: trace.setSpanContext(ROOT_CONTEXT, known), traceparent: known.traceparent }
    const intake = parseTraceparent(info.issueBody)
    const root = tracer.startSpan(
      'cambium.issue',
      {
        root: !intake,
        attributes: attributes({ graph: info.graph, repo: info.repo, issue: info.issue }),
        startTime: now(),
      },
      intake ? trace.setSpanContext(ROOT_CONTEXT, intake) : ROOT_CONTEXT,
    )
    root.end()
    const traceparent = traceparentFor(root.spanContext())
    return { parent: trace.setSpan(ROOT_CONTEXT, root), traceparent }
  }

  /**
   * One `cambium.node` span around a step-node run. `fn` gets the span, the issue traceparent the marker should
   * hold, and this span's traceparent (pass it to a worker as `TRACEPARENT`); `run.set({ edge, outcome })` adds
   * attributes known only after the run. A throw marks the span an error (outcome `error`) and is rethrown.
   *
   * @template T
   * @param {TraceInfo} info
   * @param {(run: NodeRun) => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function nodeSpan(info, fn) {
    const { parent, traceparent: issueTraceparent } = issueTrace(info)
    const span = tracer.startSpan('cambium.node', { attributes: attributes(info), startTime: now() }, parent)
    let outcome = info.outcome !== undefined
    /** @type {NodeRun} */
    const run = {
      span,
      issueTraceparent,
      traceparent: traceparentFor(span.spanContext()),
      set: (a) => {
        if (a.outcome !== undefined) outcome = true
        span.setAttributes(attributes(a))
      },
    }
    try {
      const out = await fn(run)
      if (!outcome) span.setAttribute('cambium.outcome', 'ok')
      return out
    } catch (err) {
      span.recordException(/** @type {Error} */ (err))
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(/** @type {any} */ (err)?.message ?? err) })
      span.setAttribute('cambium.outcome', 'error')
      throw err
    } finally {
      span.end(now())
    }
  }

  /**
   * A `cambium.wait` span for a wait period that just ended: `startTime` = `enteredAt` (the marker's), end = now.
   * Returns the issue traceparent (non-null and new when a root had to be started).
   *
   * @param {TraceInfo & { enteredAt?: string | number | Date | null, polls?: number }} info
   */
  function waitSpan(info) {
    const { parent, traceparent } = issueTrace(info)
    const end = now()
    const start = info.enteredAt == null ? end : new Date(info.enteredAt).getTime()
    const span = tracer.startSpan(
      'cambium.wait',
      { attributes: attributes(info), startTime: Number.isNaN(start) ? end : Math.min(start, end) },
      parent,
    )
    if (info.polls !== undefined) span.setAttribute('cambium.wait.polls', info.polls)
    span.end(end)
    return traceparent
  }

  /** A wait was polled and is not ready. @param {NodeAttrs} [info] */
  const notReady = (info = {}) =>
    notReadyCounter.add(1, attributes({ graph: info.graph, node: info.node, repo: info.repo }))

  return {
    enabled: tracing.enabled,
    metricsEnabled: Boolean(metered),
    tracer,
    issueTrace: (/** @type {TraceInfo} */ info) => issueTrace(info).traceparent,
    nodeSpan,
    waitSpan,
    notReady,
    traceparentFor,
    /** {@link workerSpans} with this tracer. @param {Parameters<typeof workerSpans>[0]} stream @param {string | null} [parent] */
    workerSpans: (stream, parent) => workerSpans(stream, { tracer, parent }),
    now,
    /** Exports what is queued now. */
    flush: async () => {
      await Promise.all([tracing.flush(), metered?.provider.forceFlush()])
    },
    /** Flushes, then stops; call it in a `finally`. Safe to call twice. */
    shutdown: async () => {
      await Promise.all([tracing.shutdown(), metered?.provider.shutdown().catch(() => {})])
    },
  }
}

/**
 * @typedef {Awaited<ReturnType<typeof createTelemetry>>} Telemetry
 */

/**
 * An `advance` `instrument` hook (see `graph/advance.mjs`) that traces one advance from a marker position: step
 * nodes run inside `nodeSpan` (and get `ctx.traceparent` for a worker's `TRACEPARENT`), a ready wait emits its
 * `waitSpan` (from `enteredAt` for the first node, else from when the previous transition landed), a not-ready
 * wait bumps the counter. `hooks.traceparent` is the issue traceparent to store in the marker afterwards.
 *
 * @param {Telemetry} telemetry
 * @param {TraceInfo & { enteredAt?: string | null }} base the marker's graph, graphVersion, attempt, traceparent,
 *   enteredAt, plus repo, issue and optionally the issue body
 */
export function advanceHooks(telemetry, base) {
  let traceparent = base.traceparent ?? null
  /** @type {string | number | null | undefined} */
  let enteredAt = base.enteredAt
  /** @type {import('./graph/advance.mjs').Instrument} */
  const instrument = async (visit, step) => {
    const info = { ...base, traceparent, node: visit.node }
    if (visit.kind === 'wait') {
      const res = await step()
      if (!res) telemetry.notReady(info)
      else {
        traceparent = telemetry.waitSpan({ ...info, enteredAt, edge: res.edge, outcome: 'ready' }) ?? traceparent
        enteredAt = telemetry.now()
      }
      return res
    }
    const res = await telemetry.nodeSpan(info, async (run) => {
      traceparent = run.issueTraceparent ?? traceparent
      const t = await step({ traceparent: run.traceparent })
      run.set({ edge: t?.edge ?? null, outcome: outcomeOf(t?.output) })
      return t
    })
    enteredAt = telemetry.now()
    return res
  }
  return {
    instrument,
    get traceparent() {
      return traceparent
    },
  }
}

/**
 * Tracing for one turn of a graph driver (graph-engine `drive`, dispatch-engine `driveDispatch`, release `drive`).
 * Wraps {@link advanceHooks} and keeps `holder.traceparent` (the turn's subject) on the issue trace, so a marker
 * written during the turn stores it (issue-state.mjs `setMarker`). Call `sync()` before writes made outside
 * `advance` (a wait's `enter`). With telemetry off, or none, `instrument` is undefined and `advance` runs exactly
 * as it does untraced.
 *
 * @param {Telemetry | undefined} telemetry
 * @param {{ traceparent?: string | null }} holder
 * @param {TraceInfo & { enteredAt?: string | null }} base as for {@link advanceHooks}
 * @returns {{ instrument: import('./graph/advance.mjs').Instrument | undefined, sync: () => void }}
 */
export function turnTracer(telemetry, holder, base) {
  if (!telemetry?.enabled) return { instrument: undefined, sync: () => {} }
  const hooks = advanceHooks(telemetry, base)
  const sync = () => {
    if (hooks.traceparent) holder.traceparent = hooks.traceparent
  }
  return {
    instrument: (visit, step) =>
      hooks.instrument(visit, (extra) => {
        sync()
        return step(extra)
      }),
    sync,
  }
}

/**
 * The marker fields a turn's {@link turnTracer} starts from. No marker yet is a fresh issue: attempt 1, as
 * marker.mjs `newMarker` has it.
 * @param {{ traceparent?: string | null, enteredAt?: string | null, attempt?: number } | null | undefined} marker
 */
export const markerTrace = (marker) => ({
  traceparent: marker?.traceparent ?? null,
  enteredAt: marker?.enteredAt ?? null,
  attempt: marker?.attempt ?? 1,
})

/**
 * A finished worker's `claude.*` spans from its stream-json stdout log, under the step span that started it
 * (`parent`, kept on the worker row). Never throws: tracing must not fail a tick.
 *
 * @param {{ telemetry?: Telemetry, spawner: { readLog(path: string): string },
 *   log: (level: 'info' | 'warn' | 'error', msg: string, where?: { repo?: string, issue?: number }) => void }} ctx
 * @param {{ repo: string, issue: number, stdout: string, traceparent?: string | null }} w
 */
export function traceWorker(ctx, w) {
  if (!ctx.telemetry?.enabled || !w.traceparent) return
  try {
    ctx.telemetry.workerSpans(ctx.spawner.readLog(w.stdout), w.traceparent)
  } catch (err) {
    ctx.log('warn', `worker spans: ${/** @type {Error} */ (err)?.message ?? err}`, { repo: w.repo, issue: w.issue })
  }
}

/** A node output's own `outcome` string when it has one, else `ok`. @param {unknown} output */
const outcomeOf = (output) => {
  const o = /** @type {any} */ (output)?.outcome
  return typeof o === 'string' ? o : 'ok'
}

const COMMAND_MAX = 200
const TURN_TEXT_MAX = 4000

/** @param {string} a @param {string} b */
const join = (a, b) => (a && b ? `${a}\n\n${b}` : a || b)

/** A turn worth a span: it thought or said something. @param {Turn} u */
const said = (u) => Boolean(u.thinking.trim() || u.text.trim())

/** @param {unknown} s @param {number} [max] */
const clip = (s, max = COMMAND_MAX) => {
  if (typeof s !== 'string') return undefined
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** @param {Record<string, unknown>} a */
const defined = (a) =>
  /** @type {import('@opentelemetry/api').Attributes} */ (
    Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== null))
  )

/** @param {string | Iterable<string | Record<string, any>>} stream @returns {Generator<Record<string, any>>} */
function* events(stream) {
  const items = typeof stream === 'string' ? stream.split('\n') : stream
  for (const item of items) {
    if (typeof item !== 'string') {
      if (item && typeof item === 'object') yield item
      continue
    }
    if (!item.trim()) continue
    try {
      const e = JSON.parse(item)
      yield e && typeof e === 'object' ? e : { type: '__malformed' }
    } catch {
      yield { type: '__malformed' }
    }
  }
}

/**
 * The last `result` event in a worker's stream-json log (cost, usage, turns), or null when there is none: a killed
 * worker or a truncated log. Never throws.
 * @param {string | Iterable<string | Record<string, any>>} stream @returns {Record<string, any> | null}
 */
export function resultEvent(stream) {
  let result = null
  for (const e of events(stream)) if (e.type === 'result') result = e
  return result
}

/**
 * @typedef {{ id: string, name: string, input: any, start: number, end: number | null, error: boolean, parentToolId: string | null }} ToolUse
 * @typedef {{ id: string, toolUseId: string | null, type?: string, description?: string, start: number, end: number | null, status?: string }} BgTask
 * @typedef {{ id: string, start: number, end: number, thinking: string, text: string, tools: string[], parentToolId: string | null }} Turn
 * @typedef {{
 *   sessionId: string | null, complete: boolean, ok: boolean, start: number | null, end: number | null,
 *   tools: number, tasks: number, turns: number, malformed: number, costUsd: number | null,
 * }} WorkerSummary
 */

/**
 * Spans for one `claude -p --output-format stream-json --verbose` worker run, from its stdout log. Pure apart from
 * the spans it emits (all already ended); call it once the worker has exited.
 *
 * - `claude.session`, child of `parent`, from the first to the last `timestamp` in the stream; attributes from the
 *   `result` event (cost, tokens, turns, terminal_reason, model) and `system/init` (claude_code version, session id).
 *   No `result` (a killed worker, a truncated log) or an error result → ERROR status.
 * - `claude.tool` per `tool_use` → matching `tool_result` (a subagent's tools nest under its Agent/Task tool span),
 *   with the tool name, ok/error and, for Bash, the command clipped to 200 chars. Unpaired → ends at the last
 *   timestamp, ERROR.
 * - `claude.turn` per assistant message (its stream events grouped by `message.id`) that says or thinks anything:
 *   the thinking summary and text, each clipped to 4000 chars, and the tools it called. It runs from the event before
 *   the message (the model's input was ready) to its last event, under the subagent's tool span when it has one.
 *   Thinking is empty unless the worker runs with `--thinking-display summarized`.
 * - `claude.task` per background task, `task_started` → `task_notification` (or `task_updated`'s `end_time`). These
 *   system events carry no timestamp, so their times are those of the latest timestamped event before them.
 *
 * Malformed lines are counted and skipped. Without any timestamp nothing is emitted.
 *
 * @param {string | Iterable<string | Record<string, any>>} stream the log text, its lines, or parsed events
 * @param {{ tracer: import('@opentelemetry/api').Tracer, parent?: import('@opentelemetry/api').Context | string | null }} opts
 *   `parent`: the start-worker span's context or its traceparent
 * @returns {WorkerSummary}
 */
export function workerSpans(stream, { tracer, parent }) {
  /** @type {number | null} */
  let first = null
  /** @type {number | null} */
  let last = null
  let malformed = 0
  /** @type {any} */
  let init = null
  /** @type {any} */
  let result = null
  /** @type {Map<string, ToolUse>} */
  const tools = new Map()
  /** @type {Map<string, BgTask>} */
  const tasks = new Map()
  /** @type {Map<string, Turn>} */
  const turns = new Map()

  for (const e of events(stream)) {
    if (e.type === '__malformed') {
      malformed++
      continue
    }
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN
    const before = last
    if (!Number.isNaN(ts)) {
      first ??= ts
      last = Math.max(last ?? ts, ts)
    }
    const at = Number.isNaN(ts) ? last : ts
    const content = Array.isArray(e.message?.content) ? e.message.content : []
    if (e.type === 'system' && e.subtype === 'init') init ??= e
    else if (e.type === 'result') result = e
    else if (e.type === 'assistant' && at !== null) {
      const id = typeof e.message?.id === 'string' ? e.message.id : typeof e.uuid === 'string' ? e.uuid : null
      let turn = id ? turns.get(id) : undefined
      if (id && !turn) {
        turn = {
          id,
          start: Math.min(before ?? at, at),
          end: at,
          thinking: '',
          text: '',
          tools: [],
          parentToolId: typeof e.parent_tool_use_id === 'string' ? e.parent_tool_use_id : null,
        }
        turns.set(id, turn)
      }
      if (turn) {
        turn.end = Math.max(turn.end, at)
        for (const c of content) {
          if (c?.type === 'thinking' && typeof c.thinking === 'string') turn.thinking = join(turn.thinking, c.thinking)
          else if (c?.type === 'text' && typeof c.text === 'string') turn.text = join(turn.text, c.text)
          else if (c?.type === 'tool_use') turn.tools.push(String(c.name ?? 'unknown'))
        }
      }
      for (const c of content)
        if (c?.type === 'tool_use' && typeof c.id === 'string' && !tools.has(c.id))
          tools.set(c.id, {
            id: c.id,
            name: String(c.name ?? 'unknown'),
            input: c.input,
            start: at,
            end: null,
            error: false,
            parentToolId: typeof e.parent_tool_use_id === 'string' ? e.parent_tool_use_id : null,
          })
    } else if (e.type === 'user' && at !== null) {
      for (const c of content) {
        const t = c?.type === 'tool_result' ? tools.get(c.tool_use_id) : undefined
        if (t && t.end === null) {
          t.end = at
          t.error = c.is_error === true
        }
      }
    } else if (e.type === 'system' && typeof e.task_id === 'string' && last !== null) {
      const known = tasks.get(e.task_id)
      if (e.subtype === 'task_started' && !known)
        tasks.set(e.task_id, {
          id: e.task_id,
          toolUseId: typeof e.tool_use_id === 'string' ? e.tool_use_id : null,
          type: e.task_type,
          description: clip(e.description),
          start: last,
          end: null,
        })
      else if (known && e.subtype === 'task_updated') {
        const end = Number(e.patch?.end_time)
        if (Number.isFinite(end) && end > 0) known.end = end
        if (typeof e.patch?.status === 'string') known.status = e.patch.status
      } else if (known && e.subtype === 'task_notification') {
        known.end ??= last
        if (typeof e.status === 'string') known.status = e.status
      }
    }
  }

  const sessionId = result?.session_id ?? init?.session_id ?? null
  const ok = Boolean(result) && result.is_error !== true && result.subtype === 'success'
  /** @type {WorkerSummary} */
  const summary = {
    sessionId,
    complete: Boolean(result),
    ok,
    start: first,
    end: last,
    tools: tools.size,
    tasks: tasks.size,
    turns: [...turns.values()].filter(said).length,
    malformed,
    costUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
  }
  if (first === null || last === null) return summary
  const end = last

  const sc = typeof parent === 'string' || parent == null ? spanContextOf(parent) : null
  const parentCtx =
    typeof parent === 'object' && parent !== null ? parent : sc ? trace.setSpanContext(ROOT_CONTEXT, sc) : ROOT_CONTEXT
  const usage = result?.usage ?? {}
  const session = tracer.startSpan(
    'claude.session',
    {
      startTime: first,
      attributes: defined({
        'claude.session_id': sessionId,
        'claude.model': Object.keys(result?.modelUsage ?? {})[0] ?? init?.model,
        'claude_code.version': init?.claude_code_version,
        'claude.cost_usd': result?.total_cost_usd,
        'claude.tokens.input': usage.input_tokens,
        'claude.tokens.output': usage.output_tokens,
        'claude.tokens.cache_read': usage.cache_read_input_tokens,
        'claude.tokens.cache_creation': usage.cache_creation_input_tokens,
        'claude.turns': result?.num_turns,
        'claude.duration_ms': result?.duration_ms,
        'claude.terminal_reason': result?.terminal_reason,
        'claude.result': result?.subtype ?? 'missing',
        'claude.permission_denials': Array.isArray(result?.permission_denials)
          ? result.permission_denials.length
          : undefined,
        'claude.stream.malformed': malformed || undefined,
      }),
    },
    parentCtx,
  )
  if (!result) session.setStatus({ code: SpanStatusCode.ERROR, message: 'no result: worker killed or log truncated' })
  else if (!ok) session.setStatus({ code: SpanStatusCode.ERROR, message: String(result.subtype ?? 'error') })
  const sessionCtx = trace.setSpan(parentCtx, session)

  /** @type {Map<string, import('@opentelemetry/api').Context>} */
  const toolCtx = new Map()
  for (const t of [...tools.values()].sort((a, b) => a.start - b.start)) {
    const span = tracer.startSpan(
      'claude.tool',
      {
        startTime: t.start,
        attributes: defined({
          'claude.tool.name': t.name,
          'claude.tool.use_id': t.id,
          'claude.tool.outcome': t.end === null ? 'unfinished' : t.error ? 'error' : 'ok',
          'claude.tool.command': t.name === 'Bash' ? clip(t.input?.command) : undefined,
        }),
      },
      (t.parentToolId && toolCtx.get(t.parentToolId)) || sessionCtx,
    )
    if (t.end === null) span.setStatus({ code: SpanStatusCode.ERROR, message: 'no tool_result' })
    else if (t.error) span.setStatus({ code: SpanStatusCode.ERROR })
    span.end(t.end ?? end)
    toolCtx.set(t.id, trace.setSpan(sessionCtx, span))
  }
  for (const u of turns.values()) {
    if (!said(u)) continue
    tracer
      .startSpan(
        'claude.turn',
        {
          startTime: u.start,
          attributes: defined({
            'claude.message_id': u.id,
            'claude.thinking': clip(u.thinking, TURN_TEXT_MAX) || undefined,
            'claude.text': clip(u.text, TURN_TEXT_MAX) || undefined,
            'claude.turn.tools': u.tools.length ? u.tools.join(',') : undefined,
          }),
        },
        (u.parentToolId && toolCtx.get(u.parentToolId)) || sessionCtx,
      )
      .end(u.end)
  }
  for (const k of tasks.values()) {
    const span = tracer.startSpan(
      'claude.task',
      {
        startTime: k.start,
        attributes: defined({
          'claude.task.id': k.id,
          'claude.task.type': k.type,
          'claude.task.status': k.status ?? 'unfinished',
          'claude.task.description': k.description,
        }),
      },
      (k.toolUseId && toolCtx.get(k.toolUseId)) || sessionCtx,
    )
    if (k.end === null || (k.status && k.status !== 'completed'))
      span.setStatus({ code: SpanStatusCode.ERROR, message: k.status ?? 'no task_notification' })
    span.end(Math.max(k.start, k.end ?? end))
  }
  session.end(end)
  return summary
}
