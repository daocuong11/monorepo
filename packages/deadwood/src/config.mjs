// @ts-check
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export class ConfigError extends Error {}

export const DEFAULTS = Object.freeze({
  include: ['**'],
  exclude: [],
  markdown: { allow: ['**/README.md', 'AGENTS.md', 'CLAUDE.md'] },
  comments: { maxDensity: 0.15, minLines: 10 },
  overrides: [],
  baseline: 'deadwood.baseline.json',
})

/**
 * @typedef {{ maxDensity: number, minLines: number }} CommentRules
 * @typedef {{ files: string[], comments: Partial<CommentRules> | false }} Override
 * @typedef {{ include: string[], exclude: string[], markdown: { allow: string[] },
 *   comments: CommentRules, overrides: Override[], baseline: string }} Config
 */

/**
 * @param {string} root
 * @param {{ readFile?: (path: string) => string | null }} [io]
 * @returns {{ config: Config, source: string }}
 */
export function loadConfig(root, { readFile = readOrNull } = {}) {
  const own = readFile(join(root, 'deadwood.json'))
  const pkg = readFile(join(root, 'package.json'))
  const fromPkg = pkg == null ? undefined : parse(pkg, 'package.json').deadwood
  if (own != null && fromPkg !== undefined) {
    throw new ConfigError('config in both deadwood.json and package.json "deadwood"; keep one')
  }
  if (own != null) return { config: resolveConfig(parse(own, 'deadwood.json')), source: 'deadwood.json' }
  if (fromPkg !== undefined) return { config: resolveConfig(fromPkg), source: 'package.json' }
  return { config: resolveConfig({}), source: 'defaults' }
}

/**
 * @param {unknown} raw
 * @returns {Config}
 */
export function resolveConfig(raw) {
  const obj = record(raw, 'config')
  keys(obj, ['include', 'exclude', 'markdown', 'comments', 'overrides', 'baseline'], 'config')
  const markdown = record(obj.markdown ?? {}, 'markdown')
  keys(markdown, ['allow'], 'markdown')
  const overrides = obj.overrides ?? []
  if (!Array.isArray(overrides)) throw new ConfigError('overrides must be an array')
  if (obj.baseline !== undefined && typeof obj.baseline !== 'string') {
    throw new ConfigError('baseline must be a path string')
  }
  return {
    include: globs(obj.include ?? DEFAULTS.include, 'include'),
    exclude: globs(obj.exclude ?? DEFAULTS.exclude, 'exclude'),
    markdown: { allow: globs(markdown.allow ?? DEFAULTS.markdown.allow, 'markdown.allow') },
    comments: { ...DEFAULTS.comments, ...commentRules(obj.comments ?? {}, 'comments') },
    overrides: overrides.map((o, k) => {
      const at = `overrides[${k}]`
      const override = record(o, at)
      keys(override, ['files', 'comments'], at)
      return {
        files: globs(override.files, `${at}.files`),
        comments: override.comments === false ? false : commentRules(override.comments ?? {}, `${at}.comments`),
      }
    }),
    baseline: /** @type {string} */ (obj.baseline ?? DEFAULTS.baseline),
  }
}

/**
 * @param {Config} config
 * @param {(globs: string[]) => (path: string) => boolean} match
 * @returns {(path: string) => CommentRules | null}
 */
export function commentRulesFor(config, match) {
  const overrides = config.overrides.map((o) => ({ test: match(o.files), comments: o.comments }))
  return (path) => {
    /** @type {CommentRules | null} */
    let rules = { ...config.comments }
    for (const o of overrides) {
      if (!o.test(path)) continue
      rules = o.comments === false ? null : { ...(rules ?? config.comments), ...o.comments }
    }
    return rules
  }
}

function commentRules(raw, at) {
  const obj = record(raw, at)
  keys(obj, ['maxDensity', 'minLines'], at)
  const out = {}
  if (obj.maxDensity !== undefined) {
    if (typeof obj.maxDensity !== 'number' || obj.maxDensity < 0 || obj.maxDensity > 1) {
      throw new ConfigError(`${at}.maxDensity must be a number from 0 to 1`)
    }
    out.maxDensity = obj.maxDensity
  }
  if (obj.minLines !== undefined) {
    if (!Number.isInteger(obj.minLines) || obj.minLines < 0) {
      throw new ConfigError(`${at}.minLines must be a non-negative integer`)
    }
    out.minLines = obj.minLines
  }
  return out
}

function record(raw, at) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${at} must be an object`)
  return /** @type {Record<string, any>} */ (raw)
}

function keys(obj, allowed, at) {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k))
  if (unknown.length) throw new ConfigError(`${at}: unknown key ${unknown.map((k) => `"${k}"`).join(', ')}`)
}

function globs(raw, at) {
  if (!Array.isArray(raw) || !raw.every((g) => typeof g === 'string')) {
    throw new ConfigError(`${at} must be an array of glob strings`)
  }
  return raw
}

function parse(text, name) {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new ConfigError(`${name}: ${/** @type {Error} */ (err).message}`)
  }
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
    throw err
  }
}
