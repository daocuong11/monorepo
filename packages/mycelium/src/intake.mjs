// @ts-check
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { fingerprint } from './envelope.mjs'
import { formatTraceparent, NO_TRACING, spanContextOf } from './telemetry.mjs'

export const LABEL = 'q:intake'

// The traceparent is optional (bodies filed before tracing have none) and is
// validated separately, so a mangled one never costs the fingerprint.
const MARKER = /^<!-- mycelium:fingerprint=([0-9a-f]{8,64})(?: traceparent=([^\s>]+))? -->/
const TITLE_MAX = 120
const TEXT_MAX = 50_000

/**
 * @typedef {import('./envelope.mjs').Envelope} Envelope
 * @typedef {{ number: number, body?: string | null }} Intent
 * @typedef {{
 *   openIntents: () => Promise<Intent[]>,
 *   createIssue: (issue: { title: string, body: string, labels: string[] }) => Promise<{ number: number, html_url?: string }>,
 *   comment: (number: number, body: string) => Promise<{ html_url?: string }>,
 *   issuesSince?: (since: string) => Promise<import('./notify.mjs').Issue[]>,
 * }} GithubClient
 * @typedef {{ source: string, externalId: string, fingerprint: string }} Origin
 * @typedef {Origin & ({ action: 'create', title: string, body: string, labels: string[] }
 *   | { action: 'comment', issue: number, body: string })} Action
 */

/**
 * The first-line identity marker; with a traceparent it carries the trace
 * that filed the issue: `<!-- mycelium:fingerprint=<fp> traceparent=00-<trace>-<span>-<flags> -->`.
 *
 * @param {string} fp
 * @param {string | null} [traceparent]
 */
export const marker = (fp, traceparent) =>
  `<!-- mycelium:fingerprint=${fp}${traceparent ? ` traceparent=${traceparent}` : ''} -->`

/**
 * Only a marker on the body's first line counts: reporter text further down
 * cannot claim another intent's fingerprint.
 *
 * @param {string | null | undefined} body
 */
export function fingerprintOf(body) {
  return MARKER.exec(String(body ?? ''))?.[1] ?? null
}

/**
 * The span context of the trace that filed an intent, from the traceparent in
 * its first-line marker: `{ traceId, spanId, traceFlags, isRemote, traceparent }`,
 * or null when the body has no (valid) traceparent. Use it as a parent or a
 * link to continue the intent's trace.
 *
 * @param {string | null | undefined} body
 */
export function parseTraceparent(body) {
  return spanContextOf(MARKER.exec(String(body ?? ''))?.[2])
}

/** A cell value that cannot break the table, mention anyone, or open HTML. */
const cell = (/** @type {unknown} */ v) => {
  const s = String(v ?? '')
    .replace(/[\s|]+/g, ' ')
    .replace(/`/g, "'")
    .trim()
  return s ? `\`${s}\`` : ''
}

/** Free text inside a fence longer than any backtick run in it, so it renders inert. */
export function fence(/** @type {string} */ text) {
  const clipped = text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}\n[truncated]` : text
  const longest = Math.max(2, ...(clipped.match(/`+/g) ?? []).map((r) => r.length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}text\n${clipped}\n${ticks}`
}

/** @param {Envelope} e */
function rows(e, fp) {
  const fixed = [
    ['source', cell(e.source)],
    ['fingerprint', cell(fp)],
    ['external id', cell(e.externalId)],
    ['author', cell(e.author)],
    ['received', cell(e.receivedAt)],
    ['url', /^https:\/\/[^\s<>|]+$/.test(e.url ?? '') ? `<${e.url}>` : cell(e.url)],
  ]
  const meta = Object.entries(e.meta)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [`meta.${k}`, cell(typeof v === 'object' ? JSON.stringify(v) : v)])
  return [...fixed, ...meta].map(([k, v]) => `| ${k} | ${v} |`).join('\n')
}

export function issueTitle(/** @type {Envelope} */ e) {
  const t = (e.title || e.body || '(no text)').replace(/\s+/g, ' ').trim()
  const head = `[${e.source}] `
  const room = TITLE_MAX - head.length
  return head + (t.length > room ? `${t.slice(0, room - 1)}…` : t)
}

/**
 * @param {Envelope} e
 * @param {string} fp
 */
export function issueBody(e, fp) {
  return [
    marker(fp),
    '## Intake',
    '',
    '| field | value |',
    '|---|---|',
    rows(e, fp),
    '',
    '## Report',
    '',
    fence([e.title, e.body].filter(Boolean).join('\n\n')),
    '',
  ].join('\n')
}

/**
 * @param {Envelope} e
 * @param {string} fp
 */
export function commentBody(e, fp) {
  return [
    `Another report for intake \`${fp}\`.`,
    '',
    '| field | value |',
    '|---|---|',
    rows(e, fp),
    '',
    fence([e.title, e.body].filter(Boolean).join('\n\n')),
    '',
  ].join('\n')
}

