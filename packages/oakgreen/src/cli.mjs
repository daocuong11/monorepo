// @ts-check
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { doctorOk, formatDoctor, runDoctor } from './doctor.mjs'
import { graftGithub } from './github.mjs'
import { runServices } from './services.mjs'
import { runSetup } from './setup.mjs'
import { TOOLS, defaultExec, defaultSpawn, isTool, toolCommand, toolRunner, which } from './tools.mjs'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const USAGE = `oakgreen ${PKG.version} — the oakgreen stack in one command

  oakgreen doctor [--json] [--repo owner/name] [--config <file>]
  oakgreen setup [--dry-run] [--repo owner/name] [--config <file>]
  oakgreen services [--json]    the stack's launchd agents (otelcol, cambium) and whether they run
  oakgreen restart [service...] new process for each (default: all installed), e.g. after an npm update
  oakgreen reload [service...]  also re-read each agent's plist (its env), waiting for the old one to stop
  oakgreen <tool> [args...]     run ${Object.keys(TOOLS).join(', ')}

--config is cambium's config (default $CAMBIUM_CONFIG, then ~/.cambium/config.json).
`

/**
 * @typedef {{
 *   env?: import('./stack.mjs').Env,
 *   home?: string,
 *   cwd?: string,
 *   now?: () => number,
 *   nodeVersion?: string,
 *   stdout?: (s: string) => void,
 *   stderr?: (s: string) => void,
 *   exec?: import('./tools.mjs').Exec,
 *   spawn?: import('./tools.mjs').Spawn,
 *   resolve?: (id: string) => string,
 *   which?: (name: string) => string | null,
 *   github?: import('./github.mjs').GithubClient,
 *   uid?: number,
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 *   sleep?: (ms: number) => Promise<unknown>,
 * }} Ports
 */

const OPTIONS = /** @type {const} */ ({
  json: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  repo: { type: 'string' },
  config: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
})

/**
 * @param {string[]} argv
 * @param {Ports} [ports]
 * @returns {Promise<number>}
 */
export async function main(argv, ports = {}) {
  const {
    env = process.env,
    home = homedir(),
    cwd = process.cwd(),
    now = Date.now,
    nodeVersion = process.versions.node,
    stdout = (s) => process.stdout.write(s),
    stderr = (s) => process.stderr.write(s),
    exec = defaultExec,
    spawn = defaultSpawn,
    resolve,
  } = ports
  const commandFor = (/** @type {import('./tools.mjs').Tool} */ t) => toolCommand(t, resolve ? { resolve } : {})
  const runTool = toolRunner(exec, commandFor)
  const [verb, ...rest] = argv

  if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
    stdout(USAGE)
    return verb ? 0 : 1
  }
  if (verb === '--version' || verb === '-v') {
    stdout(`${PKG.version}\n`)
    return 0
  }
  if (isTool(verb)) {
    const c = commandFor(verb)
    try {
      return await spawn(c.cmd, [...c.args, ...rest], { cwd })
    } catch (err) {
      const e = /** @type {NodeJS.ErrnoException} */ (err)
      if (e.code !== 'ENOENT') throw err
      stderr(`oakgreen: ${verb} not found; install it: npm install -g ${TOOLS[verb]}\n`)
      return 127
    }
  }
  if (verb === 'services' || verb === 'restart' || verb === 'reload') {
    const flags = rest.filter((a) => a.startsWith('-'))
    const bad = flags.filter((f) => !(verb === 'services' && f === '--json'))
    if (bad.length) {
      stderr(`oakgreen ${verb}: unknown option ${bad.join(' ')}\n`)
      return 2
    }
    return runServices(
      verb,
      rest.filter((a) => !a.startsWith('-')),
      {
        exec,
        home,
        uid: ports.uid ?? process.getuid?.() ?? 0,
        platform: ports.platform,
        exists: ports.exists,
        sleep: ports.sleep,
        now,
        json: flags.includes('--json'),
      },
      stdout,
      stderr,
    )
  }
  if (verb !== 'doctor' && verb !== 'setup') {
    stderr(`oakgreen: unknown command '${verb}'\n\n${USAGE}`)
    return 2
  }

  let values
  try {
    ;({ values } = parseArgs({ args: rest, options: OPTIONS, strict: true }))
  } catch (err) {
    stderr(`oakgreen ${verb}: ${/** @type {Error} */ (err).message}\n`)
    return 2
  }
  if (values.help) {
    stdout(USAGE)
    return 0
  }
  const github = ports.github ?? graftGithub((tool, args) => runTool(tool, args, { cwd }))
  const shared = { env, home, cwd, config: values.config, repo: values.repo, github }

  if (verb === 'doctor') {
    const checks = await runDoctor({
      ...shared,
      now: now(),
      nodeVersion,
      engines: PKG.engines.node,
      runTool,
      which: ports.which ?? ((name) => which(name, { env })),
    })
    const ok = doctorOk(checks)
    stdout(values.json ? `${JSON.stringify({ ok, checks }, null, 2)}\n` : formatDoctor(checks))
    return ok ? 0 : 1
  }

  const result = await runSetup({
    ...shared,
    dryRun: values['dry-run'],
    exec,
    print: (line) => stdout(`${line}\n`),
  })
  return result.ok ? 0 : 1
}
