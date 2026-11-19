// @ts-check
import { createHash } from 'node:crypto'
import { envelope } from '../envelope.mjs'
import { requestJson } from '../http.mjs'
import { ascJwt } from '../jwt.mjs'
import { isNew, ordered } from '../state.mjs'
import { ASC_BASE } from './asc.mjs'

export const TESTFLIGHT_INTERVAL_MS = 15 * 60_000
const PAGE = 200
const MAX_PAGES = 10
/** Crash log characters kept in an envelope; the rest is clipped. */
export const LOG_MAX = 8_000
const FRAMES = 3

/** @typedef {'feedback' | 'crash'} Feed */
/** @typedef {{ feedback: import('../state.mjs').TimeCursor, crash: import('../state.mjs').TimeCursor }} TestflightCursor */

const FEED_PATH = {
  feedback: 'betaFeedbackScreenshotSubmissions',
  crash: 'betaFeedbackCrashSubmissions',
}

export const feedPath = (/** @type {string} */ appId, /** @type {Feed} */ feed) =>
  `/v1/apps/${appId}/${FEED_PATH[feed]}?sort=-createdDate&limit=${PAGE}&include=build&fields[builds]=version`

export const crashLogPath = (/** @type {string} */ id) => `/v1/betaFeedbackCrashSubmissions/${id}/crashLog`

// ---- crash signature -------------------------------------------------------

/** Lowercase, addresses and numbers to placeholders, whitespace collapsed. */
const normalize = (/** @type {string} */ s) =>
  s
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '0x?')
    .replace(/\b\d+\b/g, 'n')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * One backtrace line (`3   MyApp   0x0000000102f4c0dc  Foo.bar() + 120 (Foo.swift:42)`)
 * as `image symbol`: index, addresses, offsets and source locations stripped.
 * An unsymbolicated frame (`MyApp 0x... 0x100000000 + 12345`) keeps the image only.
 *
 * @param {string} line
 */
export function normalizeFrame(line) {
  const m = /^\s*\d+\s+(\S+)\s+0x[0-9a-fA-F]+\s*(.*)$/.exec(line)
  if (!m) return null
  const symbol = m[2]
    .replace(/\s*\([^()]*:\d+\)\s*$/, '')
    .replace(/\s*\+\s*\d+\s*$/, '')
    .replace(/^0x[0-9a-fA-F]+$/, '')
    .trim()
  return normalize(symbol ? `${m[1]} ${symbol}` : m[1])
}

/**
 * The parts a crash signature hashes, from an Apple text crash report:
 * exception type, exception reason (or termination reason), and the top
 * three frames of the last exception backtrace, else of the crashed thread.
 *
 * @param {string} logText
 */
export function crashParts(logText) {
  const lines = String(logText ?? '').split(/\r?\n/)
  const field = (/** @type {RegExp} */ re) => {
    for (const l of lines) {
      const m = re.exec(l)
      if (m) return m[1].trim()
    }
    return ''
  }
  const type = field(/^Exception Type:\s*(.*)$/)
  const reason = field(/^Exception Reason:\s*(.*)$/) || field(/^Termination Reason:\s*(.*)$/)
  const start = (() => {
    const last = lines.findIndex((l) => /^Last Exception Backtrace:/.test(l))
    return last >= 0 ? last : lines.findIndex((l) => /^Thread \d+(?: name:.*)? Crashed:/.test(l))
  })()
  /** @type {string[]} */
  const frames = []
  if (start >= 0) {
    for (const l of lines.slice(start + 1)) {
      if (!l.trim()) break
      const f = normalizeFrame(l)
      if (f) frames.push(f)
      if (frames.length === FRAMES) break
    }
  }
  return { type: normalize(type), reason: normalize(reason), frames, display: { type, reason } }
}

/**
 * 16 hex chars of sha256 over the normalized type, reason and top frames;
 * null when the log has none of them (such a crash is its own intent).
 *
 * @param {string} logText
 */
export function crashSignature(logText) {
  const p = crashParts(logText)
  if (!p.type && !p.reason && p.frames.length === 0) return null
  return createHash('sha256')
    .update([p.type, p.reason, ...p.frames].join('\n'))
    .digest('hex')
    .slice(0, 16)
}

// ---- envelopes -------------------------------------------------------------

/** @param {string} text */
export function clip(text, max = LOG_MAX) {
  return text.length > max ? `${text.slice(0, max)}\n[clipped: ${text.length - max} more characters]` : text
}

/**
 * Build version from the `included` builds of a page.
 *
 * @param {any} body
 */
function buildVersions(body) {
  /** @type {Map<string, string>} */
  const m = new Map()
  for (const i of body?.included ?? []) if (i?.type === 'builds') m.set(i.id, i.attributes?.version ?? '')
  return m
}

/**
 * Device and build facts every TestFlight envelope carries. The tester's
 * email is never read.
 *
 * @param {any} a
 * @param {string | null} build
 * @param {string} appId
 */
const deviceMeta = (a, build, appId) => ({
  appId,
  build,
  deviceModel: a.deviceModel ?? null,
  osVersion: a.osVersion ?? null,
  devicePlatform: a.devicePlatform ?? null,
  locale: a.locale ?? null,
})

/**
 * @param {any} sub a betaFeedbackScreenshotSubmissions resource
 * @param {string} appId
 * @param {string | null} build
 */
