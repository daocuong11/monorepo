// @ts-check
/**
 * The process seams: a {@link Spawner} that starts a `claude -p` worker in its
 * own worktree and process group with its output in rotated log files on this
 * host, and {@link Procs} to probe and kill by pid.
 */
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { exec as defaultExec } from './github.mjs'

/**
 * @typedef {{
 *   repo: import('./config.mjs').Repo, issue: number, attempt: number, branch: string, phase: string,
 *   maxTurns: number, buildPrompt: (agentsMd: string | null) => string, foreground?: boolean,
 * }} StartSpec
 * @typedef {{ pid: number, worktree: string, stdout: string, stderr: string, prompt: string, exited: Promise<number | null> }} Started
 * @typedef {{
 *   start(spec: StartSpec): Promise<Started>,
 *   cleanup(w: { repo: import('./config.mjs').Repo, worktree: string }): Promise<void>,
 *   tail(path: string, lines?: number): string,
 * }} Spawner
 * @typedef {{ alive(pid: number): boolean, kill(pid: number): void }} Procs
 */

/** The workers' tools. Labels and the issue body are cambium's, so those graft verbs are denied. */
export const WORKER_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']
export const WORKER_DENIED = ['Bash(graft issue label:*)', 'Bash(graft issue edit:*)', 'Bash(gh:*)']

/** @param {import('./config.mjs').Config} config @param {number} maxTurns */
export const workerArgs = (config, maxTurns) => [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--max-turns',
  String(maxTurns),
  '--allowedTools',
  WORKER_TOOLS.join(','),
  '--disallowedTools',
  WORKER_DENIED.join(','),
  ...config.worker.args,
]

/** `owner/name` → a directory name. @param {string} slug */
export const slugDir = (slug) => slug.replace('/', '__')

/**
 * Keep the newest `keep` runs in a log directory. A run is every file sharing
 * the `a<attempt>-<stamp>` prefix; stamps sort lexically by time.
 *
 * @param {string} dir @param {number} keep
 */
export function rotateLogs(dir, keep) {
  if (!existsSync(dir)) return []
  const files = readdirSync(dir)
  const runOf = (/** @type {string} */ f) => f.split('.')[0]
  const stampOf = (/** @type {string} */ run) => run.slice(run.indexOf('-') + 1)
  const runs = [...new Set(files.map(runOf))].sort((a, b) => stampOf(b).localeCompare(stampOf(a)))
  const dropped = runs.slice(keep)
  for (const f of files) if (dropped.includes(runOf(f))) rmSync(join(dir, f), { force: true })
  return dropped
}

/** The last lines of a log file, or '' when it cannot be read. @param {string} path @param {number} [lines] */
export function tailFile(path, lines = 30) {
  try {
    const size = statSync(path).size
    const buf = Buffer.alloc(Math.min(size, 16 * 1024))
    const fd = openSync(path, 'r')
    try {
      const n = readSync(fd, buf, 0, buf.length, size - buf.length)
      return buf.subarray(0, n).toString('utf8').split('\n').filter(Boolean).slice(-lines).join('\n')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/**
 * @param {{ config: import('./config.mjs').Config, exec?: import('./github.mjs').Exec,
 *   spawnFn?: typeof spawn, stamp?: () => string }} opts
 * @returns {Spawner}
 */
export function processSpawner({
  config,
  exec = defaultExec,
  spawnFn = spawn,
  stamp = () => new Date().toISOString().replace(/[:.]/g, '-'),
}) {
  const git = (/** @type {string} */ repoPath, /** @type {string[]} */ args) => exec('git', ['-C', repoPath, ...args])
  return {
    async start({ repo, issue, attempt, branch, phase, maxTurns, buildPrompt, foreground = false }) {
      const worktree = join(config.paths.worktrees, slugDir(repo.slug), `issue-${issue}-a${attempt}`)
      if (config.worker.fetch) await git(repo.path, ['fetch', 'origin', repo.baseBranch])
      if (existsSync(worktree)) {
        await git(repo.path, ['worktree', 'remove', '--force', worktree]).catch(() => {})
        rmSync(worktree, { recursive: true, force: true })
      }
      mkdirSync(join(worktree, '..'), { recursive: true })
      await git(repo.path, ['worktree', 'add', '--detach', worktree, `origin/${repo.baseBranch}`])
      const agentsPath = join(worktree, 'AGENTS.md')
      const agentsMd = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : null

      const logDir = join(config.paths.logs, slugDir(repo.slug), `issue-${issue}`)
      mkdirSync(logDir, { recursive: true })
      const base = join(logDir, `a${attempt}-${stamp()}`)
      const files = { prompt: `${base}.prompt.md`, stdout: `${base}.out.log`, stderr: `${base}.err.log` }
      writeFileSync(files.prompt, buildPrompt(agentsMd))
      rotateLogs(logDir, config.logs.keepPerIssue)

      const fds = [openSync(files.prompt, 'r'), openSync(files.stdout, 'a'), openSync(files.stderr, 'a')]
      const env = {
        ...process.env,
        CAMBIUM_REPO: repo.slug,
        CAMBIUM_ISSUE: String(issue),
        CAMBIUM_PHASE: phase,
        CAMBIUM_BRANCH: branch,
        ...(config.worker.graftApp ? { GRAFT_APP: config.worker.graftApp } : {}),
      }
      /** @type {import('node:child_process').ChildProcess} */
      let child
      try {
        child = spawnFn(config.worker.command, workerArgs(config, maxTurns), {
          cwd: worktree,
          detached: !foreground,
          stdio: [fds[0], fds[1], fds[2]],
          env,
        })
      } finally {
        for (const fd of fds) closeSync(fd)
      }
      const exited = new Promise((res) => {
        child.on('exit', (code) => res(code))
        child.on('error', () => res(null))
      })
      if (!child.pid) throw new Error(`could not start ${config.worker.command} (is it on PATH?)`)
      if (!foreground) child.unref()
      return { pid: child.pid, worktree, ...files, exited }
    },
    async cleanup({ repo, worktree }) {
      await git(repo.path, ['worktree', 'remove', '--force', worktree]).catch(() => {})
    },
    tail: tailFile,
  }
}

/** @type {Procs} */
export const realProcs = {
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM'
    }
  },
  kill(pid) {
    // A detached worker leads its own process group: the negative pid takes its children with it.
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL')
        return
      } catch {}
    }
  },
}
