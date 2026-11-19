// @ts-check
/**
 * The process seams: a {@link Spawner} that starts a `claude -p` worker in its
 * own worktree (the target repo's convention, see convention.mjs) and process
 * group, behind the prepare step, with its output in rotated log files on this
 * host, and {@link Procs} to probe and kill by pid.
 */
import { spawn, spawnSync } from 'node:child_process'
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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConvention, topicOf } from './convention.mjs'
import { exec as defaultExec } from './github.mjs'

/**
 * @typedef {import('./convention.mjs').Convention} Convention
 * @typedef {{
 *   repo: import('./config.mjs').Repo, convention: Convention, issue: number, attempt: number, branch: string,
 *   phase: string, maxTurns: number, buildPrompt: (agentsMd: string | null) => string, foreground?: boolean,
 *   readOnly?: boolean, env?: Record<string, string>,
 * }} StartSpec
 *   `readOnly`: a disposable checkout for a worker that only reads (triage): detached at the base branch, no
 *   install, hydrate or prepare, no Edit/Write; `branch` only names its directory (see {@link topicOf}).
 *   `env`: added to the worker's environment after `config.worker.env` (the step's `TRACEPARENT`).
 * @typedef {{
 *   pid: number, worktree: string, stdout: string, stderr: string, prompt: string, exited: Promise<number | null>,
 *   reused: string | null,
 * }} Started `reused`: why the previous attempt's worktree was kept, when it was
 * @typedef {{ removed: boolean, reason: string | null }} Teardown
 * @typedef {{ clean: boolean, reason: string | null }} Held `clean`: `graft status` says GitHub holds all of it
 * @typedef {{
 *   convention(repo: import('./config.mjs').Repo): Convention,
 *   start(spec: StartSpec): Promise<Started>,
 *   cleanup(w: { repo: import('./config.mjs').Repo, worktree: string, branch: string, readOnly?: boolean }): Promise<Teardown>,
 *   held(w: { repo: import('./config.mjs').Repo, worktree: string, branch: string }): Promise<Held>,
 *   tail(path: string, lines?: number): string,
 *   readLog(path: string): string,
 * }} Spawner
 * @typedef {{ alive(pid: number): boolean, kill(pid: number): void }} Procs
 */

/** The workers' tools. Labels and the issue body are cambium's, so those graft verbs are denied. */
export const WORKER_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']
export const WORKER_DENIED = ['Bash(graft issue label:*)', 'Bash(graft issue edit:*)', 'Bash(gh:*)']

/** A read-only worker's tools: it reads code and issues; cambium makes every write on its verdict. */
export const READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash']
export const READONLY_DENIED = [
  ...WORKER_DENIED,
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash(graft publish:*)',
  'Bash(graft merge:*)',
  'Bash(graft pr:*)',
  'Bash(graft issue create:*)',
  'Bash(graft issue comment:*)',
  'Bash(graft issue close:*)',
  'Bash(graft issue assign:*)',
  'Bash(git commit:*)',
  'Bash(git push:*)',
]

/** @param {import('./config.mjs').Config} config @param {number} maxTurns @param {{ readOnly?: boolean }} [opts] */
export const workerArgs = (config, maxTurns, { readOnly = false } = {}) => [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--max-turns',
  String(maxTurns),
  '--allowedTools',
  (readOnly ? READONLY_TOOLS : WORKER_TOOLS).join(','),
  '--disallowedTools',
  (readOnly ? READONLY_DENIED : WORKER_DENIED).join(','),
  ...config.worker.args,
]

/** The last line `graft status` prints when the worktree holds nothing GitHub lacks. */
export const GRAFT_CLEAN = 'nothing local that GitHub does not have'

const PREPARE_MAIN = join(dirname(fileURLToPath(import.meta.url)), 'prepare.mjs')

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

