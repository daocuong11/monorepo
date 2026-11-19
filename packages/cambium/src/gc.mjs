// @ts-check
/**
 * Worktree garbage collection. Every worktree under a repo's convention root
 * that no live worker and no live Claude Code session holds ends one of three ways:
 *
 *   complete — `graft status` says GitHub holds all of it: removed, with its local branch;
 *   stale    — idle `gc.staleDays` with work GitHub lacks: archived under `<home>/gc/`
 *              (a bundle of the commits the base lacks, the uncommitted diff, the untracked files), then removed;
 *   kept     — anything else, with the reason.
 *
 * A worktree touched within `gc.graceMinutes` is left alone; one whose directory is gone is pruned.
 * A lock is respected unless it names a Claude Code session whose process is gone.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { exec as defaultExec } from './github.mjs'
import { slugDir } from './workers.mjs'

const MIN = 60_000
const DAY = 24 * 60 * MIN

/**
 * @typedef {{ path: string, head: string | null, branch: string | null, locked: string | null, prunable: boolean }} Entry
 * @typedef {'removed' | 'archived' | 'pruned' | 'kept' | 'skipped'} Action
 * @typedef {{ repo: string, worktree: string, action: Action, reason: string | null, archive?: string }} Outcome
 * @typedef {{
 *   config: import('./config.mjs').Config,
 *   store: Pick<import('./store.mjs').Store, 'workers'>,
 *   spawner: Pick<import('./workers.mjs').Spawner, 'convention' | 'held' | 'cleanup'>,
 *   procs: Pick<import('./workers.mjs').Procs, 'alive'>,
 *   now: () => number,
 *   exec?: import('./github.mjs').Exec,
 *   stamp?: () => string,
 * }} GcDeps
 * @typedef {{ dryRun?: boolean, repo?: string }} GcOptions
 */

/** @type {Record<string, (e: Entry, v: string) => void>} */
const FIELDS = {
  worktree: (e, v) => {
    e.path = v
  },
  HEAD: (e, v) => {
    e.head = v
  },
  branch: (e, v) => {
    e.branch = v.replace(/^refs\/heads\//, '')
  },
  locked: (e, v) => {
    e.locked = v
  },
  prunable: (e) => {
    e.prunable = true
  },
}

/** `git worktree list --porcelain` → its entries. @param {string} out @returns {Entry[]} */
export function parseWorktrees(out) {
  return out
    .split(/\n\s*\n/)
    .filter((b) => b.trim())
    .map((block) => {
      /** @type {Entry} */
      const e = { path: '', head: null, branch: null, locked: null, prunable: false }
      for (const line of block.split('\n')) {
        const at = line.indexOf(' ')
        const [k, v] = at === -1 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)]
        FIELDS[k]?.(e, v)
      }
      return e
    })
}

/** A Claude Code session lock's reason → its pid and start (UTC), or null. @param {string} reason */
export function sessionLock(reason) {
  const m = /^claude session .*\(pid (\d+) start ([^)]+)\)$/.exec(reason.trim())
  return m ? { pid: Number(m[1]), start: m[2] } : null
}

