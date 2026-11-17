// @ts-check
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { main } from '../src/cli.mjs'
import { QUEUE_LABELS } from '../src/stack.mjs'

export const NOW = Date.parse('2026-11-16T12:00:00.000Z')
export const ALL_LABELS = QUEUE_LABELS.map((l) => l.name)

/** @param {Record<string, string>} [files] */
export function tempDir(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oakgreen-'))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

/** An in-memory GitHub that records every write; nothing leaves the process. */
export function fakeGithub(/** @type {Record<string, string[]>} */ labels = {}) {
  const created = /** @type {{ repo: string, label: any }[]} */ ([])
  /** @type {import('../src/github.mjs').GithubClient} */
  const client = {
    listLabels: async (repo) => {
      if (!labels[repo]) throw new Error(`404 ${repo}`)
      return [...labels[repo]]
    },
    createLabel: async (repo, label) => {
      created.push({ repo, label })
      labels[repo].push(label.name)
    },
  }
  return { client, created, labels }
}

/**
 * A fake exec answering by the tool's bin basename or command name.
 *
 * @param {Record<string, (args: string[]) => Partial<import('../src/tools.mjs').Result>>} routes
 */
export function fakeExec(routes) {
  const calls = /** @type {{ cmd: string, args: string[] }[]} */ ([])
  /** @type {import('../src/tools.mjs').Exec} */
  const exec = async (cmd, args) => {
    calls.push({ cmd, args })
    const key = cmd === process.execPath ? (/\/(\w+)\.mjs$/.exec(args[0])?.[1] ?? cmd) : cmd
    const rest = cmd === process.execPath ? args.slice(1) : args
    const route = routes[key]
    if (!route) return { code: 127, stdout: '', stderr: `${key}: not found` }
    return { code: 0, stdout: '', stderr: '', ...route(rest) }
  }
  return { exec, calls }
}

/**
 * Run the CLI with every port faked; returns exit code and captured output.
 *
 * @param {string[]} argv
 * @param {import('../src/cli.mjs').Ports} ports
 */
export async function run(argv, ports) {
  let out = ''
  let err = ''
  const code = await main(argv, {
    now: () => NOW,
    nodeVersion: '22.13.0',
    stdout: (s) => {
      out += s
    },
    stderr: (s) => {
      err += s
    },
    spawn: async () => {
      throw new Error('spawn not expected')
    },
    ...ports,
  })
  return { code, out, err }
}