/** A whole log file, or '' when it cannot be read. @param {string} path */
export function readLogFile(path) {
  try {
    return readFileSync(path, 'utf8')
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
  const graftEnv = { ...process.env, ...(config.graft.app ? { GRAFT_APP: config.graft.app } : {}) }

  /**
   * Fast-forward the central checkout to the just-fetched base, so the convention
   * and hydrate sources a worker gets are current. Only when that checkout sits on
   * the base branch with no tracked changes; `--ff-only` refuses rather than discards.
   *
   * @param {import('./config.mjs').Repo} repo @returns {Promise<boolean>} whether it moved
   */
  async function syncCentral(repo) {
    const head = (await git(repo.path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim()
    if (head !== repo.baseBranch) return false
    if ((await git(repo.path, ['status', '--porcelain', '--untracked-files=no'])).trim()) return false
    const before = (await git(repo.path, ['rev-parse', 'HEAD'])).trim()
    await git(repo.path, ['merge', '--ff-only', '--quiet', `origin/${repo.baseBranch}`]).catch(() => {})
    return (await git(repo.path, ['rev-parse', 'HEAD'])).trim() !== before
  }

  /**
   * Whether GitHub holds everything in a worktree, per `graft status`. An empty `branch` (a detached HEAD)
   * is left out of the call.
   *
   * @param {{ repo: import('./config.mjs').Repo, worktree: string, branch: string }} w
   * @returns {Promise<Held>}
   */
  async function held({ repo, worktree, branch }) {
    let out
    try {
      out = await exec(
        config.graft.command,
        ['status', ...(branch ? [branch] : []), '-C', worktree, '--repo', repo.slug],
        {
          cwd: worktree,
          env: graftEnv,
        },
      )
    } catch (err) {
      return { clean: false, reason: `graft status failed: ${/** @type {Error} */ (err)?.message ?? err}` }
    }
    const verdict = out.trim().split('\n').at(-1) ?? ''
    return verdict === GRAFT_CLEAN
      ? { clean: true, reason: null }
      : { clean: false, reason: verdict || 'graft status printed nothing' }
  }

  /**
   * Remove a worktree only once {@link held} says GitHub holds everything in
   * it; otherwise keep it and say why. Its local branch goes with it.
   *
   * @param {{ repo: import('./config.mjs').Repo, worktree: string, branch: string, readOnly?: boolean }} w
   * @returns {Promise<Teardown>}
   */
  async function teardown({ repo, worktree, branch, readOnly = false }) {
    if (readOnly) return dispose(repo, worktree)
    if (!existsSync(worktree)) {
      await git(repo.path, ['worktree', 'prune']).catch(() => {})
      return { removed: true, reason: null }
    }
    const h = await held({ repo, worktree, branch })
    if (!h.clean) return { removed: false, reason: h.reason }
    const head = (await git(worktree, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim()
    await git(repo.path, ['worktree', 'remove', '--force', worktree])
    if (head === branch) await git(repo.path, ['branch', '-D', branch]).catch(() => {})
    return { removed: true, reason: null }
  }

  /**
   * A read-only checkout holds nothing of value: it is removed outright, never checked with `graft status`.
   * @param {import('./config.mjs').Repo} repo @param {string} worktree @returns {Promise<Teardown>}
   */
  async function dispose(repo, worktree) {
    if (existsSync(join(worktree, '.git'))) await git(repo.path, ['worktree', 'remove', '--force', worktree])
    else {
      rmSync(worktree, { recursive: true, force: true })
      await git(repo.path, ['worktree', 'prune']).catch(() => {})
    }
    return { removed: true, reason: null }
  }

  return {
    convention: (repo) => readConvention(repo.path),
    async start({
      repo,
      convention,
      issue,
      attempt,
      branch,
      phase,
      maxTurns,
      buildPrompt,
      foreground = false,
      readOnly = false,
      env: extraEnv = {},
    }) {
      const worktree = join(convention.root, topicOf(branch))
      if (config.worker.fetch) {
        await git(repo.path, ['fetch', 'origin', repo.baseBranch])
        if (await syncCentral(repo)) {
          try {
            convention = readConvention(repo.path)
          } catch {
            // The updated package.json does not parse: keep the convention this tick read.
          }
        }
      }
      /** @type {string | null} */
      let reused = null
      if (readOnly) await dispose(repo, worktree)
      // The same topic every attempt: a leftover is removed if GitHub holds it all, else continued in.
      else if (existsSync(join(worktree, '.git'))) {
        const left = await teardown({ repo, worktree, branch })
        if (!left.removed) reused = left.reason
      } else rmSync(worktree, { recursive: true, force: true })
      if (!reused) {
        mkdirSync(dirname(worktree), { recursive: true })
        const at = `origin/${repo.baseBranch}`
        await git(
          repo.path,
          readOnly
            ? ['worktree', 'add', '--detach', worktree, at]
            : ['worktree', 'add', '--no-track', '-B', branch, worktree, at],
        )
      }
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
        ...(readOnly ? {} : { CAMBIUM_BRANCH: branch }),
        CAMBIUM_PREPARE: JSON.stringify(
          readOnly
            ? { worktree, source: repo.path, install: null, hydrate: { dirs: [], files: [] }, prepare: [] }
            : {
                worktree,
                source: repo.path,
                install: convention.install,
                hydrate: convention.hydrate,
                prepare: convention.prepare,
              },
        ),
        ...(config.worker.graftApp ? { GRAFT_APP: config.worker.graftApp } : {}),
        // config.worker.env (e.g. Claude Code's own telemetry), then this start's (TRACEPARENT).
        ...config.worker.env,
        ...extraEnv,
      }
      /** @type {import('node:child_process').ChildProcess} */
      let child
      try {
        child = spawnFn(
          process.execPath,
          [PREPARE_MAIN, '--', config.worker.command, ...workerArgs(config, maxTurns, { readOnly })],
          { cwd: worktree, detached: !foreground, stdio: [fds[0], fds[1], fds[2]], env },
        )
      } finally {
        for (const fd of fds) closeSync(fd)
      }
      const exited = new Promise((res) => {
        child.on('exit', (code) => res(code))
        child.on('error', () => res(null))
      })
      if (!child.pid) throw new Error(`could not start the worker (${process.execPath} ${PREPARE_MAIN})`)
      if (!foreground) child.unref()
      return { pid: child.pid, worktree, ...files, exited, reused }
    },
    cleanup: teardown,
    held,
    tail: tailFile,
    readLog: readLogFile,
  }
}

/**
 * Every pid under `root` in a `pid ppid` process table (`ps -A -o pid=,ppid=`), deepest last.
 * @param {number} root @param {string} table @returns {number[]}
 */
export function descendants(root, table) {
  /** @type {Map<number, number[]>} */
  const children = new Map()
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid === ppid) continue
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const out = []
  const seen = new Set([root])
  for (let i = -1; i < out.length; i++) {
    for (const c of children.get(i < 0 ? root : out[i]) ?? []) {
      if (seen.has(c)) continue
      seen.add(c)
      out.push(c)
    }
  }
  return out
}

/** @param {number} target */
function sigkill(target) {
  try {
    process.kill(target, 'SIGKILL')
    return true
  } catch {
    return false
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
    // The process group is not enough: Claude Code runs each Bash command in a group of its own, so a test
    // run the worker started outlives the group kill and loads the next attempt. Snapshot the tree first
    // (killed children reparent to launchd and drop out of it), then kill it and the group.
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
    const tree = ps.status === 0 ? descendants(pid, ps.stdout) : []
    // A detached worker leads its own process group: the negative pid takes its children with it.
    if (!sigkill(-pid)) sigkill(pid)
    for (const p of tree) sigkill(p)
  },
}
