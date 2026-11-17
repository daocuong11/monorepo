// @ts-check
import { execFile, spawn as nodeSpawn } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'

export const TOOLS = /** @type {const} */ ({
  graft: '@oakgreencc/graft',
  canker: '@oakgreencc/canker',
  deadwood: '@oakgreencc/deadwood',
  cambium: '@oakgreencc/cambium',
  mycelium: '@oakgreencc/mycelium',
  canopy: '@oakgreencc/canopy',
})

/** @typedef {keyof typeof TOOLS} Tool */
/** @typedef {{ cmd: string, args: string[] }} Command */
/** @typedef {{ code: number, stdout: string, stderr: string }} Result */
/** @typedef {(cmd: string, args: string[], opts?: { cwd?: string }) => Promise<Result>} Exec */
/** @typedef {(cmd: string, args: string[], opts: { cwd?: string }) => Promise<number>} Spawn */

const require = createRequire(import.meta.url)

/** @param {string} name @returns {name is Tool} */
export const isTool = (name) => Object.hasOwn(TOOLS, name)

/**
 * The installed package's bin, run with this Node; else the bare name, left to PATH.
 *
 * @param {Tool} tool
 * @param {{ resolve?: (id: string) => string }} [ports]
 * @returns {Command}
 */
export function toolCommand(tool, { resolve = require.resolve } = {}) {
  try {
    const manifest = resolve(`${TOOLS[tool]}/package.json`)
    const { bin } = JSON.parse(readFileSync(manifest, 'utf8'))
    const rel = typeof bin === 'string' ? bin : bin?.[tool]
    if (rel) return { cmd: process.execPath, args: [join(dirname(manifest), rel)] }
  } catch {}
  return { cmd: tool, args: [] }
}

/**
 * @param {string} name
 * @param {{ env?: Record<string, string | undefined> }} [ports]
 * @returns {string | null}
 */
export function which(name, { env = process.env } = {}) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const file = join(dir, name)
    try {
      accessSync(file, constants.X_OK)
      return file
    } catch {}
  }
  return null
}

/** @type {Exec} */
export const defaultExec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = /** @type {any} */ (err)
      const code = !e ? 0 : e.code === 'ENOENT' ? 127 : typeof e.code === 'number' ? e.code : 1
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr || (code === 127 ? e.message : '')) })
    })
  })

/** @type {Spawn} */
export const defaultSpawn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(cmd, args, { cwd: opts.cwd, stdio: 'inherit' })
    for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.on(sig, () => child.kill(sig))
    child.once('error', reject)
    child.once('close', (code, signal) => resolve(code ?? (signal ? 128 + signalNumber(signal) : 1)))
  })

/** @param {NodeJS.Signals} signal */
const signalNumber = (signal) => ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 })[signal] ?? 0

/**
 * Captured run of a stack tool, resolved the same way passthrough resolves it.
 *
 * @param {Exec} exec
 * @param {(tool: Tool) => Command} commandFor
 */
export const toolRunner =
  (exec, commandFor) =>
  /** @param {Tool} tool @param {string[]} args @param {{ cwd?: string }} [opts] */
  (tool, args, opts) => {
    const c = commandFor(tool)
    return exec(c.cmd, [...c.args, ...args], opts)
  }
