// @ts-check
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULTS = Object.freeze({
  maxCrap: 30,
  include: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
  exclude: [
    '**/node_modules/**',
    '**/coverage/**',
    '**/dist/**',
    '**/build/**',
    '**/test/**',
    '**/tests/**',
    '**/__tests__/**',
    '**/*.{test,spec}.*',
    '**/*.d.ts',
  ],
  coverage: ['coverage/coverage-final.json', 'coverage/lcov.info'],
  baseline: 'canker-baseline.json',
})

export class ConfigError extends Error {}

/**
 * @typedef {{ maxCrap: number, include: string[], exclude: string[], coverage: string[], baseline: string }} Config
 */

const asList = (v) => (typeof v === 'string' ? [v] : v)

/**
 * Config lives in the consuming project: `canker.json`, else the `canker` key of `package.json`.
 * @param {string} root
 * @returns {Config}
 */
export function loadConfig(root) {
  /** @type {Record<string, unknown>} */
  let raw = {}
  const own = join(root, 'canker.json')
  const pkg = join(root, 'package.json')
  if (existsSync(own)) raw = readJson(own)
  else if (existsSync(pkg)) raw = readJson(pkg).canker ?? {}
  const config = {
    maxCrap: raw.maxCrap ?? DEFAULTS.maxCrap,
    include: asList(raw.include ?? DEFAULTS.include),
    exclude: asList(raw.exclude ?? DEFAULTS.exclude),
    coverage: asList(raw.coverage ?? DEFAULTS.coverage),
    baseline: raw.baseline ?? DEFAULTS.baseline,
  }
  if (typeof config.maxCrap !== 'number' || !(config.maxCrap > 0))
    throw new ConfigError('maxCrap must be a positive number')
  for (const key of ['include', 'exclude', 'coverage']) {
    if (!Array.isArray(config[key]) || config[key].some((v) => typeof v !== 'string')) {
      throw new ConfigError(`${key} must be a string or an array of strings`)
    }
  }
  if (typeof config.baseline !== 'string') throw new ConfigError('baseline must be a path')
  return /** @type {Config} */ (config)
}

/** @param {string} path */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ConfigError(`${path}: ${/** @type {Error} */ (err).message}`)
  }
}
