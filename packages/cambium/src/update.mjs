// @ts-check
/**
 * Self-update. cambium updates itself only when it is a global npm install (`<prefix>/lib/node_modules/
 * @oakgreencc/cambium`), into that same prefix, so the launchd agent's paths stay valid. A source checkout, a
 * workspace link or a copy inside another package's node_modules is left to whoever installed it.
 *
 * - `cambium update` installs the latest version, then has the launchd agent restart onto it (SIGTERM; it
 *   finishes its tick, exits, and KeepAlive starts it again).
 * - With `update.auto`, the daemon checks every `update.checkMinutes`; on a newer version it installs it and
 *   exits between ticks, and launchd's KeepAlive starts it again on the new code. Only under launchd: anywhere
 *   else nothing would bring it back.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LABEL } from './launchd.mjs'

export const PACKAGE = '@oakgreencc/cambium'
export const REGISTRY = 'https://registry.npmjs.org'
const MIN = 60_000

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url))

/** The version of this copy of cambium, from its package.json. */
export const VERSION = /** @type {string} */ (JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version)

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} ExecResult
 * @typedef {(cmd: string, args: string[]) => Promise<ExecResult>} Exec
 * @typedef {{
 *   current: string,
 *   installOf: () => { prefix: string, dir: string } | null,
 *   latest: () => Promise<string>,
 *   install: (prefix: string, version: string) => Promise<void>,
 * }} Updater
 */

/** @type {Exec} */
export const defaultExec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !err.code ? err.message : '')) })
    })
  })

/**
 * Where this cambium is installed, when it is a global npm install: the npm prefix and the package directory.
 * @param {string} [dir] the package directory (default: this one, symlinks resolved)
 */
export function installOf(dir = PKG_DIR) {
  let real = dir
  try {
    real = realpathSync(dir)
  } catch {}
  const m = /^(.*)\/lib\/node_modules\/@oakgreencc\/cambium\/?$/.exec(real)
  return m ? { prefix: m[1], dir: real } : null
}

/** `a` is a later x.y.z than `b` (pre-release tags are ignored). @param {string} a @param {string} b */
export function newer(a, b) {
  const parts = (/** @type {string} */ v) => String(v).split('-')[0].split('.').map(Number)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d > 0
  }
  return false
}

/**
 * The `latest` dist-tag from the registry.
 * @param {{ fetch?: typeof globalThis.fetch, registry?: string }} [o]
 */
export async function latestVersion({ fetch = globalThis.fetch, registry = REGISTRY } = {}) {
  const res = await fetch(`${registry}/${PACKAGE.replace('/', '%2f')}/latest`, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`registry answered ${res.status} for ${PACKAGE}`)
  const v = /** @type {any} */ (await res.json())?.version
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+/.test(v)) throw new Error(`registry gave no version for ${PACKAGE}`)
  return v
}

/** npm next to this Node (nvm, Homebrew and the official installer put it there), else npm on PATH. */
export function npmBin(node = process.execPath) {
  const beside = join(dirname(node), 'npm')
  return existsSync(beside) ? beside : 'npm'
}

/**
 * `npm install -g --prefix <prefix> @oakgreencc/cambium@<version>`; throws with npm's output on failure.
 * @param {Exec} exec @param {string} prefix @param {string} version
 */
export async function npmInstall(exec, prefix, version) {
  const r = await exec(npmBin(), ['install', '--global', '--prefix', prefix, `${PACKAGE}@${version}`])
  if (r.code !== 0) throw new Error(`npm install ${PACKAGE}@${version} failed: ${(r.stderr || r.stdout).trim()}`)
}

/** The real updater. @param {{ exec?: Exec, fetch?: typeof globalThis.fetch }} [o] @returns {Updater} */
export function realUpdater({ exec = defaultExec, fetch } = {}) {
  return {
    current: VERSION,
    installOf: () => installOf(),
    latest: () => latestVersion({ fetch }),
    install: (prefix, version) => npmInstall(exec, prefix, version),
  }
}

/** Is this process the launchd agent (KeepAlive brings it back after an exit)? @param {Record<string, string | undefined>} env */
export const underLaunchd = (env) => env.XPC_SERVICE_NAME === LABEL

/**
 * The daemon's between-ticks check. Returns the version it installed (the caller then exits so launchd restarts
 * it), or null. Never throws: a failed check or install is logged and retried at the next `checkMinutes`.
 *
 * @param {import('./tick.mjs').Deps} deps
 * @param {{ updater: Updater, env: Record<string, string | undefined>, now: number }} o
 * @returns {Promise<string | null>}
 */
export async function autoUpdate(deps, { updater, env, now }) {
  const { auto, checkMinutes } = deps.config.update
  if (!auto) return null
  const last = Number(deps.store.get('update.lastCheck')) || 0
  if (now - last < checkMinutes * MIN) return null
  deps.store.set('update.lastCheck', String(now))
  const skip = (/** @type {string} */ why) => {
    if (deps.store.get('update.skipped') !== why) deps.log('warn', `auto-update skipped: ${why}`)
    deps.store.set('update.skipped', why)
    return null
  }
  if (!underLaunchd(env)) return skip('not running as the launchd agent, so nothing would restart it')
  const where = updater.installOf()
  if (!where) return skip('not a global npm install; update it the way it was installed')
  try {
    const latest = await updater.latest()
    if (!newer(latest, updater.current)) return null
    deps.log('info', `updating cambium ${updater.current} → ${latest} in ${where.prefix}`)
    await updater.install(where.prefix, latest)
    deps.log('info', `cambium ${latest} installed; exiting so launchd starts the new version`)
    return latest
  } catch (err) {
    deps.log('warn', `auto-update: ${/** @type {Error} */ (err)?.message ?? err}`)
    return null
  }
}

/**
 * `cambium update [--check] [--version <v>]`: report or install, then restart the launchd agent when it runs.
 *
 * @param {{ check: boolean, version?: string }} opts
 * @param {{ updater: Updater, exec: Exec, uid: number, out: (s: string) => void }} io
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function runUpdate({ check, version }, { updater, exec, uid, out }) {
  const target = version ?? (await updater.latest())
  if (!newer(target, updater.current) && !version) {
    out(`cambium ${updater.current} is up to date`)
    return { ok: true }
  }
  if (check) {
    out(`cambium ${updater.current} → ${target} available; run \`cambium update\``)
    return { ok: true }
  }
  const where = updater.installOf()
  if (!where)
    return {
      ok: false,
      error: `this cambium is not a global npm install (${PACKAGE} under <prefix>/lib/node_modules); update it the way it was installed`,
    }
  out(`installing ${PACKAGE}@${target} into ${where.prefix}…`)
  await updater.install(where.prefix, target)
  out(`installed cambium ${target}`)
  const service = `gui/${uid}/${LABEL}`
  if ((await exec('launchctl', ['print', service])).code !== 0) {
    out('the launchd agent is not loaded; start cambium yourself to run the new version')
    return { ok: true }
  }
  // SIGTERM, not `kickstart -k`: the daemon finishes its current tick, exits, and KeepAlive starts the new version.
  const r = await exec('launchctl', ['kill', 'TERM', service])
  if (r.code !== 0) return { ok: false, error: `launchctl kill TERM ${service}: ${(r.stderr || r.stdout).trim()}` }
  out(`stopping ${LABEL} after its current tick; launchd starts ${target} (workers keep running and are re-adopted)`)
  return { ok: true }
}
