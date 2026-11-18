// @ts-check
/**
 * The one config file. Every field is optional except `repos`; `loadConfig`
 * merges the file over {@link defaults} and resolves `~` in paths.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * @typedef {{ enabled: boolean, time: string, from: string, to: string }} RepoRelease
 *   The promotion PR (`engine: "graph"`): `from` (default: the repo's `baseBranch`) is promoted into `to`
 *   (default `main`) once a day at `time`. `enabled`/`time` default to the top-level `release`. Off when
 *   `from === to`.
 * @typedef {{ slug: string, path: string, baseBranch: string, release: RepoRelease }} Repo
 * @typedef {{ cap: number, wallClockMinutes: number, maxTurns: number, maxAttempts: number }} PhaseCaps
 * @typedef {{
 *   host: string,
 *   engine: 'legacy' | 'graph',
 *   tickSeconds: number,
 *   stepTimeoutSeconds: number,
 *   repos: Repo[],
 *   phases: { task: PhaseCaps, dispatch: PhaseCaps & { maxRounds: number } },
 *   mergeQueueMinutes: number,
 *   priorityLabels: string[],
 *   release: { enabled: boolean, time: string },
 *   paths: { home: string, db: string, heartbeat: string, logs: string },
 *   logs: { keepPerIssue: number, daemonMaxBytes: number },
 *   graft: { command: string, app: string | null, botLogin: string | null },
 *   worker: { command: string, args: string[], graftApp: string | null, fetch: boolean, env: Record<string, string> },
 *   update: { auto: boolean, checkMinutes: number },
 * }} Config
 */

export const DEFAULT_HOME = join(homedir(), '.cambium')

/** @param {string} home @returns {Config} */
export function defaults(home = DEFAULT_HOME) {
  return {
    host: hostname(),
    engine: 'legacy',
    tickSeconds: 30,
    stepTimeoutSeconds: 20,
    repos: [],
    phases: {
      task: { cap: 2, wallClockMinutes: 60, maxTurns: 200, maxAttempts: 3 },
      dispatch: { cap: 0, wallClockMinutes: 15, maxTurns: 50, maxAttempts: 3, maxRounds: 3 },
    },
    mergeQueueMinutes: 120,
    priorityLabels: ['priority:critical', 'priority:high', 'priority:medium', 'priority:low'],
    release: { enabled: false, time: '06:00' },
    paths: {
      home,
      db: join(home, 'cambium.db'),
      heartbeat: join(home, 'state.json'),
      logs: join(home, 'logs'),
    },
    logs: { keepPerIssue: 20, daemonMaxBytes: 10 * 1024 * 1024 },
    graft: { command: 'graft', app: null, botLogin: null },
    worker: { command: 'claude', args: [], graftApp: null, fetch: true, env: {} },
    update: { auto: false, checkMinutes: 360 },
  }
}

/** @param {string} p */
const untilde = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p))

/** @param {any} base @param {any} over @returns {any} */
function merge(base, over) {
  if (over === undefined) return base
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null) return over
  const out = { ...base }
  for (const [k, v] of Object.entries(over ?? {})) out[k] = merge(base[k], v)
  return out
}

/** The config path: `--config`, then `$CAMBIUM_CONFIG`, then `~/.cambium/config.json`. */
export function configPath(/** @type {string | undefined} */ flag, env = process.env) {
  return untilde(flag ?? env.CAMBIUM_CONFIG ?? join(DEFAULT_HOME, 'config.json'))
}

/**
 * @param {any} raw the parsed file
 * @returns {Config}
 */
export function resolveConfig(raw = {}) {
  const home = untilde(raw?.paths?.home ?? DEFAULT_HOME)
  /** @type {Config} */
  const config = merge(defaults(home), raw)
  for (const k of /** @type {const} */ (['home', 'db', 'heartbeat', 'logs'])) config.paths[k] = untilde(config.paths[k])
  if (!/^\d{2}:\d{2}$/.test(config.release.time)) throw new Error(`config: release.time must be HH:MM`)
  config.repos = (config.repos ?? []).map((r) => {
    if (!r?.slug || !/^[^/\s]+\/[^/\s]+$/.test(r.slug))
      throw new Error(`config: repo slug must be owner/name, got ${r?.slug}`)
    if (!r.path) throw new Error(`config: repo ${r.slug} needs "path" (a local clone)`)
    const baseBranch = r.baseBranch ?? 'main'
    /** @type {RepoRelease} */
    const release = {
      enabled: config.release.enabled,
      time: config.release.time,
      from: baseBranch,
      to: 'main',
      ...r.release,
    }
    if (!/^\d{2}:\d{2}$/.test(release.time)) throw new Error(`config: repo ${r.slug} release.time must be HH:MM`)
    return { slug: r.slug, path: untilde(r.path), baseBranch, release }
  })
  const wenv = config.worker.env
  if (
    !wenv ||
    typeof wenv !== 'object' ||
    Array.isArray(wenv) ||
    Object.values(wenv).some((v) => typeof v !== 'string')
  )
    throw new Error('config: worker.env must be an object of string values')
  if (typeof config.update.auto !== 'boolean') throw new Error('config: update.auto must be true or false')
  if (!(Number(config.update.checkMinutes) >= 5)) throw new Error('config: update.checkMinutes must be at least 5')
  if (config.engine !== 'legacy' && config.engine !== 'graph')
    throw new Error(`config: engine must be "legacy" or "graph", got ${JSON.stringify(config.engine)}`)
  return config
}

/** @param {string} path */
/**
 * What the daemon bakes in at start: the host its leases name, the engine (switching it under live workers is
 * unsafe, see #42), the db/log/heartbeat paths it opened, and graft's App identity in its children's env.
 */
export const RESTART_KEYS = Object.freeze(['host', 'engine', 'paths', 'logs', 'graft'])

/**
 * A re-read config applied to the running one in place, since every collaborator holds that object. Keys in
 * {@link RESTART_KEYS} are never applied; they are reported so the daemon can say a restart is needed.
 *
 * @param {Config} live @param {Config} next
 * @returns {{ applied: string[], restart: string[] }}
 */
export function applyReload(live, next) {
  if (!next.repos.length) throw new Error('no repos')
  /** @type {Record<string, unknown>} */
  const target = live
  /** @type {Record<string, unknown>} */
  const source = next
  /** @type {string[]} */
  const applied = []
  /** @type {string[]} */
  const restart = []
  for (const k of new Set([...Object.keys(target), ...Object.keys(source)])) {
    if (JSON.stringify(target[k]) === JSON.stringify(source[k])) continue
    if (RESTART_KEYS.includes(k)) restart.push(k)
    else {
      target[k] = source[k]
      applied.push(k)
    }
  }
  return { applied, restart }
}

export function loadConfig(path) {
  if (!existsSync(path)) return resolveConfig({})
  try {
    return resolveConfig(JSON.parse(readFileSync(path, 'utf8')))
  } catch (err) {
    throw new Error(`${path}: ${/** @type {Error} */ (err).message}`)
  }
}
