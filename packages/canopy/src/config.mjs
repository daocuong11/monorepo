// @ts-check
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const SLUG = /^[\w.-]+\/[\w.-]+$/

export const expandHome = (/** @type {string} */ p, home = homedir()) =>
  p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p

/**
 * Where the heartbeat lives and which repos to read, from flags first, then
 * cambium's own config file. Only `paths` and `repos[].slug` are read from it.
 *
 * @param {{ state?: string, config?: string, repos?: string[] }} flags
 * @param {{ env?: Record<string, string | undefined>, home?: string, read?: (p: string) => string }} [deps]
 * @returns {{ statePath: string, repos: string[], configPath: string, configError: string | null }}
 */
export function resolveSettings(
  flags,
  { env = process.env, home = homedir(), read = (p) => readFileSync(p, 'utf8') } = {},
) {
  const configPath = resolve(expandHome(flags.config ?? env.CAMBIUM_CONFIG ?? '~/.cambium/config.json', home))
  /** @type {any} */
  let cfg = {}
  let configError = null
  try {
    cfg = JSON.parse(read(configPath)) ?? {}
  } catch (err) {
    const code = /** @type {any} */ (err)?.code
    if (code !== 'ENOENT' || flags.config || env.CAMBIUM_CONFIG)
      configError = `cambium config ${configPath}: ${/** @type {Error} */ (err).message}`
  }
  const homeDir = typeof cfg?.paths?.home === 'string' ? cfg.paths.home : '~/.cambium'
  const fromConfig = typeof cfg?.paths?.heartbeat === 'string' ? cfg.paths.heartbeat : join(homeDir, 'state.json')
  const statePath = resolve(expandHome(flags.state ?? fromConfig, home))

  const listed = flags.repos?.length
    ? flags.repos
    : (Array.isArray(cfg?.repos) ? cfg.repos : []).map((/** @type {any} */ r) => r?.slug).filter(Boolean)
  for (const r of listed) if (!SLUG.test(r)) throw new Error(`repo must be owner/name, got ${r}`)
  return { statePath, repos: [...new Set(/** @type {string[]} */ (listed))], configPath, configError }
}

export const isSlug = (/** @type {unknown} */ s) => typeof s === 'string' && SLUG.test(s)
