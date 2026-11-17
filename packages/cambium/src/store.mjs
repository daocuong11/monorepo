// @ts-check
/**
 * Local bookkeeping in SQLite: live worker processes and the daemon's mode.
 * Never a queue — GitHub labels are the queue. Losing this file costs at most
 * a requeue (the sweep returns `running` issues with no tracked worker).
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * @typedef {'running' | 'paused' | 'draining'} Mode
 * @typedef {{
 *   repo: string, issue: number, phase: string, pid: number, worktree: string, branch: string,
 *   attempt: number, startedAt: number, host: string, stdout: string, stderr: string, killedReason: string | null,
 * }} Worker
 */

export const MODES = /** @type {const} */ (['running', 'paused', 'draining'])

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workers (
  repo TEXT NOT NULL, issue INTEGER NOT NULL, phase TEXT NOT NULL, pid INTEGER NOT NULL,
  worktree TEXT NOT NULL, branch TEXT NOT NULL, attempt INTEGER NOT NULL, started_at INTEGER NOT NULL,
  host TEXT NOT NULL, stdout TEXT NOT NULL, stderr TEXT NOT NULL, killed_reason TEXT,
  PRIMARY KEY (repo, issue)
);
CREATE TABLE IF NOT EXISTS control (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/** @param {any} r @returns {Worker} */
const toWorker = (r) => ({
  repo: r.repo,
  issue: Number(r.issue),
  phase: r.phase,
  pid: Number(r.pid),
  worktree: r.worktree,
  branch: r.branch,
  attempt: Number(r.attempt),
  startedAt: Number(r.started_at),
  host: r.host,
  stdout: r.stdout,
  stderr: r.stderr,
  killedReason: r.killed_reason ?? null,
})

/** @param {string} path a file, or `:memory:` */
export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  const get = (/** @type {string} */ key) =>
    /** @type {any} */ (db.prepare('SELECT value FROM control WHERE key = ?').get(key))?.value ?? null
  const set = (/** @type {string} */ key, /** @type {string} */ value) =>
    db
      .prepare('INSERT INTO control (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)

  return {
    /** @returns {Worker[]} */
    workers: () => db.prepare('SELECT * FROM workers ORDER BY started_at').all().map(toWorker),
    /** @param {string} repo @param {number} issue @returns {Worker | null} */
    worker(repo, issue) {
      const r = db.prepare('SELECT * FROM workers WHERE repo = ? AND issue = ?').get(repo, issue)
      return r ? toWorker(r) : null
    },
    /** @param {Omit<Worker, 'killedReason'>} w */
    addWorker(w) {
      db.prepare(
        `INSERT OR REPLACE INTO workers (repo, issue, phase, pid, worktree, branch, attempt, started_at, host, stdout, stderr, killed_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(w.repo, w.issue, w.phase, w.pid, w.worktree, w.branch, w.attempt, w.startedAt, w.host, w.stdout, w.stderr)
    },
    /** @param {string} repo @param {number} issue @param {string} reason */
    markKilled(repo, issue, reason) {
      db.prepare('UPDATE workers SET killed_reason = ? WHERE repo = ? AND issue = ?').run(reason, repo, issue)
    },
    /** @param {string} repo @param {number} issue */
    removeWorker(repo, issue) {
      db.prepare('DELETE FROM workers WHERE repo = ? AND issue = ?').run(repo, issue)
    },
    /** @returns {Mode} */
    mode: () => /** @type {Mode} */ (get('mode') ?? 'running'),
    /** @param {Mode} mode */
    setMode(mode) {
      if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`)
      set('mode', mode)
    },
    get,
    set,
    close: () => db.close(),
  }
}

/** @typedef {ReturnType<typeof openStore>} Store */
