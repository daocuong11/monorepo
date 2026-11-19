// @ts-check
import { createHash } from 'node:crypto'
import { cognitoSignIn } from '../cognito.mjs'
import { envelope } from '../envelope.mjs'
import { requestJson } from '../http.mjs'
import { advance, isNew } from '../state.mjs'

/**
 * In-app Report a Bug submissions (SeKtor You > Settings > Report a Bug) from
 * the admin Device Log API. The app files each report as a Device Log with
 * `X-Log-Kind: bug-report`, the note under a `=== USER BUG REPORT ===` header
 * and screenshots as attachments. Clients too old to send the kind leave it
 * null; those are kept only when the body's first line is the header.
 *
 * Read-only: GETs against the API and the presigned body URLs it hands back,
 * plus the Cognito sign-in. Presigned URLs expire, so none is ever put in an
 * envelope; the body says how to fetch fresh ones.
 */

export const DEVICELOG_ENV = /** @type {const} */ ([
  'MYCELIUM_DEVICELOG_API',
  'MYCELIUM_DEVICELOG_POOL_ID',
  'MYCELIUM_DEVICELOG_CLIENT_ID',
  'MYCELIUM_DEVICELOG_USER',
  'MYCELIUM_DEVICELOG_PASSWORD',
  'MYCELIUM_DEVICELOG_TOTP_SECRET',
])
export const DEVICELOG_INTERVAL_MS = 5 * 60_000
export const REPORT_HEADER = '=== USER BUG REPORT ==='
export const CRASH_HEADER = '=== SEKTOR CRASH ==='
const LOGS_HEADER = '=== recent logs ==='
const PAGE = 100
const MAX_PAGES = 100
const TAIL_LINES = 40
const TAIL_CHARS = 4000
const TOKEN_MARGIN_MS = 60_000

const truthy = (/** @type {string | undefined} */ v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim())

/**
 * Every part from the environment; null when one is missing.
 * `_API` is the API base (`VITE_API_BASE_URL`); `/v3` is added unless present.
 *
 * @param {Record<string, string | undefined>} env
 */
export function deviceLogConfig(env = process.env) {
  const [api, userPoolId, clientId, username, password, totpSecret] = DEVICELOG_ENV.map((k) => env[k] ?? '')
  if (!api || !userPoolId || !clientId || !username || !password || !totpSecret) return null
  if (!/^[\w-]+_\w+$/.test(userPoolId))
    throw new Error(`device-logs: MYCELIUM_DEVICELOG_POOL_ID ${userPoolId} is not a user pool id`)
  const base = api.replace(/\/+$/, '')
  return {
    apiBase: base.endsWith('/v3') ? base : `${base}/v3`,
    stage: (env.MYCELIUM_DEVICELOG_STAGE || 'prod').trim(),
    crashes: truthy(env.MYCELIUM_DEVICELOG_CRASHES),
    userPoolId,
    clientId,
    username,
    password,
    totpSecret,
  }
}

/** Emails, bearer/JWT tokens and presigned URLs out of free text. */
export function redact(/** @type {string} */ text) {
  return text
    .replace(/https?:\/\/\S*(?:X-Amz-|Signature=|Expires=)\S*/gi, '[presigned url]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]')
    .replace(/\b(Bearer)\s+\S+/gi, '$1 [token]')
}

/**
 * The report header's parts. The note may span lines; it ends where the
 * fixed `platform:` line begins. Fields are read after the note only, so a
 * note cannot forge them.
 *
 * @param {string} body
 */
export function parseReport(body) {
  const end = body.indexOf(`\n${LOGS_HEADER}`)
  const header = end < 0 ? body.slice(0, 8192) : body.slice(0, end)
  const logs = end < 0 ? '' : body.slice(end + LOGS_HEADER.length + 2)
  const lines = header.split('\n').slice(1)
  const at = lines.findIndex((l) => l.startsWith('note: '))
  let stop = lines.findIndex((l, i) => i > at && /^platform: /.test(l))
  if (stop < 0) stop = lines.length
  const note = at < 0 ? '' : [lines[at].slice(6), ...lines.slice(at + 1, stop)].join('\n').trim()
  const rest = lines.slice(at < 0 ? 0 : stop)
  const field = (/** @type {string} */ name) =>
    rest
      .find((l) => l.startsWith(`${name}: `))
      ?.slice(name.length + 2)
      .trim() || null
  return {
    note,
    platform: field('platform'),
    appVersion: field('appVersion'),
    route: field('route'),
    trail: field('trail'),
    logs,
  }
}

/** The last lines of the log, clipped. */
export function tail(/** @type {string} */ logs) {
  const lines = logs.replace(/\s+$/, '').split('\n').slice(-TAIL_LINES).join('\n')
  return lines.length > TAIL_CHARS ? `…${lines.slice(-TAIL_CHARS)}` : lines
}

