// @ts-check
import { readFileSync } from 'node:fs'
import { envelope } from '../envelope.mjs'
import { requestJson } from '../http.mjs'
import { PLAY_SCOPE, playAssertion } from '../jwt.mjs'
import { isNew, ordered } from '../state.mjs'

export const PLAY_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3'
export const PLAY_ENV = /** @type {const} */ ([
  'MYCELIUM_PLAY_PACKAGE',
  'MYCELIUM_PLAY_KEY_JSON',
  'MYCELIUM_PLAY_KEY_PATH',
])
/** Play meters API calls per method per app; reviews are not urgent enough to spend more. */
export const PLAY_INTERVAL_MS = 30 * 60_000
const TOKEN_MARGIN_MS = 60_000
const MAX_PAGES = 10

/**
 * The package name and a service-account key (inline JSON, or a path to
 * it). Null when either is missing.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(path: string) => string} [read]
 */
export function playConfig(env = process.env, read = (p) => readFileSync(p, 'utf8')) {
  const packageName = env.MYCELIUM_PLAY_PACKAGE ?? ''
  const raw = env.MYCELIUM_PLAY_KEY_JSON || (env.MYCELIUM_PLAY_KEY_PATH ? read(env.MYCELIUM_PLAY_KEY_PATH) : '')
  if (!packageName || !raw) return null
  const key = JSON.parse(raw)
  for (const k of ['client_email', 'private_key', 'token_uri'])
    if (typeof key[k] !== 'string') throw new Error(`play: the service-account key has no ${k}`)
  return { packageName, account: /** @type {{ client_email: string, private_key: string, token_uri: string }} */ (key) }
}

export const reviewsPath = (/** @type {string} */ pkg, /** @type {string} */ token = '') =>
  `/applications/${pkg}/reviews?maxResults=100${token ? `&token=${encodeURIComponent(token)}` : ''}`

/** @param {{ seconds?: string | number, nanos?: number } | undefined} t */
const ms = (t) => Number(t?.seconds ?? Number.NaN) * 1000 + Math.floor(Number(t?.nanos ?? 0) / 1e6)

/**
 * The review's latest user comment; Play returns only reviews modified in
 * the last week, and an edit changes `lastModified`, not `reviewId`.
 *
 * @param {any} review
 * @param {string} packageName
 */
export function reviewEnvelope(review, packageName) {
  const user = (review?.comments ?? []).find((/** @type {any} */ c) => c?.userComment)?.userComment ?? {}
  return envelope({
    source: 'play',
    externalId: review?.reviewId,
    receivedAt: new Date(ms(user.lastModified)).toISOString(),
    author: review?.authorName ?? '',
    title: '',
    body: String(user.text ?? '').trim(),
    url: null,
    meta: {
      packageName,
      rating: user.starRating ?? null,
      appVersion: user.appVersionName ?? null,
      language: user.reviewerLanguage ?? null,
      device: user.device ?? null,
    },
  })
}

/**
 * A cached OAuth access token for a Google service account: the JWT-bearer
 * exchange, minted again a minute before it expires.
 *
 * @param {{
 *   fetch: import('../http.mjs').Fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   account: { client_email: string, private_key: string, token_uri: string },
 *   scope?: string,
 *   label: string,
 * }} ports
 * @returns {(now: number) => Promise<string>}
 */
export function googleToken({ fetch, sleep, account, scope = PLAY_SCOPE, label }) {
  /** @type {{ token: string, expires: number } | null} */
  let cached = null
  return async (now) => {
    if (cached && now < cached.expires) return cached.token
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: playAssertion(account, now, scope),
    }).toString()
    const minted = await requestJson({ fetch, sleep, label: `${label} token` }, account.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (typeof minted?.access_token !== 'string') throw new Error(`${label}: no access token`)
    const ttl = (Number(minted.expires_in) || 3600) * 1000
    cached = { token: minted.access_token, expires: now + ttl - TOKEN_MARGIN_MS }
    return cached.token
  }
}

/**
 * Google Play reviews. The token exchange is a POST to Google's OAuth
 * endpoint; Play itself is only sent GETs.
 *
 * @param {{
 *   fetch: import('../http.mjs').Fetch,
 *   config: NonNullable<ReturnType<typeof playConfig>>,
 *   sleep?: (ms: number) => Promise<void>,
 *   intervalMs?: number,
 * }} ports
 */
export function playSource({ fetch, config, sleep, intervalMs = PLAY_INTERVAL_MS }) {
  const token = googleToken({ fetch, sleep, account: config.account, label: 'play' })

  return {
    name: 'play',
    intervalMs,
    /**
     * @param {import('../state.mjs').TimeCursor | null} cursor
     * @param {{ now: number, since: number }} at
     */
    async pull(cursor, { now, since }) {
      const from = cursor ?? { at: since, ids: [] }
      /** @type {{ at: number, envelope: import('../envelope.mjs').Envelope }[]} */
      const found = []
      let next = ''
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await requestJson(
          { fetch, sleep, label: 'play' },
          `${PLAY_BASE}${reviewsPath(config.packageName, next)}`,
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${await token(now)}` },
          },
        )
        for (const r of body?.reviews ?? []) {
          const e = reviewEnvelope(r, config.packageName)
          const t = Date.parse(e.receivedAt)
          if (t >= from.at && isNew(from, t, e.externalId)) found.push({ at: t, envelope: e })
        }
        next = body?.tokenPagination?.nextPageToken ?? ''
        if (!next) break
      }
      return ordered(found, from)
    },
  }
}
