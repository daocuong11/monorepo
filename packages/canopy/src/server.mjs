// @ts-check
import { createServer } from 'node:http'
import { isSlug } from './config.mjs'
import { readHeartbeat as defaultReadHeartbeat } from './heartbeat.mjs'
import { PAGE } from './page.mjs'
import { emptyColumns } from './queues.mjs'
import { traceDetail, traceIndex, traceList } from './traces.mjs'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 4317
export const POLL_MS = 5000

/**
 * @typedef {{
 *   statePath: string,
 *   repos: string[],
 *   queues: { get(slugs: string[]): Promise<import('./queues.mjs').QueueView>, ttlMs?: number },
 *   readHeartbeat?: (path: string) => Promise<import('./heartbeat.mjs').Heartbeat>,
 *   now?: () => number,
 *   host?: string,
 *   notes?: string[],
 *   traces?: import('./traces.mjs').TraceStore,
 * }} AppOptions
 */

/** Repos named on the command line or in cambium's config, else the ones the heartbeat lists. */
const reposFor = (/** @type {string[]} */ fixed, /** @type {import('./heartbeat.mjs').Heartbeat} */ hb) =>
  fixed.length ? fixed : [...new Set((hb.data?.repos ?? []).map((/** @type {any} */ r) => r.slug).filter(isSlug))]

/**
 * The `/api/state` document.
 *
 * @param {AppOptions} opts
 */
export async function buildState({
  statePath,
  repos,
  queues,
  readHeartbeat = defaultReadHeartbeat,
  now = Date.now,
  notes = [],
  traces,
}) {
  const [heartbeat, traceFile] = await Promise.all([readHeartbeat(statePath), traces?.read()])
  const slugs = reposFor(repos, heartbeat)
  const github = slugs.length
    ? await queues.get(slugs)
    : { repos: [], columns: emptyColumns(), prs: [], fetchedAt: null, cached: false }
  return {
    now: new Date(now()).toISOString(),
    pollMs: POLL_MS,
    cacheMs: queues.ttlMs ?? null,
    notes: slugs.length
      ? notes
      : [...notes, 'no repositories to read: pass --repo owner/name or set repos in cambium config'],
    heartbeat,
    github,
    traces: traceFile ? traceIndex(traceFile) : null,
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1'])

/** Hostname of a Host header, without port or IPv6 brackets. */
export function hostnameOf(/** @type {string | undefined} */ header) {
  if (!header) return ''
  const h = header.trim().toLowerCase()
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'))
  return h.replace(/:\d+$/, '')
}

/**
 * Request handler. Refuses foreign Host headers so a page elsewhere cannot
 * read local paths through DNS rebinding.
 *
 * @param {AppOptions} opts
 * @returns {import('node:http').RequestListener}
 */
export function createHandler(opts) {
  const allowed = new Set([...LOOPBACK, ...(opts.host ? [opts.host.toLowerCase()] : [])])
  const anyHost = opts.host === '0.0.0.0' || opts.host === '::'
  return async (req, res) => {
    const send = (/** @type {number} */ status, /** @type {string} */ type, /** @type {string} */ body) => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    if (!anyHost && !allowed.has(hostnameOf(req.headers.host)))
      return send(403, 'text/plain; charset=utf-8', 'forbidden host\n')
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', 'read-only\n')
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/' || path === '/index.html') return send(200, 'text/html; charset=utf-8', PAGE)
    const json = async (/** @type {() => Promise<unknown>} */ fn) => {
      try {
        const body = await fn()
        if (body === null)
          return send(404, 'application/json; charset=utf-8', JSON.stringify({ error: 'no such trace' }))
        return send(200, 'application/json; charset=utf-8', JSON.stringify(body))
      } catch (err) {
        return send(
          500,
          'application/json; charset=utf-8',
          JSON.stringify({ error: /** @type {Error} */ (err).message }),
        )
      }
    }
    if (path === '/api/state') return json(() => buildState(opts))
    const { traces } = opts
    if (traces && path === '/api/traces') return json(async () => traceList(await traces.read()))
    const one = /^\/api\/traces\/([0-9a-f]{32})$/.exec(path)
    if (traces && one) return json(async () => traceDetail(await traces.read(), one[1]))
    return send(404, 'text/plain; charset=utf-8', 'not found\n')
  }
}

/** @param {AppOptions} opts */
export const createApp = (opts) => createServer(createHandler(opts))
