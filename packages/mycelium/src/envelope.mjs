// @ts-check
import { createHash } from 'node:crypto'

/**
 * @typedef {{
 *   source: string,
 *   externalId: string,
 *   receivedAt: string,
 *   author: string,
 *   title: string,
 *   body: string,
 *   url: string | null,
 *   meta: Record<string, unknown>,
 * }} Envelope
 */

const REQUIRED = /** @type {const} */ (['source', 'externalId', 'receivedAt'])

/**
 * @param {Partial<Envelope>} fields
 * @returns {Envelope}
 */
export function envelope(fields) {
  for (const k of REQUIRED) if (!fields[k]) throw new Error(`envelope: ${k} is required`)
  const at = Date.parse(String(fields.receivedAt))
  if (!Number.isFinite(at)) throw new Error(`envelope: receivedAt ${fields.receivedAt} is not a date`)
  return {
    source: String(fields.source),
    externalId: String(fields.externalId).trim(),
    receivedAt: new Date(at).toISOString(),
    author: String(fields.author ?? ''),
    title: String(fields.title ?? '').trim(),
    body: String(fields.body ?? ''),
    url: fields.url ? String(fields.url) : null,
    meta: { ...(fields.meta ?? {}) },
  }
}

/**
 * The source-specific identity a fingerprint hashes. Two envelopes with the
 * same identity are the same intent: the later one becomes a comment.
 *
 * - discord: `<channelId>/<rootId>`, the root being the forum thread, the
 *   message a reply points at, or else the message itself.
 * - asc: `<appId>/<reviewId>`.
 * - play: `<packageName>/<reviewId>`; an edited review keeps its id.
 * - testflight: feedback `<appId>/<submissionId>`; a crash
 *   `<appId>/crash/<signature>`, so repeats of one crash land as comments
 *   (a crash whose log yields no signature is keyed on its submission id).
 *
 * @type {Record<string, (e: Envelope) => string>}
 */
export const IDENTITY = {
  discord: (e) => `${e.meta.channelId}/${e.meta.rootId ?? e.externalId}`,
  asc: (e) => `${e.meta.appId}/${e.externalId}`,
  play: (e) => `${e.meta.packageName}/${e.externalId}`,
  testflight: (e) =>
    e.meta.kind === 'crash'
      ? `${e.meta.appId}/crash/${e.meta.signature ?? `submission-${e.externalId}`}`
      : `${e.meta.appId}/${e.externalId}`,
}

/** @param {Envelope} e */
export function identity(e) {
  const of = IDENTITY[e.source]
  if (!of) throw new Error(`fingerprint: no identity rule for source ${e.source}`)
  return `${e.source}:${of(e)}`.trim().toLowerCase()
}

/**
 * First 24 hex chars of sha256 over the normalized identity.
 *
 * @param {Envelope} e
 */
export function fingerprint(e) {
  return createHash('sha256').update(identity(e)).digest('hex').slice(0, 24)
}
