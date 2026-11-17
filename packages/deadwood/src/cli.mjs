// @ts-check
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { applyBaseline, EMPTY, parseBaseline, toBaseline } from './baseline.mjs'
import { check, describe } from './check.mjs'
import { ConfigError, loadConfig } from './config.mjs'

export const HELP = `usage: deadwood [--json] [--update | --init] [-C <dir>]

Fails when a tracked .md/.mdx file is outside markdown.allow, or a tracked JS/TS
file's comment lines exceed comments.maxDensity of its non-blank lines.

  --json     machine-readable report on stdout
  --init     write the baseline from today's offenders (refused if one exists)
  --update   rewrite the baseline; it may only shrink, so new offenders still fail
  -C <dir>   repo root (default: cwd)

Exit: 0 clean, 1 offenders, 2 usage or config error.`

/**
 * @typedef {{
 *   cwd: string,
 *   stdout: (s: string) => void,
 *   stderr: (s: string) => void,
 *   listFiles: (root: string) => string[],
 *   readFile: (path: string) => string | null,
 *   writeFile: (path: string, text: string) => void,
 * }} Io
 */

/** @type {Io} */
export const NODE_IO = {
  cwd: process.cwd(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  listFiles: gitLsFiles,
  readFile: readOrNull,
  writeFile: (path, text) => writeFileSync(path, text),
}

/**
 * @param {string[]} argv
 * @param {Partial<Io>} [overrides]
 * @returns {number}
 */
export function run(argv, overrides = {}) {
  const io = { ...NODE_IO, ...overrides }
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    io.stderr(`deadwood: ${/** @type {Error} */ (err).message}\n${HELP}\n`)
    return 2
  }
  if (args.help) {
    io.stdout(`${HELP}\n`)
    return 0
  }
  const root = resolve(io.cwd, args.dir ?? '.')
  try {
    const { config } = loadConfig(root, { readFile: io.readFile })
    const files = io.listFiles(root)
    const { checked, offenders } = check({ files, config, read: (p) => io.readFile(join(root, p)) })
    const baselinePath = join(root, config.baseline)
    const baselineText = io.readFile(baselinePath)

    if (args.init) {
      if (baselineText != null) throw new ConfigError(`${config.baseline} exists; use --update`)
      io.writeFile(baselinePath, serialize(toBaseline(offenders)))
      io.stderr(`deadwood: wrote ${config.baseline} with ${offenders.length} entries\n`)
      return 0
    }

    const baseline = baselineText == null ? EMPTY : parseBaseline(baselineText)
    const { failing, tolerated, stale, shrunk } = applyBaseline(offenders, baseline)
    if (args.update && failing.length === 0 && stale.length > 0) {
      if (baselineText == null) throw new ConfigError(`no ${config.baseline}; use --init`)
      io.writeFile(baselinePath, serialize(shrunk))
    }
    const updated = args.update && failing.length === 0

    if (args.json) {
      const withReason = (o) => ({ ...o, reason: describe(o) })
      const report = {
        ok: failing.length === 0,
        checked,
        offenders: failing.map(withReason),
        tolerated: tolerated.map(withReason),
        stale: updated ? [] : stale,
      }
      io.stdout(`${JSON.stringify(report, null, 2)}\n`)
    } else {
      for (const o of failing) io.stdout(`${o.path}\t${o.rule}\t${describe(o)}\n`)
      if (stale.length && !updated) {
        io.stderr(`deadwood: ${stale.length} baseline entries can shrink; run deadwood --update\n`)
      }
      if (updated && stale.length) io.stderr(`deadwood: ${config.baseline} shrunk by ${stale.length} entries\n`)
      io.stderr(
        failing.length
          ? `deadwood: ${failing.length} offenders of ${checked} files checked\n`
          : `deadwood: ok, ${checked} files checked${tolerated.length ? `, ${tolerated.length} baselined` : ''}\n`,
      )
    }
    return failing.length ? 1 : 0
  } catch (err) {
    io.stderr(`deadwood: ${/** @type {Error} */ (err).message}\n`)
    return 2
  }
}

function parseArgs(argv) {
  const args = {
    json: false,
    update: false,
    init: false,
    help: false,
    dir: /** @type {string | undefined} */ (undefined),
  }
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]
    if (a === '--json') args.json = true
    else if (a === '--update') args.update = true
    else if (a === '--init') args.init = true
    else if (a === '--help' || a === '-h') args.help = true
    else if (a === '-C') {
      args.dir = argv[++k]
      if (args.dir === undefined) throw new Error('-C needs a directory')
    } else throw new Error(`unknown argument ${a}`)
  }
  if (args.update && args.init) throw new Error('--update and --init are exclusive')
  return args
}

function serialize(baseline) {
  return `${JSON.stringify(baseline, null, 2)}\n`
}

/** @param {string} root */
export function gitLsFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return out.split('\0').filter(Boolean)
}

/** @param {string} path */
function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code
    if (code === 'ENOENT' || code === 'EISDIR') return null
    throw err
  }
}
