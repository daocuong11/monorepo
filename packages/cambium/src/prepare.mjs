#!/usr/bin/env node
// @ts-check
/**
 * The prepare step, and the worker's entry point. The spawner starts
 * `node prepare.mjs -- <worker command…>` detached in the new worktree with
 * {@link PrepareSpec} in `$CAMBIUM_PREPARE`: it runs install-fresh, hydrate and
 * the repo's own `prepare` commands, then execs the worker. Running here
 * rather than in the tick keeps a minutes-long install from blocking it; the
 * output lands in the worker's stderr log, and a failure exits
 * {@link PREPARE_FAILED} with a {@link PREPARE_FAILED_LINE} line the
 * reconcile recognises.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {{ worktree: string, source: string } & Pick<import('./convention.mjs').Convention, 'install' | 'hydrate' | 'prepare'>} PrepareSpec
 * @typedef {(cmd: string, cwd: string) => number} Run a shell command; its exit status
 * @typedef {(from: string, to: string, opts: { clone: boolean }) => number} Copy a recursive copy; its exit status
 */

export const PREPARE_FAILED = 78
export const PREPARE_FAILED_LINE = 'cambium: prepare failed'

/**
 * Is `node_modules` the install of this lockfile? pnpm keeps a byte copy of
 * `pnpm-lock.yaml` at `node_modules/.pnpm/lock.yaml`. No package.json → there
 * is nothing to install.
 *
 * @param {string} root
 * @returns {'fresh' | 'stale' | 'none'}
 */
export function installState(root) {
  if (!existsSync(join(root, 'package.json'))) return 'none'
  const lock = join(root, 'pnpm-lock.yaml')
  const installed = join(root, 'node_modules', '.pnpm', 'lock.yaml')
  if (existsSync(lock) && existsSync(installed) && readFileSync(lock).equals(readFileSync(installed))) return 'fresh'
  return 'stale'
}

/** @param {string} path */
const populated = (path) => {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length > 0
  } catch {
    return false
  }
}

/** Anything at `path`, dangling symlinks included. @param {string} path */
const onDisk = (path) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** @type {Copy} */
function cpCopy(from, to, { clone }) {
  const flags = clone ? (process.platform === 'darwin' ? ['-Rc'] : ['-R', '--reflink=auto']) : ['-R']
  return spawnSync('cp', [...flags, from, to], { stdio: ['ignore', 2, 2] }).status ?? 1
}

/**
 * Copy the git-ignored `dirs` and `files` from the central checkout into the
 * worktree: a copy-on-write clone (`cp -c`, ~free on APFS), a byte copy when
 * the clone fails. Never a link: a write in the worktree must not reach the
 * checkout. What the worktree already has is left alone; what the source lacks
 * is reported and skipped. A copy that fails outright is removed and throws.
 *
 * @param {string} source @param {string} dest @param {{ dirs: string[], files: string[] }} lists
 * @param {{ say?: (line: string) => void, copy?: Copy }} [io]
 * @returns {string[]} what was copied
 */
export function hydrate(source, dest, { dirs, files }, { say = console.error, copy = cpCopy } = {}) {
  const done = []
  for (const rel of dirs) {
    const from = join(source, rel)
    const to = join(dest, rel)
    if (populated(to)) {
      say(`hydrate: ${rel} already present, left alone`)
      continue
    }
    if (!populated(from)) {
      say(`hydrate: ${rel} missing in ${source}; not copied`)
      continue
    }
    mkdirSync(dirname(to), { recursive: true })
    rmSync(to, { recursive: true, force: true })
    if (copy(from, to, { clone: true }) !== 0) {
      say(`hydrate: ${rel} clone failed, byte-copying`)
      rmSync(to, { recursive: true, force: true })
      if (copy(from, to, { clone: false }) !== 0) {
        // A half-copied dir passes every presence check downstream; an absent one is honest.
        rmSync(to, { recursive: true, force: true })
        throw new Error(`hydrate: could not copy ${rel} from ${source}`)
      }
    }
    say(`hydrate: ${rel} copied`)
    done.push(rel)
  }
  for (const rel of files) {
    const from = join(source, rel)
    const to = join(dest, rel)
    if (onDisk(to)) {
      say(`hydrate: ${rel} already present, left alone`)
      continue
    }
    if (!existsSync(from) || !statSync(from).isFile()) {
      say(`hydrate: ${rel} missing in ${source}; not copied`)
      continue
    }
    mkdirSync(dirname(to), { recursive: true })
    // FICLONE clones where it can and byte-copies where it cannot.
    copyFileSync(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    say(`hydrate: ${rel} copied`)
    done.push(rel)
  }
  return done
}

/** @type {Run} */
const shell = (cmd, cwd) => spawnSync('sh', ['-c', cmd], { cwd, stdio: ['ignore', 2, 2] }).status ?? 1

/**
 * install-fresh → hydrate → the repo's `prepare` commands, in the worktree.
 * Throws on the first failure.
 *
 * @param {PrepareSpec} spec
 * @param {{ run?: Run, copy?: Copy, say?: (line: string) => void }} [io]
 */
export function prepare(spec, { run = shell, copy, say = console.error } = {}) {
  const { worktree, source } = spec
  if (spec.install) {
    const state = installState(worktree)
    if (state === 'stale') {
      say(`install: ${spec.install}`)
      const code = run(spec.install, worktree)
      if (code !== 0) throw new Error(`install \`${spec.install}\` exited ${code}`)
    } else say(`install: ${state === 'fresh' ? 'node_modules matches the lockfile' : 'no package.json'}; skipped`)
  }
  hydrate(source, worktree, spec.hydrate, { say, ...(copy ? { copy } : {}) })
  for (const cmd of spec.prepare) {
    say(`prepare: ${cmd}`)
    const code = run(cmd, worktree)
    if (code !== 0) throw new Error(`prepare \`${cmd}\` exited ${code}`)
  }
}

/** The entry point: prepare, then become the worker. @param {string[]} argv */
async function main(argv) {
  const command = argv.slice(argv.indexOf('--') + 1)
  /** @type {PrepareSpec} */
  const spec = JSON.parse(process.env.CAMBIUM_PREPARE ?? 'null')
  try {
    prepare(spec)
  } catch (err) {
    console.error(`${PREPARE_FAILED_LINE}: ${/** @type {Error} */ (err)?.message ?? err}`)
    process.exit(PREPARE_FAILED)
  }
  const env = { ...process.env }
  delete env.CAMBIUM_PREPARE
  const child = spawn(command[0], command.slice(1), { cwd: spec.worktree, stdio: 'inherit', env })
  child.on('error', (err) => {
    console.error(`cambium: could not start ${command[0]}: ${err.message}`)
    process.exit(127)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2))
