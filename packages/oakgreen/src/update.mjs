// @ts-check
/**
 * `oakgreen update`: install the registry's latest oakgreen over this one, then restart the running services.
 *
 * oakgreen depends on every stack tool, so a new oakgreen brings new graft, cambium, mycelium, ... with it, nested
 * in its own node_modules. A tool also installed on its own (`<prefix>/lib/node_modules/@oakgreencc/<tool>`) is a
 * separate copy, and it is the one on PATH and in the launchd agents `cambium install` wrote; so each such copy older
 * than the version the latest oakgreen pins is upgraded to that version in the same `npm install` (never
 * downgraded). That also runs when oakgreen itself is current, so a second `oakgreen update` heals tools an older
 * oakgreen left behind.
 *
 * It updates only a global npm install (`<prefix>/lib/node_modules/oakgreen`), into that same prefix, so PATH and the
 * launchd agents' paths stay valid. A source checkout or `npm link` is left alone. Afterwards each service that is
 * running gets a new process (SIGTERM; KeepAlive starts it on the new code); a stopped one stays stopped.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVICES, restart, statusOf } from './services.mjs'

export const PACKAGE = 'oakgreen'
export const REGISTRY = 'https://registry.npmjs.org'
export const SCOPE = '@oakgreencc'

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * @typedef {{
 *   current: string,
 *   installOf: () => { prefix: string, dir: string } | null,
 *   latest: () => Promise<Manifest>,
 *   globals: (prefix: string) => Record<string, string>,
 *   install: (prefix: string, specs: string[]) => Promise<void>,
 * }} Updater
 * @typedef {{ version: string, dependencies: Record<string, string> }} Manifest
 * @typedef {{ name: string, from: string, to: string }} Stale
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

const SEMVER = /^\d+\.\d+\.\d+/

/**
 * The registry's `latest` manifest: its version and dependencies (published with exact versions).
 * @param {{ fetch?: typeof globalThis.fetch, registry?: string }} [o]
 * @returns {Promise<Manifest>}
 */
export async function latestManifest({ fetch = globalThis.fetch, registry = REGISTRY } = {}) {
  const res = await fetch(`${registry}/${PACKAGE}/latest`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`registry answered ${res.status} for ${PACKAGE}`)
  const j = /** @type {any} */ (await res.json())
  const v = j?.version
  if (typeof v !== 'string' || !SEMVER.test(v)) throw new Error(`registry gave no version for ${PACKAGE}`)
  return { version: v, dependencies: { ...(j.dependencies ?? {}) } }
}

/**
 * The stack tools installed on their own in a global prefix, by name: `{ '@oakgreencc/cambium': '0.0.38' }`.
 * @param {string} prefix
 * @returns {Record<string, string>}
 */
export function globalTools(prefix) {
  const dir = join(prefix, 'lib', 'node_modules', SCOPE)
  /** @type {Record<string, string>} */
  const out = {}
  let names = /** @type {string[]} */ ([])
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const n of names) {
    try {
      const v = JSON.parse(readFileSync(join(dir, n, 'package.json'), 'utf8'))?.version
      if (typeof v === 'string') out[`${SCOPE}/${n}`] = v
    } catch {}
  }
  return out
}

/**
 * Standalone tools older than the version oakgreen pins. Ranges (anything not a plain x.y.z) are skipped.
 * @param {Record<string, string>} pinned oakgreen's dependencies
 * @param {Record<string, string>} installed {@link globalTools}
 * @returns {Stale[]}
 */
export function staleTools(pinned, installed) {
  return Object.entries(installed)
    .filter(([name, from]) => {
      const to = pinned[name]
      return typeof to === 'string' && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(to) && newer(to, from)
    })
    .map(([name, from]) => ({ name, from, to: pinned[name] }))
    .sort((a, b) => a.name.localeCompare(b.name))
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
    latest: () => latestManifest({ fetch }),
    globals: globalTools,
    install: async (prefix, specs) => {
      const r = await exec(npmBin(), ['install', '--global', '--prefix', prefix, ...specs])
      if (r.code !== 0) throw new Error(`npm install ${specs.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`)
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
  const self = newer(latest.version, updater.current)
  const where = updater.installOf()
  const stale = where ? staleTools(latest.dependencies, updater.globals(where.prefix)) : []
  if (!self && !stale.length) {
    out(`oakgreen ${updater.current} is up to date\n`)
    return { ok: true }
  }
  const lines = [
    ...(self ? [`oakgreen ${updater.current} → ${latest.version}`] : []),
    ...stale.map((t) => `${t.name} ${t.from} → ${t.to}`),
  ]
  if (check) {
    for (const l of lines) out(`${l} available\n`)
    out('run `oakgreen update`\n')
    return { ok: true }
  }
  if (!where)
    return {
      ok: false,
      error: `oakgreen ${updater.current} → ${latest.version} available, but this oakgreen is not a global npm install (<prefix>/lib/node_modules/oakgreen); update it the way it was installed`,
    }
  const specs = [...(self ? [`${PACKAGE}@${latest.version}`] : []), ...stale.map((t) => `${t.name}@${t.to}`)]
  out(`installing ${specs.join(' ')} into ${where.prefix}…\n`)
  await updater.install(where.prefix, specs)
  for (const l of lines) out(`✓ ${l}\n`)
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
