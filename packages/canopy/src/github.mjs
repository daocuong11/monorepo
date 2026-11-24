// @ts-check
import { execFile } from 'node:child_process'
import { ISSUE_QUERY, issueDetail, issueVars } from './issue.mjs'
import { combine, emptyColumns, group, QUEUES_QUERY, queryVars } from './queues.mjs'

/**
 * @typedef {(cmd: string, args: string[]) => Promise<string>} Exec
 * @typedef {{
 *   queues(slug: string): Promise<import('./queues.mjs').Queues>,
 *   issue?(slug: string, number: number): Promise<import('./issue.mjs').IssueDetail | null>,
 * }} GithubClient
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
    async issue(slug, number) {
      const out = await exec(bin, [
        'graphql',
        ISSUE_QUERY,
        '--vars',
        JSON.stringify(issueVars(slug, number)),
        '--repo',
        slug,
      ])
      return issueDetail(JSON.parse(out), slug, number)
    },
  }
}

export const MIN_TTL_MS = 15_000
/** How long a GitHub answer is reused unless `--cache` says otherwise: the queues query costs about 10 GraphQL points, so a tab open at 15s would spend some 2.4k an hour per repo. */
export const DEFAULT_TTL_MS = 60_000

/**
 * Server-side cache in front of a client, per repo: at most one fetch per
 * `ttlMs` however many tabs poll, one in flight at a time, and the last good
 * answer kept (with the error) when a refresh fails.
 *
 * @param {{ client: GithubClient, ttlMs?: number, now?: () => number }} opts
 */
export function cachedQueues({ client, ttlMs = DEFAULT_TTL_MS, now = Date.now }) {
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
          : { slug, ok: false, error, fetchedAt: null, columns: emptyColumns(), prs: [], stranded: [] }
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

/** Issues kept in the reading-pane cache; the least recently fetched goes first. */
const ISSUES_KEPT = 200

/**
 * @typedef {{ issue: import('./issue.mjs').IssueDetail | null, fetchedAt: string | null, error: string | null }} IssueRead
 *   `error` set with an `issue` means the last refresh failed and this is the last good answer.
 */

/**
 * The same cache, per issue, for the Inbox reading pane: one fetch per issue per `ttlMs`, one in flight at a
 * time, the last good answer kept beside a failed refresh. A first fetch that fails throws.
 *
 * @param {{ client: GithubClient, ttlMs?: number, now?: () => number }} opts
 */
export function cachedIssues({ client, ttlMs = DEFAULT_TTL_MS, now = Date.now }) {
  const ttl = Math.max(MIN_TTL_MS, ttlMs)
  /** @type {Map<string, { at: number, value: IssueRead }>} */
  const entries = new Map()
  /** @type {Map<string, Promise<IssueRead>>} */
  const inflight = new Map()

  const refresh = (/** @type {string} */ slug, /** @type {number} */ number) => {
    const key = `${slug}#${number}`
    const pending = inflight.get(key)
    if (pending) return pending
    const p = (async () => {
      const prev = entries.get(key)?.value
      /** @type {IssueRead} */
      let value
      try {
        if (!client.issue) throw new Error('this GitHub client cannot read single issues')
        value = { issue: await client.issue(slug, number), fetchedAt: new Date(now()).toISOString(), error: null }
      } catch (err) {
        if (!prev) throw err
        value = { ...prev, error: /** @type {Error} */ (err)?.message ?? String(err) }
      }
      entries.delete(key)
      entries.set(key, { at: now(), value })
      if (entries.size > ISSUES_KEPT) entries.delete(/** @type {string} */ (entries.keys().next().value))
      return value
    })().finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }

  return {
    ttlMs: ttl,
    /** @param {string} slug @param {number} number @returns {Promise<IssueRead>} */
    get(slug, number) {
      const hit = entries.get(`${slug}#${number}`)
      return hit && now() - hit.at < ttl ? Promise.resolve(hit.value) : refresh(slug, number)
    },
  }
}