/**
 * Dedupe against open intents. Reads open `q:intake` issues once, then keeps
 * the index current as it files, so two envelopes for one fingerprint in a
 * pass make one issue and one comment.
 *
 * Each apply records one short `mycelium.intake` span, the root of its own
 * trace. A create writes that span's traceparent into the new issue's marker;
 * a comment links its span to the traceparent of the issue it lands on.
 *
 * @param {GithubClient} github
 * @param {{ tracer?: import('@opentelemetry/api').Tracer }} [opts]
 */
export function createIntake(github, { tracer = NO_TRACING.tracer } = {}) {
  /** @type {Map<string, { number: number, link: import('@opentelemetry/api').SpanContext | null }> | null} */
  let index = null
  const load = async () => {
    if (index) return index
    index = new Map()
    for (const i of await github.openIntents()) {
      const fp = fingerprintOf(i.body)
      if (fp && !index.has(fp)) index.set(fp, { number: i.number, link: parseTraceparent(i.body) })
    }
    return index
  }

  /**
   * @param {Envelope} e
   * @returns {Promise<Action>}
   */
  const plan = async (e) => {
    const fp = fingerprint(e)
    const origin = { source: e.source, externalId: e.externalId, fingerprint: fp }
    const open = (await load()).get(fp)
    if (open !== undefined) return { action: 'comment', ...origin, issue: open.number, body: commentBody(e, fp) }
    return { action: 'create', ...origin, title: issueTitle(e), body: issueBody(e, fp), labels: [LABEL] }
  }

  /**
   * @param {Action} a
   * @returns {Promise<{ issue: number, url: string | null }>}
   */
  const apply = async (a) => {
    const known = a.action === 'comment' ? (await load()).get(a.fingerprint)?.link : null
    // Started before the write: a new issue's body must carry this span's
    // traceparent, while its number is only known once the write returns.
    const span = tracer.startSpan('mycelium.intake', {
      root: true,
      kind: SpanKind.PRODUCER,
      links: known ? [{ context: known }] : [],
      attributes: {
        'mycelium.source': a.source,
        'mycelium.external_id': a.externalId,
        'mycelium.fingerprint': a.fingerprint,
        'mycelium.action': a.action,
      },
    })
    try {
      if (a.action === 'comment') {
        span.setAttribute('mycelium.issue.number', a.issue)
        const res = await github.comment(a.issue, a.body)
        return { issue: a.issue, url: res?.html_url ?? null }
      }
      const tp = formatTraceparent(span.spanContext())
      const head = marker(a.fingerprint)
      const body = tp && a.body.startsWith(head) ? marker(a.fingerprint, tp) + a.body.slice(head.length) : a.body
      const res = await github.createIssue({ title: a.title, body, labels: a.labels })
      span.setAttribute('mycelium.issue.number', res.number)
      ;(await load()).set(a.fingerprint, { number: res.number, link: spanContextOf(tp) })
      return { issue: res.number, url: res.html_url ?? null }
    } catch (err) {
      span.recordException(/** @type {Error} */ (err))
      span.setStatus({ code: SpanStatusCode.ERROR, message: /** @type {Error} */ (err).message })
      throw err
    } finally {
      span.end()
    }
  }

  return {
    plan,
    apply,
    /** Dry run: treat a planned create as filed (issue 0) so later plans in the pass comment on it. */
    assume: async (/** @type {string} */ fp) => {
      ;(await load()).set(fp, { number: 0, link: null })
    },
    /** Forget the index; the next plan re-reads open intents. */
    reset: () => {
      index = null
    },
  }
}
