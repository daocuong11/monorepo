// @ts-check
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

/** Older rotated files are read, newest first, until this many bytes in all. */
export const DEFAULT_BUDGET = 64 * 1024 * 1024
export const TRACE_ID = /^[0-9a-f]{32}$/

/**
 * @typedef {{
 *   traceId: string, spanId: string, parentSpanId: string | null, name: string, service: string | null,
 *   start: number, end: number, status: 'ok' | 'error' | 'unset', statusMessage: string | null,
 *   attrs: Record<string, unknown>, events: { name: string, at: number, attrs: Record<string, unknown> }[],
 * }} Span
 * @typedef {{
 *   id: string, start: number, end: number, durationMs: number, spans: number, errors: number,
 *   root: string, services: string[], repo: string | null, issue: number | null, graph: string | null,
 *   node: string | null, outcome: string | null, costUsd: number | null, trail: string[],
 * }} TraceSummary
 *   `trail`: the graph nodes the run stepped through, oldest first, repeats in a row folded, at most the last 6.
 * @typedef {Pick<TraceSummary, 'id' | 'graph' | 'node' | 'outcome' | 'costUsd' | 'errors' | 'end' | 'trail'>} IssueProgress
 * @typedef {{
 *   status: 'ok' | 'missing' | 'unreadable', path: string, message: string | null,
 *   files: number, malformed: number, traces: Map<string, Span[]>,
 * }} TraceFile
 */

/** An OTLP/JSON AnyValue as a plain value. */
export function anyValue(/** @type {any} */ v) {
  if (!v || typeof v !== 'object') return null
  if ('stringValue' in v) return v.stringValue
  if ('boolValue' in v) return Boolean(v.boolValue)
  if ('intValue' in v) return Number(v.intValue)
  if ('doubleValue' in v) return Number(v.doubleValue)
  if ('arrayValue' in v) return (v.arrayValue?.values ?? []).map(anyValue)
  if ('kvlistValue' in v) return attrsOf(v.kvlistValue?.values)
  if ('bytesValue' in v) return v.bytesValue
  return null
}

const attrsOf = (/** @type {any} */ kvs) =>
  Object.fromEntries(
    (Array.isArray(kvs) ? kvs : []).map((/** @type {any} */ kv) => [String(kv?.key), anyValue(kv?.value)]),
  )

/** Unix nanoseconds (string or number) → milliseconds, keeping microseconds. */
export function nanosToMs(/** @type {unknown} */ n) {
  if (typeof n === 'number') return n / 1e6
  if (typeof n !== 'string' || !/^\d+$/.test(n)) return Number.NaN
  return Number(BigInt(n) / 1000n) / 1000
}

const STATUS = /** @type {const} */ ({ 0: 'unset', 1: 'ok', 2: 'error' })
const STATUS_NAMED = /** @type {Record<string, 'ok' | 'error' | 'unset'>} */ ({
  STATUS_CODE_UNSET: 'unset',
  STATUS_CODE_OK: 'ok',
  STATUS_CODE_ERROR: 'error',
})

/**
 * The spans in one line of the collector's file exporter (an OTLP/JSON
 * `ExportTraceServiceRequest`). Throws on a line that is not JSON.
 *
 * @param {string} line
 * @returns {Span[]}
 */
export function spansOf(line) {
  const doc = JSON.parse(line)
  /** @type {Span[]} */
  const out = []
  for (const rs of Array.isArray(doc?.resourceSpans) ? doc.resourceSpans : []) {
    const resource = attrsOf(rs?.resource?.attributes)
    const service = typeof resource['service.name'] === 'string' ? resource['service.name'] : null
    for (const ss of Array.isArray(rs?.scopeSpans) ? rs.scopeSpans : [])
      for (const s of Array.isArray(ss?.spans) ? ss.spans : []) {
        const traceId = String(s?.traceId ?? '').toLowerCase()
        const spanId = String(s?.spanId ?? '').toLowerCase()
        if (!TRACE_ID.test(traceId) || !spanId) continue
        const start = nanosToMs(s.startTimeUnixNano)
        const end = nanosToMs(s.endTimeUnixNano)
        const code = s.status?.code
        out.push({
          traceId,
          spanId,
          parentSpanId: s.parentSpanId ? String(s.parentSpanId).toLowerCase() : null,
          name: String(s.name ?? '?'),
          service,
          start,
          end: Number.isFinite(end) ? end : start,
          status: STATUS[/** @type {0 | 1 | 2} */ (code)] ?? STATUS_NAMED[code] ?? 'unset',
          statusMessage: s.status?.message || null,
          attrs: attrsOf(s.attributes),
          events: (Array.isArray(s.events) ? s.events : []).map((/** @type {any} */ e) => ({
            name: String(e?.name ?? '?'),
            at: nanosToMs(e?.timeUnixNano),
            attrs: attrsOf(e?.attributes),
          })),
        })
      }
  }
  return out.filter((s) => Number.isFinite(s.start))
}

