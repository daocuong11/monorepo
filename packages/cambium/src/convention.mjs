// @ts-check
/**
 * The target repo's worktree convention: the `"cambium"` key of its root
 * package.json, read from the central checkout. Every field is optional;
 * a missing one takes the default below.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve } from 'node:path'

/**
 * @typedef {{
 *   root: string, branch: string, install: string | null,
 *   hydrate: { dirs: string[], files: string[] }, prepare: string[],
 * }} Convention
 */

export const DEFAULT_CONVENTION = Object.freeze({
  root: '.claude/worktrees',
  branch: 'agent/{issue}-{slug}',
  install: 'pnpm install --frozen-lockfile',
})

/** @param {string} where @param {string} msg */
const bad = (where, msg) => new Error(`${where} "cambium": ${msg}`)

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** @param {string} where @param {Record<string, unknown>} obj @param {string} at @param {string[]} keys */
function onlyKeys(where, obj, at, keys) {
  const unknown = Object.keys(obj).filter((k) => !keys.includes(k))
  if (unknown.length)
    throw bad(where, `unknown key ${unknown.map((k) => `${at}${k}`).join(', ')} (known: ${keys.join(', ')})`)
}

/** A repo-relative path that stays inside the repo. @param {string} where @param {string} at @param {unknown} v */
function relPath(where, at, v) {
  if (typeof v !== 'string' || !v || isAbsolute(v) || normalize(v).split(/[\\/]/).includes('..'))
    throw bad(where, `${at} must be a relative path inside the repo, got ${JSON.stringify(v)}`)
  return v
}

/** @param {string} where @param {string} at @param {unknown} v */
function strings(where, at, v, check = (/** @type {string} */ _a, /** @type {unknown} */ x) => x) {
  if (v === undefined) return []
  if (!Array.isArray(v)) throw bad(where, `${at} must be an array of strings`)
  return v.map((x, i) => {
    if (typeof x !== 'string' || !x) throw bad(where, `${at}[${i}] must be a non-empty string`)
    return /** @type {string} */ (check(`${at}[${i}]`, x))
  })
}

/**
 * Validate the raw `"cambium"` value and fill in the defaults.
 *
 * @param {unknown} raw @param {string} repoPath @param {string} [where] for error messages
 * @returns {Convention}
 */
export function resolveConvention(raw, repoPath, where = join(repoPath, 'package.json')) {
  const c = raw ?? {}
  if (!isObject(c)) throw bad(where, 'must be an object')
  onlyKeys(where, c, '', ['worktree', 'install', 'hydrate', 'prepare'])

  const wt = c.worktree ?? {}
  if (!isObject(wt)) throw bad(where, 'worktree must be an object')
  onlyKeys(where, wt, 'worktree.', ['root', 'branch'])
  const root = wt.root ?? DEFAULT_CONVENTION.root
  if (typeof root !== 'string' || !root) throw bad(where, 'worktree.root must be a non-empty string')
  const branch = wt.branch ?? DEFAULT_CONVENTION.branch
  if (typeof branch !== 'string' || !branch.includes('{issue}'))
    throw bad(where, 'worktree.branch must be a string containing {issue}')
  const placeholders = branch.match(/\{[^}]*\}/g) ?? []
  const unknownPh = placeholders.filter((p) => p !== '{issue}' && p !== '{slug}')
  if (unknownPh.length) throw bad(where, `worktree.branch: unknown placeholder ${unknownPh.join(', ')}`)
  if (!validBranch(branchName(branch, 1, 'x')))
    throw bad(where, `worktree.branch is not a valid branch name: ${branch}`)

  const install = c.install === undefined ? DEFAULT_CONVENTION.install : c.install
  if (install !== false && (typeof install !== 'string' || !install))
    throw bad(where, 'install must be a non-empty command string, or false')

  /** @type {Convention['hydrate']} */
  let hydrate = { dirs: [], files: [] }
  if (c.hydrate !== undefined && c.hydrate !== false) {
    if (!isObject(c.hydrate)) throw bad(where, 'hydrate must be an object or false')
    onlyKeys(where, c.hydrate, 'hydrate.', ['dirs', 'files'])
    hydrate = {
      dirs: strings(where, 'hydrate.dirs', c.hydrate.dirs, (at, x) => relPath(where, at, x)),
      files: strings(where, 'hydrate.files', c.hydrate.files, (at, x) => relPath(where, at, x)),
    }
  }
  return {
    root: resolve(repoPath, root),
    branch,
    install: install === false ? null : install,
    hydrate,
    prepare: strings(where, 'prepare', c.prepare),
  }
}

/**
 * The convention of the repo checked out at `repoPath`. No package.json or no
 * `"cambium"` key → the defaults; a malformed one throws.
 *
 * @param {string} repoPath
 * @returns {Convention}
 */
export function readConvention(repoPath) {
  const file = join(repoPath, 'package.json')
  if (!existsSync(file)) return resolveConvention(undefined, repoPath, file)
  let pkg
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${file}: ${/** @type {Error} */ (err).message}`)
  }
  return resolveConvention(pkg?.cambium, repoPath, file)
}

/** An issue title → a kebab slug of at most `max` characters, cut at a word. @param {string} title */
export function slugify(title, max = 40) {
  const s = String(title)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s.length <= max) return s || 'task'
  const cut = s.slice(0, max + 1)
  const at = cut.lastIndexOf('-')
  return (at > max / 2 ? cut.slice(0, at) : s.slice(0, max)).replace(/-+$/, '')
}

/** @param {string} template @param {number} issue @param {string} title */
export const branchName = (template, issue, title) =>
  template.replaceAll('{issue}', String(issue)).replaceAll('{slug}', slugify(title))

/** `agent/12-fix-it` → `12-fix-it`: the branch less its first segment, flattened to one directory name. */
export const topicOf = (/** @type {string} */ branch) => branch.replace(/^[^/]+\/(?=.)/, '').replaceAll('/', '-')

/** A conservative `git check-ref-format --branch`. @param {string} b */
export const validBranch = (b) => /^[A-Za-z0-9._/-]+$/.test(b) && !/(^[-/.]|[/.]$|\.\.|\/\/|\/\.|\.lock$|@\{)/.test(b)
