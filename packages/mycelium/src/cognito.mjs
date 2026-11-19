// @ts-check
import { createHash, createHmac, getDiffieHellman, randomBytes } from 'node:crypto'

/**
 * Cognito user-pool sign-in over node:crypto: USER_SRP_AUTH (the flow the
 * SeKtor app clients enable), then the SOFTWARE_TOKEN_MFA challenge answered
 * with a TOTP code. Resolves to the id token, which is what an API Gateway
 * Cognito authorizer reads.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32; padding, spaces and lowercase tolerated. */
export function base32Decode(/** @type {string} */ input) {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const i = BASE32.indexOf(ch)
    if (i < 0) throw new Error(`totp: ${JSON.stringify(ch)} is not base32`)
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return Buffer.from(out)
}

/**
 * RFC 6238 TOTP as Cognito uses it: SHA-1, 30 s step; zero-padded.
 *
 * @param {string} secret base32
 * @param {number} nowMs
 * @param {number} [digits]
 */
export function totp(secret, nowMs, digits = 6) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)))
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const o = h[h.length - 1] & 0x0f
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

// The RFC 3526 3072-bit group Cognito's SRP runs over, g = 2.
export const N = BigInt(`0x${getDiffieHellman('modp15').getPrime('hex')}`)
export const g = 2n

/** @param {bigint} base @param {bigint} exp @param {bigint} mod */
export function modPow(base, exp, mod) {
  let result = 1n
  let b = ((base % mod) + mod) % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return result
}

/** Cognito's hex encoding: even length, and a leading 00 when the top bit is set. */
export function padHex(/** @type {bigint} */ n) {
  let h = n.toString(16)
  if (h.length % 2) h = `0${h}`
  return /^[89a-f]/.test(h) ? `00${h}` : h
}