/** Strip what varies between two occurrences of one crash. */
const normalize = (/** @type {string} */ line) =>
  line
    .replace(/0x[0-9a-f]+/gi, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\+\s*\d+/g, '')
    .replace(/:\d+(:\d+)?\)?/g, '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * A crash upload's identifying facts: the first `--- crash N ---` block's
 * origin, message and top three frames (`=== SEKTOR CRASH ===` bodies), else
 * the first Exception/Error line and the `at` frames after it.
 *
 * @param {string} body
 */
export function crashFacts(body) {
  const text = body.split(`\n${LOGS_HEADER}`)[0]
  const frame = (/** @type {string} */ l) => /^\s*(at\s|\S+@)/.test(l)
  if (text.startsWith(CRASH_HEADER)) {
    const block = text.split(/^--- crash \d+ ---$/m)[1] ?? ''
    const field = (/** @type {string} */ n) => block.match(new RegExp(`^${n}: (.*)$`, 'm'))?.[1]?.trim() ?? null
    const frames = (block.split(/^stack:$/m)[1] ?? '').split('\n').filter(frame).slice(0, 3)
    return { origin: field('origin'), message: field('message'), frames: frames.map((l) => l.trim()) }
  }
  const lines = text.split('\n')
  const i = lines.findIndex((l) => /[\w.$]+(Exception|Error)\b/.test(l))
  const frames = lines
    .slice(i + 1)
    .filter(frame)
    .slice(0, 3)
    .map((l) => l.trim())
  return { origin: null, message: i < 0 ? null : lines[i].trim(), frames }
}

/** `crash-<platform>-<12 hex>` over the normalized facts. */
export function crashSignature(/** @type {string} */ platform, /** @type {string} */ body) {
  const f = crashFacts(body)
  const material = [f.origin, f.message && normalize(f.message), ...f.frames.map(normalize)].filter(Boolean)
  const hash = createHash('sha256')
    .update(material.length ? material.join('\n') : normalize(body.slice(0, 2000)))
    .digest('hex')
    .slice(0, 12)
  return `crash-${platform}-${hash}`
}

/**
 * Only the summary's fields, never the detail's presigned URLs, and no
 * user detail beyond the opaque id.
 *
 * @param {any} d
 * @param {string} stage
 */
const metaOf = (d, stage) => ({
  stage,
  kind: d.kind ?? null,
  platform: d.platform ?? null,
  deviceModel: d.deviceModel ?? null,
  appVersion: d.appVersion ?? null,
  sessionLocalId: d.sessionLocalId ?? null,
  userId: d.userId ?? null,
})

/** @param {any} detail @param {string} apiBase */
const fetchHow = (detail, apiBase) => {
  const shots = (detail.attachments ?? []).length
  return [
    `Log ${detail.logId}${shots ? ` with ${shots} screenshot${shots === 1 ? '' : 's'}` : ''}.`,
    `Full log${shots ? ' and screenshots' : ''}: GET ${apiBase}/admin/device-logs/${detail.logId} as the log reader;`,
    'it returns fresh presigned downloadUrls (they expire, so none is copied here). Or open the log in the admin console.',
  ].join('\n')
}

/**
 * @param {any} detail AdminGetDeviceLog
 * @param {string} body the log text
 * @param {{ stage: string, apiBase: string }} config
 */
export function reportEnvelope(detail, body, { stage, apiBase }) {
  const r = parseReport(body)
  const platform = detail.platform ?? (r.platform === 'ios' || r.platform === 'android' ? r.platform : null)
  const note = redact(r.note)
  const context = [r.route && `route: ${r.route}`, r.trail && `trail: ${r.trail}`].filter(Boolean).join('\n')
  const logs = tail(redact(r.logs))
  return envelope({
    source: 'device-logs',
    externalId: detail.logId,
    receivedAt: detail.receivedAt,
    author: '',
    title: note.split('\n')[0] || `In-app report (${platform ?? 'unknown'} ${detail.appVersion ?? ''})`.trim(),
    body: [note || '(no note)', redact(context), logs && `--- log tail ---\n${logs}`, fetchHow(detail, apiBase)]
      .filter(Boolean)
      .join('\n\n'),
    url: null,
    meta: {
      ...metaOf({ ...detail, platform, appVersion: detail.appVersion ?? r.appVersion }, stage),
      screenshots: (detail.attachments ?? []).length,
    },
  })
}

/**
 * A crash upload, keyed by its signature so repeats of one crash land on
 * one intent as comments.
 *
 * @param {any} detail
 * @param {string} body
 * @param {{ stage: string, apiBase: string }} config
 */
export function crashEnvelope(detail, body, { stage, apiBase }) {
  const platform = detail.platform ?? 'unknown'
  const signature = crashSignature(platform, body)
  const f = crashFacts(body)
  const what = redact(f.message ?? 'unknown crash')
  return envelope({
    source: 'device-logs',
    externalId: detail.logId,
    receivedAt: detail.receivedAt,
    author: '',
    title: `Crash (${f.origin ?? platform}): ${what.split('\n')[0]}`,
    body: [
      [f.origin && `origin: ${f.origin}`, `message: ${what}`].filter(Boolean).join('\n'),
      f.frames.length ? `top frames:\n${redact(f.frames.join('\n'))}` : '',
      fetchHow(detail, apiBase),
    ]
      .filter(Boolean)
      .join('\n\n'),
    url: null,
    meta: { ...metaOf({ ...detail, platform }, stage), signature },
  })
}

