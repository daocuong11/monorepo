#!/usr/bin/env node
// @ts-check
// `pnpm start`: the local stack from this checkout, one prefixed log stream, Ctrl-C stops what it started.
// Dependencies are installed first (a no-op when current), so a fresh pull never starts against stale node_modules.
// canopy always runs under `node --watch`; cambium unless its lock says one already runs; mycelium only when configured.
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = (/** @type {string} */ tool) => join(root, 'packages', tool, 'bin', `${tool}.mjs`)
const COLORS = { canopy: 32, cambium: 35, mycelium: 36, start: 90 }
const tty = process.stdout.isTTY
const tag = (/** @type {keyof typeof COLORS} */ name) =>
  tty ? `\x1b[${COLORS[name]}m${name.padEnd(8)}\x1b[0m ` : `${name.padEnd(8)} `
const say = (/** @type {string} */ msg) => console.log(tag('start') + msg)

const install = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--reporter=silent'], {
  cwd: root,
  stdio: 'inherit',
})
if (install.status !== 0) {
  say('pnpm install failed; fix it and run pnpm start again')
  process.exit(install.status ?? 1)
}

/** @type {import('node:child_process').ChildProcess[]} */
const children = []

function run(/** @type {keyof typeof COLORS} */ name, /** @type {string[]} */ args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let elsewhere = ''
  for (const stream of [child.stdout, child.stderr]) {
    let buf = ''
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const held = /another cambium daemon is running \(pid (\d+)\)/.exec(line)
        if (held) elsewhere = held[1]
        else process.stdout.write(`${tag(name) + line}\n`)
      }
    })
  }
  child.on('exit', (code, signal) => {
    say(
      elsewhere ? `${name} already running (pid ${elsewhere}), leaving it alone` : `${name} exited (${signal ?? code})`,
    )
    children.splice(children.indexOf(child), 1)
    if (!children.length) process.exit(code ?? 0)
  })
  children.push(child)
}

run('cambium', [bin('cambium'), 'start'])

if (Object.keys(process.env).some((k) => k.startsWith('MYCELIUM_') && k !== 'MYCELIUM_REPO'))
  run('mycelium', [bin('mycelium'), 'run'])
else say('mycelium skipped: no MYCELIUM_* source configured')

run('canopy', ['--watch', bin('canopy'), ...process.argv.slice(2)])

for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(sig, () => {
    for (const child of children) child.kill('SIGTERM')
  })
}
