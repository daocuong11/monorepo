// @ts-check
/**
 * mycelium's settings file: `KEY=value` lines, the same keys as the environment. It keeps credentials out of the
 * launchd plist and out of shell profiles. The process environment wins over the file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** @typedef {Record<string, string | undefined>} Env */

/** `$MYCELIUM_ENV`, else `~/.mycelium/env`. @param {Env} env @param {string} [home] */
export const envFilePath = (env, home = env.HOME || homedir()) => env.MYCELIUM_ENV || join(home, '.mycelium', 'env')

/**
 * Dotenv lines: `#` comments, an optional `export `, values bare, `"double"` or `'single'` quoted (a shell
 * `'\''` inside single quotes is a literal quote, as `set -a; . file` would read it).
 *
 * @param {string} text @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw)
    if (!m) continue
    let v = m[2].trim()
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replaceAll("'\\''", "'")
    else if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
    out[m[1]] = v
  }
  return out
}

/**
 * The environment with the settings file underneath it; `file` is the path read, or null when there is none.
 *
 * @param {Env} env @param {{ home?: string, read?: (p: string) => string | null }} [o]
 * @returns {{ env: Env, file: string | null }}
 */
export function withEnvFile(env, o = {}) {
  const path = envFilePath(env, o.home)
  const read = o.read ?? ((p) => (existsSync(p) ? readFileSync(p, 'utf8') : null))
  const text = read(path)
  if (text == null) return { env, file: null }
  const fromFile = parseEnvFile(text)
  /** @type {Env} */
  const merged = { ...fromFile }
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') merged[k] = v
  return { env: merged, file: path }
}