/** `child` is strictly inside `root`. @param {string} root @param {string} child */
export const inside = (root, child) => {
  const rel = relative(root, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** @param {string} p */
const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** @param {string} s */
const utc = (s) => Date.parse(`${s.trim().replace(/\s+/g, ' ')} UTC`)

/**
 * Whether a lock still holds. Anything but a Claude Code session lock always does; a session lock
 * holds while its pid is alive with the start it names. An unreadable start counts as a match.
 *
 * @param {GcDeps} deps @param {string | null} reason
 */
export async function lockHolds(deps, reason) {
  if (reason === null) return false
  const s = sessionLock(reason)
  if (!s) return true
  if (!deps.procs.alive(s.pid)) return false
  const run = deps.exec ?? defaultExec
  const out = await run('ps', ['-o', 'lstart=', '-p', String(s.pid)], { env: { ...process.env, TZ: 'UTC' } }).catch(
    () => '',
  )
  const [a, b] = [utc(out), utc(s.start)]
  return Number.isNaN(a) || Number.isNaN(b) || Math.abs(a - b) < 2000
}

/** @param {string} p */
const mtime = (p) => {
  try {
    return lstatSync(p).mtimeMs
  } catch {
    return 0
  }
}

/** The worktree's git directory, from its `.git` file. @param {string} wt */
function gitDirOf(wt) {
  try {
    const m = /^gitdir: (.+)$/m.exec(readFileSync(join(wt, '.git'), 'utf8'))
    return m ? resolve(wt, m[1].trim()) : null
  } catch {
    return null
  }
}

/**
 * The last time anything in a worktree moved: its directory, its HEAD and reflog, and every path
 * `git status` reports. Not the index: any `git status` (graft's included) rewrites it.
 *
 * @param {(args: string[]) => Promise<string>} git runs in the worktree @param {string} wt
 */
export async function lastActivity(git, wt) {
  const gd = gitDirOf(wt)
  const paths = [wt, ...(gd ? ['HEAD', 'logs/HEAD'].map((f) => join(gd, f)) : [])]
  const status = await git([
    '--no-optional-locks',
    'status',
    '--porcelain',
    '-z',
    '--no-renames',
    '--untracked-files=all',
  ]).catch(() => '')
  for (const rec of status.split('\0')) if (rec.length > 3) paths.push(join(wt, rec.slice(3)))
  return Math.max(...paths.map(mtime))
}

/**
 * Save what GitHub may lack before a stale worktree goes: `commits.bundle` (HEAD less the base),
 * `changes.patch` (`git diff --binary HEAD`), `untracked/`, and `worktree.json`.
 *
 * @param {GcDeps} deps @param {import('./config.mjs').Repo} repo @param {Entry} e
 * @param {(args: string[]) => Promise<string>} git runs in the worktree @param {string} why
 * @returns {Promise<string>} the archive directory
 */
export async function archive(deps, repo, e, git, why) {
  const stamp = (deps.stamp ?? (() => new Date(deps.now()).toISOString().replace(/[:.]/g, '-')))()
  const dir = join(deps.config.paths.home, 'gc', slugDir(repo.slug), `${basename(e.path)}-${stamp}`)
  mkdirSync(dir, { recursive: true })
  const base = `refs/remotes/origin/${repo.baseBranch}`
  const not = (await git(['rev-parse', '--verify', '-q', base]).catch(() => '')).trim() ? ['--not', base] : []
  const ahead = Number((await git(['rev-list', '--count', 'HEAD', ...not]).catch(() => '0')).trim())
  if (ahead > 0) await git(['bundle', 'create', join(dir, 'commits.bundle'), 'HEAD', ...not])
  const diff = await git(['diff', '--binary', 'HEAD']).catch(() => '')
  if (diff) writeFileSync(join(dir, 'changes.patch'), diff)
  const untracked = (await git(['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
  for (const f of untracked) {
    mkdirSync(dirname(join(dir, 'untracked', f)), { recursive: true })
    cpSync(join(e.path, f), join(dir, 'untracked', f), { recursive: true, verbatimSymlinks: true })
  }
  const info = { worktree: e.path, branch: e.branch, head: e.head, commits: ahead, reason: why, at: stamp }
  writeFileSync(join(dir, 'worktree.json'), `${JSON.stringify(info, null, 2)}\n`)
  return dir
}

/**
 * @typedef {{
 *   repo: import('./config.mjs').Repo, e: Entry, dryRun: boolean, workers: Set<string>,
 *   git: (args: string[], cwd?: string) => Promise<string>,
 * }} One
 */

/** Why this worktree is not looked at, or null. @param {GcDeps} deps @param {One} one */
async function skipped(deps, { e, workers }) {
  if (workers.has(real(e.path))) return 'a cambium worker holds it'
  if (await lockHolds(deps, e.locked)) return `locked: ${e.locked || 'no reason given'}`
  return null
}

/** @param {number} ms */
const ago = (ms) => (ms >= DAY ? `${Math.floor(ms / DAY)}d` : `${Math.floor(ms / MIN)}m`)

/** @param {GcDeps} deps @param {One} one @returns {Promise<Omit<Outcome, 'repo' | 'worktree'>>} */
async function collectOne(deps, one) {
  const { repo, e, dryRun, git } = one
  if (e.prunable || !existsSync(e.path)) return { action: 'pruned', reason: 'its directory is gone' }
  const skip = await skipped(deps, one)
  if (skip) return { action: 'skipped', reason: skip }
  const wt = (/** @type {string[]} */ args) => git(args, e.path)
  const idle = deps.now() - (await lastActivity(wt, e.path))
  if (idle < deps.config.gc.graceMinutes * MIN) return { action: 'skipped', reason: `active ${ago(idle)} ago` }
  const w = { repo, worktree: e.path, branch: e.branch ?? '' }
  const h = await deps.spawner.held(w)
  if (h.clean) return complete(deps, one, w)
  if (idle < deps.config.gc.staleDays * DAY) return { action: 'kept', reason: h.reason }
  const why = `stale: idle ${ago(idle)}; ${h.reason}`
  if (dryRun) return { action: 'archived', reason: why }
  const dir = await archive(deps, repo, e, wt, why)
  await git(['worktree', 'remove', '--force', '--force', e.path])
  if (e.branch) await git(['branch', '-D', e.branch]).catch(() => {})
  return { action: 'archived', reason: why, archive: dir }
}

/**
 * @param {GcDeps} deps @param {One} one @param {{ repo: import('./config.mjs').Repo, worktree: string, branch: string }} w
 * @returns {Promise<Omit<Outcome, 'repo' | 'worktree'>>}
 */
async function complete(deps, { e, dryRun, git }, w) {
  const reason = 'complete: GitHub holds all of it'
  if (dryRun) return { action: 'removed', reason }
  if (e.locked !== null) await git(['worktree', 'unlock', e.path])
  const t = await deps.spawner.cleanup(w)
  return t.removed ? { action: 'removed', reason } : { action: 'kept', reason: t.reason }
}

/**
 * Collect one repo's worktrees. Only those under its convention root are looked at, never the checkout itself.
 *
 * @param {GcDeps} deps @param {import('./config.mjs').Repo} repo @param {boolean} dryRun
 * @returns {Promise<Outcome[]>}
 */
async function collectRepo(deps, repo, dryRun) {
  const run = deps.exec ?? defaultExec
  const git = (/** @type {string[]} */ args, cwd = repo.path) => run('git', ['-C', cwd, ...args])
  const root = real(deps.spawner.convention(repo).root)
  const workers = new Set(
    deps.store
      .workers()
      .filter((w) => w.repo === repo.slug)
      .map((w) => real(w.worktree)),
  )
  const entries = parseWorktrees(await git(['worktree', 'list', '--porcelain'])).filter((e) => inside(root, e.path))
  /** @type {Outcome[]} */
  const out = []
  for (const e of entries) {
    try {
      out.push({ repo: repo.slug, worktree: e.path, ...(await collectOne(deps, { repo, e, dryRun, workers, git })) })
    } catch (err) {
      out.push({
        repo: repo.slug,
        worktree: e.path,
        action: 'kept',
        reason: /** @type {Error} */ (err)?.message ?? String(err),
      })
    }
  }
  if (!dryRun && out.some((o) => o.action === 'pruned')) await git(['worktree', 'prune']).catch(() => {})
  return out
}

/**
 * Collect every configured repo's worktrees (or only `repo`'s). `dryRun` reports what would happen.
 *
 * @param {GcDeps} deps @param {GcOptions} [opts]
 * @returns {Promise<Outcome[]>}
 */
export async function collectGarbage(deps, { dryRun = false, repo } = {}) {
  /** @type {Outcome[]} */
  const out = []
  for (const r of deps.config.repos) if (!repo || r.slug === repo) out.push(...(await collectRepo(deps, r, dryRun)))
  return out
}

/** One line per outcome. @param {Outcome} o */
export const describe = (o) =>
  `${o.action.padEnd(8)} ${o.worktree}${o.reason ? `  (${o.reason})` : ''}${o.archive ? `\n         archive ${o.archive}` : ''}`

/**
 * The daemon's sweep: at most one run at a time, never awaited by the tick (a run checks each worktree
 * with GitHub and can outlast a step). What it removed, archived or pruned is logged.
 *
 * @param {GcDeps} deps @param {import('./tick.mjs').Deps['log']} log
 * @returns {() => Promise<Outcome[] | null>} null while a run is in flight
 */
export function gcRunner(deps, log) {
  /** @type {Promise<Outcome[]> | null} */
  let running = null
  return () => {
    if (running) return Promise.resolve(null)
    running = collectGarbage(deps)
      .then((out) => {
        for (const o of out)
          if (o.action !== 'kept' && o.action !== 'skipped') log('info', `gc: ${describe(o)}`, { repo: o.repo })
        return out
      })
      .catch((err) => {
        log('error', `gc: ${/** @type {Error} */ (err)?.message ?? err}`)
        return []
      })
      .finally(() => {
        running = null
      })
    return running
  }
}