export function feedbackEnvelope(sub, appId, build) {
  const a = sub?.attributes ?? {}
  const shots = Array.isArray(a.screenshots) ? a.screenshots : []
  const comment = String(a.comment ?? '').trim()
  const body = [
    comment || '(no comment)',
    shots.length
      ? [
          `Screenshots (${shots.length}). These are Apple's signed URLs and they expire${
            shots[0]?.expirationDate ? ` (${shots[0].expirationDate})` : ''
          }; open them in App Store Connect after that.`,
          ...shots.map((/** @type {any} */ s) => `- ${s?.url ?? ''}`),
        ].join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  return envelope({
    source: 'testflight',
    externalId: sub?.id,
    receivedAt: a.createdDate,
    author: '',
    title: comment ? '' : 'TestFlight feedback',
    body,
    url: null,
    meta: { kind: 'feedback', ...deviceMeta(a, build, appId), screenshots: shots.length },
  })
}

/**
 * @param {any} sub a betaFeedbackCrashSubmissions resource
 * @param {string} appId
 * @param {string | null} build
 * @param {string} logText
 */
export function crashEnvelope(sub, appId, build, logText) {
  const a = sub?.attributes ?? {}
  const p = crashParts(logText)
  const signature = crashSignature(logText)
  const comment = String(a.comment ?? '').trim()
  const what = [p.display.type, p.display.reason].filter(Boolean).join(': ')
  const body = [
    comment ? `Tester comment:\n${comment}` : '',
    p.frames.length ? `Top frames:\n${p.frames.map((f) => `  ${f}`).join('\n')}` : '',
    logText ? `Crash log:\n${clip(logText)}` : '(no crash log)',
  ]
    .filter(Boolean)
    .join('\n\n')
  return envelope({
    source: 'testflight',
    externalId: sub?.id,
    receivedAt: a.createdDate,
    author: '',
    title: `Crash: ${what || comment || 'TestFlight crash'}`,
    body,
    url: null,
    meta: { kind: 'crash', signature, ...deviceMeta(a, build, appId) },
  })
}

// ---- source ----------------------------------------------------------------

/**
 * TestFlight beta feedback: tester comments with screenshots, and the crashes
 * testers choose to send, from the same App Store Connect key as `asc`. Both
 * feeds are newest first from Apple; each keeps its own time cursor, and the
 * envelopes come back oldest first across the two. Read-only: GET only.
 *
 * @param {{
 *   fetch: import('../http.mjs').Fetch,
 *   config: NonNullable<ReturnType<typeof import('./asc.mjs').ascConfig>>,
 *   sleep?: (ms: number) => Promise<void>,
 *   intervalMs?: number,
 * }} ports
 */
export function testflightSource({ fetch, config, sleep, intervalMs = TESTFLIGHT_INTERVAL_MS }) {
  const get = (/** @type {string} */ url, /** @type {number} */ now) =>
    requestJson({ fetch, sleep, label: 'testflight' }, url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ascJwt(config, now)}` },
    })

  /**
   * The new submissions of one feed past its cursor, with their build version.
   *
   * @param {Feed} feed
   * @param {import('../state.mjs').TimeCursor} from
   * @param {number} now
   */
  const scan = async (feed, from, now) => {
    /** @type {{ at: number, sub: any, build: string | null }[]} */
    const found = []
    let url = `${ASC_BASE}${feedPath(config.appId, feed)}`
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const body = await get(url, now)
      if (!Array.isArray(body?.data)) throw new Error(`testflight: the ${feed} response is not a list`)
      const builds = buildVersions(body)
      let older = false
      for (const s of body.data) {
        const t = Date.parse(s?.attributes?.createdDate ?? '')
        if (t < from.at) {
          older = true
          break
        }
        const buildId = s?.relationships?.build?.data?.id
        if (isNew(from, t, s.id)) found.push({ at: t, sub: s, build: (buildId && builds.get(buildId)) || null })
      }
      url = older ? '' : (body.links?.next ?? '')
    }
    return found
  }

  return {
    name: 'testflight',
    intervalMs,
    /**
     * @param {TestflightCursor | null} cursor
     * @param {{ now: number, since: number }} at
     */
    async pull(cursor, { now, since }) {
      const start = { at: since, ids: [] }
      const from = { feedback: cursor?.feedback ?? start, crash: cursor?.crash ?? start }

      const feedback = ordered(
        (await scan('feedback', from.feedback, now)).map((f) => ({
          at: f.at,
          envelope: feedbackEnvelope(f.sub, config.appId, f.build),
        })),
        from.feedback,
      )
      /** @type {{ at: number, envelope: import('../envelope.mjs').Envelope }[]} */
      const crashes = []
      for (const f of await scan('crash', from.crash, now)) {
        const log = await get(`${ASC_BASE}${crashLogPath(f.sub.id)}`, now)
        const logText = String(log?.data?.attributes?.logText ?? '')
        crashes.push({ at: f.at, envelope: crashEnvelope(f.sub, config.appId, f.build, logText) })
      }
      const crash = ordered(crashes, from.crash)

      // Merge oldest first; each item carries both feeds' cursors as they
      // stand once it is filed.
      const tagged = [
        ...feedback.map((i) => ({ feed: /** @type {Feed} */ ('feedback'), ...i })),
        ...crash.map((i) => ({ feed: /** @type {Feed} */ ('crash'), ...i })),
      ].sort(
        (a, b) =>
          Date.parse(a.envelope.receivedAt) - Date.parse(b.envelope.receivedAt) ||
          a.envelope.externalId.localeCompare(b.envelope.externalId),
      )
      /** @type {TestflightCursor} */
      let c = from
      return tagged.map((i) => {
        c = { ...c, [i.feed]: i.cursor }
        return { envelope: i.envelope, cursor: c }
      })
    },
  }
}