/**
 * @param {{
 *   fetch: import('../http.mjs').Fetch,
 *   config: NonNullable<ReturnType<typeof deviceLogConfig>>,
 *   sleep?: (ms: number) => Promise<void>,
 *   intervalMs?: number,
 * }} ports
 */
export function deviceLogsSource({ fetch, config, sleep, intervalMs = DEVICELOG_INTERVAL_MS }) {
  /** @type {{ token: string, expires: number } | null} */
  let cached = null

  const token = async (/** @type {number} */ now) => {
    if (cached && now < cached.expires) return cached.token
    try {
      const { idToken, expiresInS } = await cognitoSignIn({ fetch, sleep, now: () => now }, config)
      cached = { token: idToken, expires: now + expiresInS * 1000 - TOKEN_MARGIN_MS }
      return idToken
    } catch (err) {
      throw new Error(`device-logs: ${/** @type {Error} */ (err).message}`)
    }
  }

  /** @param {string} path @param {number} now */
  const get = async (path, now) => {
    try {
      return await requestJson({ fetch, sleep, label: 'device-logs' }, `${config.apiBase}${path}`, {
        method: 'GET',
        headers: { Authorization: await token(now), Accept: 'application/json' },
      })
    } catch (err) {
      if (/: 40[13] /.test(/** @type {Error} */ (err).message)) cached = null
      throw err
    }
  }

  /** A presigned URL carries its own auth; its text is never logged. */
  const download = async (/** @type {string} */ url, /** @type {string} */ logId) => {
    const res = await fetch(url, { method: 'GET' })
    if (res.status >= 400) throw new Error(`device-logs: ${res.status} downloading the body of ${logId}`)
    return res.text()
  }

  /**
   * Every log at or after `from`, through `nextCursor` to the end.
   *
   * @param {number} from @param {number} now @param {string} [kind]
   * @returns {Promise<any[]>}
   */
  const list = async (from, now, kind) => {
    const out = []
    let cursor = ''
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES)
        throw new Error(`device-logs: more than ${MAX_PAGES} pages since ${new Date(from).toISOString()}`)
      const q = new URLSearchParams({ from: new Date(from).toISOString(), limit: String(PAGE) })
      if (kind) q.set('kind', kind)
      if (cursor) q.set('cursor', cursor)
      const body = await get(`/admin/device-logs?${q}`, now)
      if (!Array.isArray(body?.items)) throw new Error('device-logs: the list response has no items')
      out.push(...body.items)
      cursor = body.nextCursor ?? ''
      if (!cursor) return out
    }
  }

  return {
    name: 'device-logs',
    intervalMs,
    /**
     * @param {import('../state.mjs').TimeCursor | null} cursor
     * @param {{ now: number, since: number }} at
     */
    async pull(cursor, { now, since }) {
      const from = cursor ?? { at: since, ids: [] }
      const listed = [
        ...(await list(from.at, now, 'bug-report')),
        ...(config.crashes ? await list(from.at, now, 'crash') : []),
        ...(await list(from.at, now)).filter((l) => l?.kind === null || l?.kind === undefined),
      ]
      /** @type {Map<string, { at: number, logId: string }>} */
      const fresh = new Map()
      for (const l of listed) {
        const t = Date.parse(l?.receivedAt ?? '')
        if (typeof l?.logId !== 'string' || !Number.isFinite(t)) continue
        if (t >= from.at && isNew(from, t, l.logId)) fresh.set(l.logId, { at: t, logId: l.logId })
      }
      const sorted = [...fresh.values()].sort((a, b) => a.at - b.at || a.logId.localeCompare(b.logId))
      const out = []
      let c = from
      for (const { at, logId } of sorted) {
        const detail = await get(`/admin/device-logs/${encodeURIComponent(logId)}`, now)
        const body = typeof detail?.downloadUrl === 'string' ? await download(detail.downloadUrl, logId) : ''
        const kind = detail?.kind ?? null
        /** @type {import('../envelope.mjs').Envelope | null} */
        let e = null
        if (
          kind === 'bug-report' ||
          (kind === null && (body === REPORT_HEADER || body.startsWith(`${REPORT_HEADER}\n`)))
        )
          e = reportEnvelope({ ...detail, receivedAt: detail.receivedAt ?? new Date(at).toISOString() }, body, config)
        else if (kind === 'crash' && config.crashes)
          e = crashEnvelope({ ...detail, receivedAt: detail.receivedAt ?? new Date(at).toISOString() }, body, config)
        c = advance(c, at, logId)
        out.push({ envelope: e, cursor: c })
      }
      return out
    },
  }
}
