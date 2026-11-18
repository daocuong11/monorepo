// @ts-check
import { INVALID_SPAN_CONTEXT, isSpanContextValid, trace, TraceFlags } from '@opentelemetry/api'

/**
 * @typedef {import('@opentelemetry/api').Tracer} Tracer
 * @typedef {import('@opentelemetry/api').SpanContext} SpanContext
 * @typedef {{
 *   enabled: boolean,
 *   tracer: Tracer,
 *   flush: () => Promise<void>,
 *   shutdown: () => Promise<void>,
 * }} Tracing
 */

export const SERVICE_NAME = 'mycelium'

/** Spans that record nothing and cost a function call; their context is invalid, so no traceparent is written. */
const noopTracer = /** @type {Tracer} */ (
  /** @type {unknown} */ ({ startSpan: () => trace.wrapSpanContext(INVALID_SPAN_CONTEXT) })
)

/** @type {Tracing} */
export const NO_TRACING = Object.freeze({
  enabled: false,
  tracer: noopTracer,
  flush: async () => {},
  shutdown: async () => {},
})

/**
 * Tracing is on only when the standard env names an OTLP endpoint and does
 * not switch the SDK or the trace exporter off.
 *
 * @param {Record<string, string | undefined>} env
 */
export function otlpConfigured(env) {
  if (
    String(env.OTEL_SDK_DISABLED ?? '')
      .trim()
      .toLowerCase() === 'true'
  )
    return false
  const exporters = String(env.OTEL_TRACES_EXPORTER ?? 'otlp')
    .split(',')
    .map((s) => s.trim().toLowerCase())
  if (exporters.includes('none')) return false
  return Boolean(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT)
}

/**
 * A tracer for `service.name=mycelium`. Without an OTLP endpoint in `env` (and
 * no `exporter` given) this is {@link NO_TRACING}: the SDK is never loaded.
 * The OTLP/HTTP exporter reads its endpoint, headers and timeout from the
 * standard `OTEL_EXPORTER_OTLP_*` variables; `OTEL_SERVICE_NAME` and
 * `OTEL_RESOURCE_ATTRIBUTES` override the resource.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   exporter?: import('@opentelemetry/sdk-trace').SpanExporter,
 * }} [opts]
 * @returns {Promise<Tracing>}
 */
export async function createTracing({ env = process.env, exporter } = {}) {
  if (!exporter && !otlpConfigured(env)) return NO_TRACING
  const [sdk, res] = await Promise.all([import('@opentelemetry/sdk-trace'), import('@opentelemetry/resources')])
  const out = exporter ?? new (await import('@opentelemetry/exporter-trace-otlp-http')).OTLPTraceExporter()
  const resource = res
    .defaultResource()
    .merge(res.resourceFromAttributes({ 'service.name': SERVICE_NAME }))
    .merge(res.detectResources({ detectors: [res.envDetector] }))
  const provider = new sdk.TracerProvider({
    resource,
    spanProcessors: [new sdk.BatchSpanProcessor({ exporter: out })],
  })
  let down = false
  return {
    enabled: true,
    tracer: provider.getTracer(SERVICE_NAME),
    flush: () => provider.forceFlush(),
    /** Flushes what is queued, then stops; safe to call twice. */
    shutdown: async () => {
      if (down) return
      down = true
      await provider.shutdown()
    },
  }
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

/**
 * The W3C `traceparent` of a span context, or null for an invalid (no-op) one.
 *
 * @param {SpanContext} sc
 */
export function formatTraceparent(sc) {
  if (!isSpanContextValid(sc)) return null
  const flags = ((sc.traceFlags ?? TraceFlags.NONE) & 0xff).toString(16).padStart(2, '0')
  return `00-${sc.traceId}-${sc.spanId}-${flags}`
}

/**
 * A remote span context from a version-00 `traceparent`, or null when it is
 * malformed or names an all-zero trace or span.
 *
 * @param {string | null | undefined} value
 * @returns {(SpanContext & { traceparent: string }) | null}
 */
export function spanContextOf(value) {
  const m = TRACEPARENT.exec(String(value ?? ''))
  if (!m) return null
  const sc = { traceId: m[1], spanId: m[2], traceFlags: Number.parseInt(m[3], 16), isRemote: true }
  return isSpanContextValid(sc) ? { ...sc, traceparent: /** @type {string} */ (value) } : null
}