/**
 * Group the spans in some JSONL texts by trace. A span seen twice (same trace
 * and span id) is kept once.
 *
 * @param {string[]} texts
 */
export function parseTraces(texts) {
  /** @type {Map<string, Map<string, Span>>} */
  const byTrace = new Map()
  let malformed = 0
  for (const text of texts)
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let spans
      try {
        spans = spansOf(line)
      } catch {
        malformed++
        continue
      }
      for (const s of spans) {
        const t = byTrace.get(s.traceId) ?? new Map()
        byTrace.set(s.traceId, t)
        t.set(s.spanId, s)
      }
    }
  return { traces: new Map([...byTrace].map(([id, m]) => [id, [...m.values()]])), malformed }
}

const firstAttr = (/** @type {Span[]} */ spans, /** @type {string[]} */ keys) => {
  for (const s of spans) for (const k of keys) if (s.attrs[k] != null && s.attrs[k] !== '') return s.attrs[k]
  return null
}

/**
 * What a list row needs to know about one trace: when, how long, where it is
 * (the last cambium node to finish) and whether anything failed.
 *
 * @param {string} id
 * @param {Span[]} spans
 * @returns {TraceSummary}
 */
export function summarize(id, spans) {
  const ids = new Set(spans.map((s) => s.spanId))
  const roots = spans.filter((s) => !s.parentSpanId || !ids.has(s.parentSpanId)).sort((a, b) => a.start - b.start)
  const start = Math.min(...spans.map((s) => s.start))
  const end = Math.max(...spans.map((s) => s.end))
  const steps = spans.filter((s) => typeof s.attrs['cambium.node'] === 'string').sort((a, b) => a.end - b.end)
  const lastStep = steps.at(-1) ?? null
  const issue = Number(firstAttr(spans, ['cambium.issue.number', 'mycelium.issue.number']))
  const costs = spans.map((s) => s.attrs['claude.cost_usd']).filter((c) => typeof c === 'number')
  return {
    id,
    start,
    end,
    durationMs: end - start,
    spans: spans.length,
    errors: spans.filter((s) => s.status === 'error').length,
    root: (roots[0] ?? spans[0]).name,
    services: [...new Set(spans.map((s) => s.service).filter((s) => s !== null))],
    repo: /** @type {string | null} */ (firstAttr(spans, ['cambium.repo'])),
    issue: Number.isInteger(issue) && issue > 0 ? issue : null,
    graph: /** @type {string | null} */ (firstAttr(spans, ['cambium.graph'])),
    node: lastStep ? String(lastStep.attrs['cambium.node']) : null,
    outcome: lastStep && lastStep.attrs['cambium.outcome'] != null ? String(lastStep.attrs['cambium.outcome']) : null,
    costUsd: costs.length ? costs.reduce((a, b) => a + /** @type {number} */ (b), 0) : null,
    trail: steps
      .map((s) => String(s.attrs['cambium.node']))
      .filter((n, i, all) => n !== all[i - 1])
      .slice(-TRAIL_KEPT),
  }
}

const TRAIL_KEPT = 6

/**
 * The collector's trace file plus its rotated backups (`traces-<time>.jsonl`
 * next to it), newest first, within a byte budget. Re-read only when a file
 * changes size or mtime.
 *
 * @param {{
 *   path: string,
 *   budget?: number,
 *   fs?: {
 *     stat: (p: string) => Promise<{ size: number, mtimeMs: number }>,
 *     readdir: (p: string) => Promise<string[]>,
 *     readFile: (p: string) => Promise<string>,
 *   },
 * }} opts
 */
