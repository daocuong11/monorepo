// @ts-check
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { analyze } from './complexity.mjs'
import { ConfigError, loadConfig } from './config.mjs'
import { mergeCoverage, parseCoverage } from './coverage.mjs'
import { listFiles, matcher } from './files.mjs'
import { joinFile } from './join.mjs'
import { evaluate, identify, initial, ratchet } from './ratchet.mjs'
import { table } from './report.mjs'

export const HELP = `canker — per-function CRAP gate

usage: canker [--json] [--update | --init] [-C <dir>]

  CRAP = complexity² × (1 − coverage)³ + complexity, per function.
  Exits 0 when no function is over maxCrap (or over its baseline), 1 when one is, 2 on a usage or input error.

  --json     machine-readable result on stdout
  --update   ratchet the baseline: lower or drop entries, never add or raise
  --init     write the first baseline from today's offenders (refuses if one exists)
  -C <dir>   project root (default: cwd); config, globs and coverage paths resolve from here

Config: "canker" key in package.json, or canker.json:
  { "maxCrap": 30, "include": [...], "exclude": [...], "coverage": ["coverage/coverage-final.json", "coverage/lcov.info"], "baseline": "canker-baseline.json" }
`

class UsageError extends Error {}

/**
 * @param {{ argv: string[], cwd: string, stdout: (s: string) => void, stderr: (s: string) => void }} io
 * @returns {number} exit code
 */
export function main({ argv, cwd, stdout, stderr }) {
  try {
    return run(argv, cwd, stdout, stderr)
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConfigError || err instanceof InputError) {
      stderr(`canker: ${err.message}\n`)
      return 2
    }
    throw err
  }
}

class InputError extends Error {}

function run(argv, cwd, stdout, stderr) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        json: { type: 'boolean' },
        update: { type: 'boolean' },
        init: { type: 'boolean' },
        C: { type: 'string', short: 'C' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    })
  } catch (err) {
    throw new UsageError(`${/** @type {Error} */ (err).message}\n\n${HELP}`)
  }
  const opts = parsed.values
  if (opts.help) {
    stdout(HELP)
    return 0
  }
  if (opts.update && opts.init) throw new UsageError('--update and --init are exclusive')
  const root = resolve(cwd, opts.C ?? '.')
  const config = loadConfig(root)

  const coverage = mergeCoverage(
    config.coverage
      .map((p) => resolve(root, p))
      .filter((p) => existsSync(p))
      .map((p) => parseCoverage(readFileSync(p, 'utf8'), root)),
  )
  if (coverage.size === 0) {
    throw new InputError(`no coverage at ${config.coverage.join(', ')} — run the tests with coverage first`)
  }

  const entries = listFiles(root, matcher(config.include, config.exclude)).flatMap((file) => {
    let functions
    try {
      functions = analyze(readFileSync(resolve(root, file), 'utf8'), file)
    } catch (err) {
      throw new InputError(`${file}: ${/** @type {Error} */ (err).message}`)
    }
    return identify(file, joinFile(functions, coverage.get(resolve(root, file))))
  })

  const baselinePath = resolve(root, config.baseline)
  const hasBaseline = existsSync(baselinePath)
  let baseline = hasBaseline ? readBaseline(baselinePath) : {}

  if (opts.init) {
    if (hasBaseline) throw new UsageError(`${config.baseline} exists; use --update to lower it`)
    baseline = initial(entries, config.maxCrap)
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
    stderr(`canker: wrote ${config.baseline}\n`)
  } else if (opts.update && hasBaseline) {
    baseline = ratchet(baseline, entries, config.maxCrap)
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
    stderr(`canker: ratcheted ${config.baseline}\n`)
  }

  const { failing, baselined } = evaluate(entries, baseline, config.maxCrap)
  const ok = failing.length === 0
  if (opts.json) {
    const shape = (o) => ({
      file: o.file,
      line: o.start.line,
      name: o.id,
      complexity: o.complexity,
      coverage: Math.round(o.coverage * 10000) / 10000,
      crap: o.crap,
      baseline: o.baseline,
      status: o.status,
    })
    const result = {
      ok,
      maxCrap: config.maxCrap,
      functions: entries.length,
      offenders: failing.map(shape),
      baselined: baselined.map(shape),
    }
    stdout(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    if (failing.length) stdout(`${table(failing)}\n`)
    const tail = baselined.length ? `, ${baselined.length} baselined` : ''
    stdout(
      ok
        ? `canker: ${entries.length} functions, none over CRAP ${config.maxCrap}${tail}\n`
        : `canker: ${failing.length} of ${entries.length} functions over CRAP ${config.maxCrap}${tail}\n`,
    )
  }
  return ok ? 0 : 1
}

/** @param {string} path */
function readBaseline(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new InputError(`${path}: ${/** @type {Error} */ (err).message}`)
  }
}
