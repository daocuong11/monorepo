// @ts-check
import { createPrivateKey, sign } from 'node:crypto'

const b64u = (/** @type {string | Buffer} */ b) => Buffer.from(b).toString('base64url')

/**
 * @param {'ES256' | 'RS256'} alg
 * @param {Record<string, unknown>} header
 * @param {Record<string, unknown>} claims
 * @param {string} keyPem
 */
export function signJwt(alg, header, claims, keyPem) {
  const head = b64u(JSON.stringify({ alg, ...header, typ: 'JWT' }))
  const body = b64u(JSON.stringify(claims))
  const input = Buffer.from(`${head}.${body}`)
  const key = createPrivateKey(keyPem)
  // JWS wants ES256 as raw r‖s, not the DER Node emits by default.
  const sig = alg === 'ES256' ? sign('sha256', input, { key, dsaEncoding: 'ieee-p1363' }) : sign('sha256', input, key)
  return `${head}.${body}.${b64u(sig)}`
}

/** Apple refuses an App Store Connect token that lives longer than 20 minutes. */
export const ASC_TOKEN_TTL_S = 15 * 60

/**
 * @param {{ keyId: string, issuerId: string, privateKey: string }} creds
 * @param {number} nowMs
 */
export function ascJwt(creds, nowMs) {
  const iat = Math.floor(nowMs / 1000)
  return signJwt(
    'ES256',
    { kid: creds.keyId },
    { iss: creds.issuerId, iat, exp: iat + ASC_TOKEN_TTL_S, aud: 'appstoreconnect-v1' },
    creds.privateKey,
  )
}

export const PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher'

/**
 * @param {{ client_email: string, private_key: string, token_uri: string }} account
 * @param {number} nowMs
 */
export function playAssertion(account, nowMs) {
  const iat = Math.floor(nowMs / 1000)
  return signJwt(
    'RS256',
    {},
    { iss: account.client_email, scope: PLAY_SCOPE, aud: account.token_uri, iat, exp: iat + 3600 },
    account.private_key,
  )
}
