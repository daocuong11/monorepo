// @ts-check
import { envelope } from '../envelope.mjs'
import { requestJson } from '../http.mjs'
import { ascJwt } from '../jwt.mjs'
import { isNew, ordered } from '../state.mjs'

export const ASC_BASE = 'https://api.appstoreconnect.apple.com'
export const ASC_ENV = /** @type {const} */ ([
  'MYCELIUM_ASC_KEY_ID',
  'MYCELIUM_ASC_ISSUER_ID',
  'MYCELIUM_ASC_KEY_P8',
  'MYCELIUM_ASC_APP_ID',
])
export const ASC_INTERVAL_MS = 15 * 60_000
const PAGE = 200
const MAX_PAGES = 10

/**
 * The key from the environment; `_KEY_P8` is the `.p8` PEM or its base64.
 * Null when any part is missing.
 *
 * @param {Record<string, string | undefined>} env
 */
export function ascConfig(env = process.env) {
  const [keyId, issuerId, p8, appId] = ASC_ENV.map((k) => env[k] ?? '')
  if (!keyId || !issuerId || !p8 || !appId) return null
  const privateKey = p8.includes('BEGIN PRIVATE KEY') ? p8 : Buffer.from(p8, 'base64').toString()
  return { keyId, issuerId, privateKey, appId }
}

export const reviewsPath = (/** @type {string} */ appId) =>
  `/v1/apps/${appId}/customerReviews?sort=-createdDate&limit=${PAGE}&fields[customerReviews]=rating,title,body,reviewerNickname,createdDate,territory`

/**
 * @param {any} review
 * @param {string} appId
 */
export function reviewEnvelope(review, appId) {
  const a = review?.attributes ?? {}
  return envelope({
    source: 'asc',
    externalId: review?.id,
    receivedAt: a.createdDate,
    author: a.reviewerNickname ?? '',
    title: a.title ?? '',
    body: a.body ?? '',
    url: null,
    meta: { appId, rating: a.rating ?? null, territory: a.territory ?? null },
  })
}

/**
 * App Store Connect customer reviews, newest first from Apple, returned
 * oldest first past the cursor. Read-only: GET is the one method sent.
 *
 * @param {{
 *   fetch: import('../http.mjs').Fetch,
 *   config: NonNullable<ReturnType<typeof ascConfig>>,
 *   sleep?: (ms: number) => Promise<void>,
 *   intervalMs?: number,
 * }} ports
 */
export function ascSource({ fetch, config, sleep, intervalMs = ASC_INTERVAL_MS }) {
  const get = (/** @type {string} */ url, /** @type {number} */ now) =>
    requestJson({ fetch, sleep, label: 'asc' }, url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ascJwt(config, now)}` },
    })

  return {
    name: 'asc',
    intervalMs,
    /**
     * @param {import('../state.mjs').TimeCursor | null} cursor
     * @param {{ now: number, since: number }} at
     */
    async pull(cursor, { now, since }) {
      const from = cursor ?? { at: since, ids: [] }
      /** @type {{ at: number, envelope: import('../envelope.mjs').Envelope }[]} */
      const found = []
      let url = `${ASC_BASE}${reviewsPath(config.appId)}`
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const body = await get(url, now)
        if (!Array.isArray(body?.data)) throw new Error('asc: the reviews response is not a list')
        let older = false
        for (const r of body.data) {
          const t = Date.parse(r?.attributes?.createdDate ?? '')
          if (t < from.at) {
            older = true
            break
          }
          if (isNew(from, t, r.id)) found.push({ at: t, envelope: reviewEnvelope(r, config.appId) })
        }
        url = older ? '' : (body.links?.next ?? '')
      }
      return ordered(found, from)
    },
  }
}
