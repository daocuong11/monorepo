// @ts-check
import { readFileSync } from 'node:fs'
import { fingerprintOf } from '../src/intake.mjs'

export const fixture = (/** @type {string} */ name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

/**
 * A recorded-response fetch. `route` answers each request with a body (sent
 * as 200 JSON) or `{ status, body, headers }`; every call is kept.
 *
 * @param {(url: string, init: any) => any} route
 */
export function fakeFetch(route) {
  /** @type {{ url: string, init: any }[]} */
  const calls = []
  const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init })
    let r = route(url, init)
    if (r === undefined) throw new Error(`fakeFetch: no route for ${init?.method ?? 'GET'} ${url}`)
    if (!(r && typeof r === 'object' && 'status' in r)) r = { status: 200, body: r }
    const headers = new Map(Object.entries(r.headers ?? {}))
    return {
      status: r.status,
      headers: { get: (/** @type {string} */ k) => headers.get(k.toLowerCase()) ?? null },
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    }
  }
  return { fetch, calls }
}

/** An in-memory GitHub with the client interface intake uses. */
export function fakeGithub(/** @type {{ number: number, body: string, labels?: string[] }[]} */ issues = []) {
  const state = {
    issues: issues.map((i) => ({ labels: ['q:intake'], ...i })),
    comments: /** @type {any[]} */ ([]),
    reads: 0,
  }
  /** @type {import('../src/intake.mjs').GithubClient} */
  const client = {
    openIntents: async () => {
      state.reads++
      return state.issues.filter((i) => i.labels.includes('q:intake')).map(({ number, body }) => ({ number, body }))
    },
    createIssue: async ({ title, body, labels }) => {
      const number = 100 + state.issues.length
      state.issues.push({ number, title, body, labels })
      return { number, html_url: `https://github.com/o/r/issues/${number}` }
    },
    comment: async (number, body) => {
      state.comments.push({ number, body })
      return { html_url: `https://github.com/o/r/issues/${number}#c${state.comments.length}` }
    },
  }
  const byFingerprint = (/** @type {string} */ fp) => state.issues.filter((i) => fingerprintOf(i.body) === fp)
  return { client, state, byFingerprint }
}
