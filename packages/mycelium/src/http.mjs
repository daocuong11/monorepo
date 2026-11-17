// @ts-check

/**
 * @typedef {(url: string, init: any) => Promise<{ status: number, headers?: { get: (k: string) => string | null }, text: () => Promise<string> }>} Fetch
 */

export const RETRIES = 3

const defaultSleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One JSON request. A 429 waits out `Retry-After` (header, else a JSON
 * `retry_after`) and repeats; any other status ≥ 400 throws with the first
 * 200 chars of the body, which is where every one of these APIs names the
 * reason.
 *
 * @param {{ fetch: Fetch, sleep?: (ms: number) => Promise<void>, label: string }} ports
 * @param {string} url
 * @param {any} [init]
 */
export async function requestJson({ fetch, sleep = defaultSleep, label }, url, init = { method: 'GET' }) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init)
    const text = await res.text()
    if (res.status === 429 && attempt < RETRIES) {
      let json = null
      try {
        json = JSON.parse(text)
      } catch {}
      const header = Number(res.headers?.get('retry-after') ?? Number.NaN)
      const secs = Number.isFinite(header) ? header : Number(json?.retry_after ?? 1)
      await sleep(Math.max(0, secs) * 1000)
      continue
    }
    if (res.status >= 400) throw new Error(`${label}: ${res.status} ${text.slice(0, 200)}`)
    return text ? JSON.parse(text) : null
  }
}