export const hexHash = (/** @type {string} */ hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex')
export const k = BigInt(`0x${hexHash(padHex(N) + padHex(g))}`)

/** x = H(salt ‖ H(poolName ‖ userId ‖ ':' ‖ password)) */
export function passwordX(
  /** @type {string} */ poolName,
  /** @type {string} */ userId,
  /** @type {string} */ password,
  /** @type {string} */ saltHex,
) {
  const inner = createHash('sha256').update(`${poolName}${userId}:${password}`).digest('hex')
  return BigInt(`0x${hexHash(padHex(BigInt(`0x${saltHex}`)) + inner)}`)
}

/** HKDF-SHA256 to 16 bytes, info "Caldera Derived Key". */
export function hkdf(/** @type {bigint} */ S, /** @type {bigint} */ u) {
  const prk = createHmac('sha256', Buffer.from(padHex(u), 'hex'))
    .update(Buffer.from(padHex(S), 'hex'))
    .digest()
  const info = Buffer.concat([Buffer.from('Caldera Derived Key'), Buffer.from([1])])
  return createHmac('sha256', prk).update(info).digest().subarray(0, 16)
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (/** @type {number} */ n) => String(n).padStart(2, '0')

/** `Tue Nov 9 06:58:29 UTC 2026`: the day unpadded, as Cognito expects. */
export function srpTimestamp(/** @type {number} */ ms) {
  const d = new Date(ms)
  const time = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${time} UTC ${d.getUTCFullYear()}`
}

/** @param {Buffer} key @param {string} poolName @param {string} userId @param {string} secretBlock @param {string} timestamp */
export const claimSignature = (key, poolName, userId, secretBlock, timestamp) =>
  createHmac('sha256', key)
    .update(
      Buffer.concat([
        Buffer.from(poolName),
        Buffer.from(userId),
        Buffer.from(secretBlock, 'base64'),
        Buffer.from(timestamp),
      ]),
    )
    .digest('base64')

/** Refused by Cognito: the message is what goes in the log line. */
export class SignInError extends Error {}

/** Cognito refuses a code it already accepted for the rest of its window. */
const CODE_REUSED = /already been used/i
const WINDOW_MS = 31_000

/**
 * @param {{
 *   fetch: import('./http.mjs').Fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   random?: (n: number) => Buffer,
 * }} ports
 * @param {{ userPoolId: string, clientId: string, username: string, password: string, totpSecret: string }} input
 * @returns {Promise<{ idToken: string, expiresInS: number }>}
 */
export async function cognitoSignIn(ports, input) {
  const { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = ports
  try {
    return await attempt(ports, input)
  } catch (err) {
    if (!(err instanceof SignInError) || !CODE_REUSED.test(err.message)) throw err
    await sleep(WINDOW_MS)
    return attempt(ports, input)
  }
}

/** @param {Parameters<typeof cognitoSignIn>[0]} ports @param {Parameters<typeof cognitoSignIn>[1]} input */
async function attempt({ fetch, now = Date.now, random = randomBytes }, input) {
  const [region, poolName] = input.userPoolId.split('_')
  if (!region || !poolName) throw new SignInError(`sign-in: ${input.userPoolId} is not a user pool id`)
  const url = `https://cognito-idp.${region}.amazonaws.com/`
  /** @param {string} op @param {Record<string, unknown>} body */
  const call = async (op, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${op}`,
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    /** @type {any} */
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    if (res.status >= 400) {
      const type =
        String(json?.__type ?? '')
          .split('#')
          .pop() || `HTTP ${res.status}`
      const message = json?.message ?? json?.Message ?? text.slice(0, 200)
      throw new SignInError(`sign-in refused: ${type}: ${message}`)
    }
    return json
  }

  let a = 0n
  let A = 0n
  while (A === 0n) {
    a = BigInt(`0x${random(128).toString('hex')}`) % N
    A = modPow(g, a, N)
  }
  const init = await call('InitiateAuth', {
    AuthFlow: 'USER_SRP_AUTH',
    ClientId: input.clientId,
    AuthParameters: { USERNAME: input.username, SRP_A: A.toString(16) },
  })
  if (init?.ChallengeName !== 'PASSWORD_VERIFIER')
    throw new SignInError(`sign-in: expected PASSWORD_VERIFIER, got ${init?.ChallengeName ?? 'nothing'}`)
  const p = init.ChallengeParameters ?? {}
  const B = BigInt(`0x${p.SRP_B}`)
  if (B % N === 0n) throw new SignInError('sign-in: Cognito sent an invalid SRP_B')
  const userId = String(p.USER_ID_FOR_SRP ?? input.username)
  const u = BigInt(`0x${hexHash(padHex(A) + padHex(B))}`)
  const x = passwordX(poolName, userId, input.password, p.SALT)
  const S = modPow(B - k * modPow(g, x, N), a + u * x, N)
  const timestamp = srpTimestamp(now())
  /** @type {any} */
  let step = await call('RespondToAuthChallenge', {
    ChallengeName: 'PASSWORD_VERIFIER',
    ClientId: input.clientId,
    ...(init.Session ? { Session: init.Session } : {}),
    ChallengeResponses: {
      USERNAME: userId,
      PASSWORD_CLAIM_SECRET_BLOCK: p.SECRET_BLOCK,
      TIMESTAMP: timestamp,
      PASSWORD_CLAIM_SIGNATURE: claimSignature(hkdf(S, u), poolName, userId, p.SECRET_BLOCK, timestamp),
    },
  })
  if (step?.ChallengeName === 'SOFTWARE_TOKEN_MFA') {
    step = await call('RespondToAuthChallenge', {
      ChallengeName: 'SOFTWARE_TOKEN_MFA',
      ClientId: input.clientId,
      Session: step.Session,
      ChallengeResponses: { USERNAME: userId, SOFTWARE_TOKEN_MFA_CODE: totp(input.totpSecret, now()) },
    })
  }
  const result = step?.AuthenticationResult
  if (typeof result?.IdToken !== 'string')
    throw new SignInError(`sign-in: Cognito asked for ${step?.ChallengeName ?? 'nothing'} and issued no token`)
  return { idToken: result.IdToken, expiresInS: Number(result.ExpiresIn) || 3600 }
}
