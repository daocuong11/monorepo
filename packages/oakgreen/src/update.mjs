// @ts-check
/**
 * `oakgreen update`: install the registry's latest oakgreen over this one, then restart the running services.
 *
 * oakgreen depends on every stack tool, so a new oakgreen brings new graft, cambium, mycelium, ... with it. It
 * updates itself only when it is a global npm install (`<prefix>/lib/node_modules/oakgreen`), into that same
 * prefix, so PATH and the launchd agents' paths stay valid. A source checkout or `npm link` is left alone.
 * Afterwards each service that is running gets a new process (SIGTERM; KeepAlive starts it on the new code);
 * a stopped one stays stopped.
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVICES, restart, statusOf } from './services.mjs'

export const PACKAGE = 'oakgreen'
export const REGISTRY = 'https://registry.npmjs.org'

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * @typedef {{
 *   current: string,
 *   installOf: () => { prefix: string, dir: string } | null,
 *   latest: () => Promise<string>,
 *   install: (prefix: string, version: string) => Promise<void>,
 * }} Updater
 */

/**
 * The npm prefix and package directory when this is a global npm install, else null.
 * @param {string} [dir] the package directory (default: this one, symlinks resolved)
 */
export function installOf(dir = PKG_DIR) {
  let real = dir
  try {
    real = realpathSync(dir)
  } catch {}
  const m = /^(.*)\/lib\/node_modules\/oakgreen\/?$/.exec(real)
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

/** The registry's `latest` dist-tag. @param {{ fetch?: typeof globalThis.fetch, registry?: string }} [o] */
export async function latestVersion({ fetch = globalThis.fetch, registry = REGISTRY } = {}) {
  const res = await fetch(`${registry}/${PACKAGE}/latest`, { headers: { accept: 'application/json' } })
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
 * The real updater.
 * @param {{ exec: import('./tools.mjs').Exec, current: string, fetch?: typeof globalThis.fetch }} o
 * @returns {Updater}
 */
export function realUpdater({ exec, current, fetch }) {
  return {
    current,
    installOf: () => installOf(),
    latest: () => latestVersion({ fetch }),
    install: async (prefix, version) => {
      const r = await exec(npmBin(), ['install', '--global', '--prefix', prefix, `${PACKAGE}@${version}`])
      if (r.code !== 0) throw new Error(`npm install ${PACKAGE}@${version} failed: ${(r.stderr || r.stdout).trim()}`)
    },
  }
}

/**
 * `oakgreen update [--check]`.
 *
 * @param {{ check: boolean }} opts
 * @param {{ updater: Updater, services: import('./services.mjs').Ports, platform?: string, out: (s: string) => void }} io
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function runUpdate({ check }, { updater, services, platform, out }) {
  const latest = await updater.latest()
  if (!newer(latest, updater.current)) {
    out(`oakgreen ${updater.current} is up to date\n`)
    return { ok: true }
  }
  if (check) {
    out(`oakgreen ${updater.current} → ${latest} available; run \`oakgreen update\`\n`)
    return { ok: true }
  }
  const where = updater.installOf()
  if (!where)
    return {
      ok: false,
      error: `oakgreen ${updater.current} → ${latest} available, but this oakgreen is not a global npm install (<prefix>/lib/node_modules/oakgreen); update it the way it was installed`,
    }
  out(`installing ${PACKAGE}@${latest} into ${where.prefix}…\n`)
  await updater.install(where.prefix, latest)
  out(`✓ oakgreen ${updater.current} → ${latest}\n`)
  if ((platform ?? process.platform) !== 'darwin') return { ok: true }
  let ok = true
  for (const s of SERVICES) {
    const st = await statusOf(services, s)
    if (!st.loaded || st.pid === null) continue
    out(`… ${s.name.padEnd(8)} restarting onto the new version\n`)
    const r = await restart(services, s)
    out(`${r.ok ? '✓' : '✗'} ${s.name.padEnd(8)} ${r.detail}\n`)
    ok &&= r.ok
  }
  return ok ? { ok } : { ok, error: 'installed, but a service did not restart; see above' }
}
