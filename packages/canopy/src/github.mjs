// @ts-check
import { execFile } from 'node:child_process'
import { combine, emptyColumns, group, QUEUES_QUERY, queryVars } from './queues.mjs'

/**
 * @typedef {(cmd: string, args: string[]) => Promise<string>} Exec
 * @typedef {{ queues(slug: string): Promise<import('./queues.mjs').Queues> }} GithubClient
 */

/** @type {Exec} */
const defaultExec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0]}: ${String(stderr || err.message).trim()}`))
      else resolve(stdout)
    })
  })

/**
 * The default client: one `graft graphql` per repo, so auth and the token
 * cache are graft's and canopy holds no credentials.
 *
 * @param {{ exec?: Exec, bin?: string }} [opts]
 * @returns {GithubClient}
 */
export function graftClient({ exec = defaultExec, bin = 'graft' } = {}) {
  return {
    async queues(slug) {
      const out = await exec(bin, ['graphql', QUEUES_QUERY, '--vars', JSON.stringify(queryVars(slug)), '--repo', slug])
      return group(JSON.parse(out), slug)
    },
  }
}

export const MIN_TTL_MS = 15_000

/**
 * Server-side cache in front of a client, per repo: at most one fetch per
 * `ttlMs` however many tabs poll, one in flight at a time, and the last good
 * answer kept (with the error) when a refresh fails.
 *
 * @param {{ client: GithubClient, ttlMs?: number, now?: () => number }} opts
 */
export function cachedQueues({ client, ttlMs = MIN_TTL_MS, now = Date.now }) {
  const ttl = Math.max(MIN_TTL_MS, ttlMs)
  /** @type {Map<string, { at: number, value: import('./queues.mjs').RepoQueues }>} */
  const entries = new Map()
  /** @type {Map<string, Promise<import('./queues.mjs').RepoQueues>>} */
  const inflight = new Map()

  const refresh = (/** @type {string} */ slug) => {
    const pending = inflight.get(slug)
    if (pending) return pending
    const p = (async () => {
      const prev = entries.get(slug)?.value
      /** @type {import('./queues.mjs').RepoQueues} */
      let value
      try {
        const q = await client.queues(slug)
        value = { slug, ok: true, error: null, fetchedAt: new Date(now()).toISOString(), ...q }
      } catch (err) {
        const error = /** @type {Error} */ (err)?.message ?? String(err)
        value = prev
          ? { ...prev, ok: false, error }
          : { slug, ok: false, error, fetchedAt: null, columns: emptyColumns(), prs: [] }
      }
      entries.set(slug, { at: now(), value })
      return value
    })().finally(() => inflight.delete(slug))
    inflight.set(slug, p)
    return p
  }

  return {
    ttlMs: ttl,
    /** @param {string[]} slugs */
    async get(slugs) {
      let cached = true
      const repos = await Promise.all(
        slugs.map((slug) => {
          const hit = entries.get(slug)
          if (hit && now() - hit.at < ttl) return hit.value
          cached = false
          return refresh(slug)
        }),
      )
      return combine(repos, cached)
    },
  }
}