export function traceStore({
  path,
  budget = DEFAULT_BUDGET,
  fs = { stat, readdir, readFile: (p) => readFile(p, 'utf8') },
}) {
  const dir = dirname(path)
  const ext = extname(path)
  const prefix = `${basename(path, ext)}-`
  /** @type {{ key: string, file: TraceFile } | null} */
  let cache = null
  /** @type {Promise<TraceFile> | null} */
  let inflight = null

  /** @returns {Promise<TraceFile>} */
  async function load() {
    let head
    try {
      head = await fs.stat(path)
    } catch (err) {
      const missing = /** @type {any} */ (err)?.code === 'ENOENT'
      return {
        status: missing ? 'missing' : 'unreadable',
        path,
        message: missing
          ? `no trace file at ${path}: cambium exports traces only when OTEL_EXPORTER_OTLP_ENDPOINT points at a collector that writes this file (see cambium's README, Tracing)`
          : `cannot read ${path}: ${/** @type {Error} */ (err).message}`,
        files: 0,
        malformed: 0,
        traces: new Map(),
      }
    }
    /** @type {{ p: string, size: number, mtimeMs: number }[]} */
    const files = [{ p: path, size: head.size, mtimeMs: head.mtimeMs }]
    let names = []
    try {
      names = (await fs.readdir(dir))
        .filter((n) => n.startsWith(prefix) && n.endsWith(ext))
        .sort()
        .reverse()
    } catch {}
    let total = head.size
    for (const n of names) {
      if (total >= budget) break
      try {
        const st = await fs.stat(join(dir, n))
        files.push({ p: join(dir, n), size: st.size, mtimeMs: st.mtimeMs })
        total += st.size
      } catch {}
    }
    const key = files.map((f) => `${f.p}:${f.size}:${f.mtimeMs}`).join('|')
    if (cache?.key === key) return cache.file
    try {
      const texts = await Promise.all(files.map((f) => fs.readFile(f.p)))
      const { traces, malformed } = parseTraces(texts.reverse())
      /** @type {TraceFile} */
      const file = { status: 'ok', path, message: null, files: files.length, malformed, traces }
      cache = { key, file }
      return file
    } catch (err) {
      return {
        status: 'unreadable',
        path,
        message: `cannot read ${path}: ${/** @type {Error} */ (err).message}`,
        files: 0,
        malformed: 0,
        traces: new Map(),
      }
    }
  }

  return {
    path,
    /** One read at a time however many requests ask. */
    read() {
      inflight ??= load().finally(() => {
        inflight = null
      })
      return inflight
    },
  }
}

/** @typedef {ReturnType<typeof traceStore>} TraceStore */

const describe = (/** @type {TraceFile} */ f) => ({
  status: f.status,
  path: f.path,
  message: f.message,
  files: f.files,
  malformed: f.malformed,
})

/** @type {WeakMap<TraceFile, TraceSummary[]>} */
const summarized = new WeakMap()

/** Newest-finishing traces first, worked out once per read of the files. @param {TraceFile} f */
function summaries(f) {
  let all = summarized.get(f)
  if (!all) {
    all = [...f.traces].map(([id, spans]) => summarize(id, spans)).sort((a, b) => b.end - a.end)
    summarized.set(f, all)
  }
  return all
}

/**
 * `/api/traces`: the file's state and the newest `limit` traces.
 *
 * @param {TraceFile} f
 * @param {{ limit?: number }} [opts]
 */
export function traceList(f, { limit = 200 } = {}) {
  const all = summaries(f)
  return { ...describe(f), total: all.length, traces: all.slice(0, limit) }
}

/**
 * What `/api/state` carries: counts and, per `owner/name#n`, that issue's
 * newest trace id, so other tabs can link to it, and where that run has got to
 * (`progress`), so the Queue tab can show how far live work has come.
 *
 * @param {TraceFile} f
 */
export function traceIndex(f) {
  const all = summaries(f)
  /** @type {Record<string, string>} */
  const byIssue = {}
  /** @type {Record<string, IssueProgress>} */
  const progress = {}
  for (const t of all) {
    if (!t.repo || !t.issue) continue
    const key = `${t.repo}#${t.issue}`
    if (byIssue[key]) continue
    byIssue[key] = t.id
    const { id, graph, node, outcome, costUsd, errors, end, trail } = t
    progress[key] = { id, graph, node, outcome, costUsd, errors, end, trail }
  }
  return { ...describe(f), total: all.length, errored: all.filter((t) => t.errors).length, byIssue, progress }
}

/**
 * `/api/traces/<id>`: one trace's summary and every span, parents before
 * children, siblings by start time; `depth` is the nesting level.
 *
 * @param {TraceFile} f
 * @param {string} id
 */
export function traceDetail(f, id) {
  const spans = f.traces.get(id)
  if (!spans) return null
  const ids = new Set(spans.map((s) => s.spanId))
  /** @type {Map<string | null, Span[]>} */
  const kids = new Map()
  for (const s of spans) {
    const parent = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : null
    kids.set(parent, [...(kids.get(parent) ?? []), s])
  }
  /** @type {(Span & { depth: number })[]} */
  const ordered = []
  const walk = (/** @type {string | null} */ parent, /** @type {number} */ depth) => {
    for (const s of (kids.get(parent) ?? []).sort((a, b) => a.start - b.start || a.end - b.end)) {
      ordered.push({ ...s, depth })
      walk(s.spanId, depth + 1)
    }
  }
  walk(null, 0)
  if (ordered.length < spans.length) {
    // A parent loop never reaches the top level; show those spans flat rather than drop them.
    const placed = new Set(ordered.map((s) => s.spanId))
    for (const s of spans) if (!placed.has(s.spanId)) ordered.push({ ...s, depth: 0 })
  }
  return { ...describe(f), summary: summarize(id, spans), spans: ordered }
}
