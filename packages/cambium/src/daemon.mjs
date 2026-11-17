// @ts-check
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { graftGitHub } from './github.mjs'
import { openStore } from './store.mjs'
import { tick } from './tick.mjs'
import { processSpawner, realProcs } from './workers.mjs'

/** @param {string} path @param {unknown} state */
export function writeHeartbeat(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

/** @param {string} path @returns {import('./tick.mjs').HeartbeatState | null} */
export function readHeartbeat(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * @param {{ file?: string | null, maxBytes?: number, keep?: number, now?: () => number,
 *   echo?: (line: string) => void }} [opts]
 */
export function makeLogger({
  file = null,
  maxBytes = 10 * 1024 * 1024,
  keep = 100,
  now = Date.now,
  echo = console.log,
} = {}) {
  /** @type {import('./tick.mjs').Event[]} */
  const ring = []
  if (file) mkdirSync(dirname(file), { recursive: true })
  /** @type {import('./tick.mjs').Deps['log']} */
  const log = (level, msg, where = {}) => {
    const event = { at: new Date(now()).toISOString(), level, msg, ...where }
    ring.push(event)
    if (ring.length > keep) ring.shift()
    const at = where.repo ? ` ${where.repo}${where.issue ? `#${where.issue}` : ''}` : ''
    const line = `${event.at} ${level.padEnd(5)}${at} ${msg}`
    echo(line)
    if (!file) return
    try {
      if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, `${file}.1`)
      appendFileSync(file, `${line}\n`)
    } catch {}
  }
  return { log, events: () => [...ring] }
}

/**
 * @param {import('./config.mjs').Config} config
 * @param {{ echo?: (line: string) => void }} [opts]
 * @returns {import('./tick.mjs').Deps & { store: import('./store.mjs').Store }}
 */
export function realDeps(config, { echo } = {}) {
  const store = openStore(config.paths.db)
  const { log, events } = makeLogger({
    file: join(config.paths.logs, 'cambium.log'),
    maxBytes: config.logs.daemonMaxBytes,
    echo,
  })
  return {
    config,
    clock: { now: Date.now },
    github: graftGitHub({ config }),
    store,
    spawner: processSpawner({ config }),
    procs: realProcs,
    log,
    events,
    heartbeat: (state) => writeHeartbeat(config.paths.heartbeat, state),
    daemonStartedAt: Date.now(),
    pid: process.pid,
  }
}

/**
 * @param {import('./store.mjs').Store} store @param {import('./workers.mjs').Procs} procs @param {number} pid
 */
export function acquireLock(store, procs, pid) {
  const holder = Number(store.get('daemon.pid'))
  if (holder && holder !== pid && procs.alive(holder))
    throw new Error(`another cambium daemon is running (pid ${holder})`)
  store.set('daemon.pid', String(pid))
}

/**
 * @param {import('./tick.mjs').Deps} deps
 * @param {{ signal?: AbortSignal, wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>, once?: boolean }} [opts]
 */
export async function runDaemon(
  deps,
  { signal, wait = (ms, s) => sleep(ms, undefined, { signal: s }), once = false } = {},
) {
  let n = 0
  deps.log('info', `cambium up on ${deps.config.host}: ${deps.config.repos.map((r) => r.slug).join(', ')}`)
  while (!signal?.aborted) {
    deps.tickNumber = ++n
    try {
      await tick(deps)
    } catch (err) {
      deps.log('error', `tick ${n}: ${/** @type {Error} */ (err)?.message ?? err}`)
    }
    if (once) break
    try {
      await wait(deps.config.tickSeconds * 1000, signal)
    } catch {
      break
    }
  }
  deps.log('info', 'cambium stopping; workers keep running and are re-adopted on restart')
  return n
}
