// @ts-check
import { readFile } from 'node:fs/promises'

export const SUPPORTED_VERSION = 1
export const STALE_TICKS = 3
const DEFAULT_TICK_SECONDS = 30

/**
 * @typedef {{
 *   status: 'ok' | 'missing' | 'unreadable' | 'unknown-version',
 *   path: string,
 *   message: string | null,
 *   stale: boolean,
 *   ageMs: number | null,
 *   staleAfterMs: number | null,
 *   data: any,
 * }} Heartbeat
 */

/**
 * Judge an already-parsed heartbeat. Never throws: a page over a broken file
 * must still render and say what is wrong.
 *
 * @param {unknown} raw
 * @param {{ path?: string, now?: number }} [opts]
 * @returns {Heartbeat}
 */
export function judge(raw, { path = '', now = Date.now() } = {}) {
  const base = { path, stale: true, ageMs: null, staleAfterMs: null, data: null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ...base, status: 'unreadable', message: 'heartbeat is not a JSON object' }
  const hb = /** @type {any} */ (raw)
  if (hb.version !== SUPPORTED_VERSION)
    return {
      ...base,
      status: 'unknown-version',
      message: `heartbeat version ${JSON.stringify(hb.version ?? null)} is not one canopy reads (expects ${SUPPORTED_VERSION}); upgrade canopy or cambium so they agree`,
    }
  const data = normalize(hb)
  const tickSeconds = Number(data.daemon.tickSeconds) > 0 ? Number(data.daemon.tickSeconds) : DEFAULT_TICK_SECONDS
  const staleAfterMs = STALE_TICKS * tickSeconds * 1000
  const finished = Date.parse(data.tick.finishedAt ?? '')
  const ageMs = Number.isFinite(finished) ? Math.max(0, now - finished) : null
  const stale = ageMs === null || ageMs > staleAfterMs
  return {
    path,
    status: 'ok',
    message: stale ? staleMessage(ageMs, tickSeconds) : null,
    stale,
    ageMs,
    staleAfterMs,
    data,
  }
}

function staleMessage(/** @type {number | null} */ ageMs, /** @type {number} */ tickSeconds) {
  if (ageMs === null) return 'cambium has not finished a tick yet'
  return `last tick finished ${Math.round(ageMs / 1000)}s ago, past the ${STALE_TICKS} ticks of ${tickSeconds}s allowed. Check that cambium is running.`
}

const arr = (/** @type {any} */ v) => (Array.isArray(v) ? v : [])
const obj = (/** @type {any} */ v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/** Fill the optional parts so the page can read every field without guards. */
function normalize(/** @type {any} */ hb) {
  return {
    version: hb.version,
    host: hb.host ?? null,
    pid: hb.pid ?? null,
    mode: hb.mode ?? 'unknown',
    daemon: { startedAt: null, tickSeconds: null, ...obj(hb.daemon) },
    tick: { n: null, startedAt: null, finishedAt: null, durationMs: null, nextAt: null, ...obj(hb.tick) },
    steps: arr(hb.steps).map((s) => ({
      name: String(s?.name ?? '?'),
      ok: Boolean(s?.ok),
      ms: s?.ms ?? null,
      error: s?.error ?? null,
    })),
    counts: obj(hb.counts),
    caps: obj(hb.caps),
    repos: arr(hb.repos).map((r) => ({
      slug: r?.slug ?? null,
      ok: Boolean(r?.ok),
      error: r?.error ?? null,
      counts: r?.counts ?? null,
    })),
    workers: arr(hb.workers).map((w) => ({ ...obj(w), logs: obj(w?.logs) })),
    events: arr(hb.events),
  }
}

/**
 * Read and judge the heartbeat file.
 *
 * @param {string} path
 * @param {{ now?: number, read?: (p: string) => Promise<string> }} [opts]
 * @returns {Promise<Heartbeat>}
 */
export async function readHeartbeat(path, { now = Date.now(), read = (p) => readFile(p, 'utf8') } = {}) {
  let text
  try {
    text = await read(path)
  } catch (err) {
    const missing = /** @type {any} */ (err)?.code === 'ENOENT'
    return {
      status: missing ? 'missing' : 'unreadable',
      path,
      message: missing
        ? `no heartbeat at ${path}: cambium has not run here yet, or --state points elsewhere`
        : `cannot read ${path}: ${/** @type {Error} */ (err).message}`,
      stale: true,
      ageMs: null,
      staleAfterMs: null,
      data: null,
    }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return {
      status: 'unreadable',
      path,
      message: `${path} is not JSON: ${/** @type {Error} */ (err).message}`,
      stale: true,
      ageMs: null,
      staleAfterMs: null,
      data: null,
    }
  }
  return judge(raw, { path, now })
}
