// @ts-check
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Glob to RegExp over `/`-separated relative paths: `**`, `*`, `?`, `{a,b}`.
 * @param {string} glob
 */
export function globToRegExp(glob) {
  let re = ''
  let braces = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      re += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      braces++
      re += '(?:'
    } else if (c === '}' && braces > 0) {
      braces--
      re += ')'
    } else if (c === ',' && braces > 0) re += '|'
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/**
 * @param {string[]} include
 * @param {string[]} exclude
 */
export function matcher(include, exclude) {
  const inc = include.map(globToRegExp)
  const exc = exclude.map(globToRegExp)
  /** @param {string} rel */
  return (rel) => inc.some((r) => r.test(rel)) && !exc.some((r) => r.test(rel))
}

const NEVER = new Set(['node_modules', '.git', '.nx'])

/**
 * Source files under root that the include/exclude globs select, as `/`-separated relative paths.
 * @param {string} root
 * @param {(rel: string) => boolean} match
 * @returns {string[]}
 */
export function listFiles(root, match) {
  /** @type {string[]} */
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (NEVER.has(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) {
        const rel = relative(root, abs).split(sep).join('/')
        if (match(rel)) out.push(rel)
      }
    }
  }
  walk(root)
  return out.sort()
}
