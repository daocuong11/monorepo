// @ts-check
/**
 * Local bookkeeping in SQLite: live worker processes, the daemon's mode, and the per-day cost ledger (cost.mjs).
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
 *   traceparent: string | null, failures: number, retryAt: number | null, traced: boolean,
 * }} Worker
 *   `traceparent`: the span of the step that started it, when traced; its `claude.*` spans go under it on exit.
 *   `failures`, `retryAt`: consecutive failed reconciles of this row and when the next may run (tick.mjs `eachWorker`).
 *   `traced`: its `claude.*` spans were emitted; they are emitted once, however often the row is polled.
 */

export const MODES = /** @type {const} */ (['running', 'paused', 'draining'])

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workers (
  repo TEXT NOT NULL, issue INTEGER NOT NULL, phase TEXT NOT NULL, pid INTEGER NOT NULL,
  worktree TEXT NOT NULL, branch TEXT NOT NULL, attempt INTEGER NOT NULL, started_at INTEGER NOT NULL,
  host TEXT NOT NULL, stdout TEXT NOT NULL, stderr TEXT NOT NULL, killed_reason TEXT, traceparent TEXT,
  failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, traced INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, issue)
);
CREATE TABLE IF NOT EXISTS control (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS costs (
  repo TEXT NOT NULL, day TEXT NOT NULL, phase TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, day, phase)
);
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
  traceparent: r.traceparent ?? null,
  failures: Number(r.failures ?? 0),
  retryAt: r.retry_at == null ? null : Number(r.retry_at),
  traced: Boolean(r.traced),
})

/** @param {string} path a file, or `:memory:` */
export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  // Databases from before these columns existed.
  const cols = /** @type {{ name: string }[]} */ (db.prepare('PRAGMA table_info(workers)').all())
  const added = {
    traceparent: 'TEXT',
    failures: 'INTEGER NOT NULL DEFAULT 0',
    retry_at: 'INTEGER',
    traced: 'INTEGER NOT NULL DEFAULT 0',
  }
  for (const [name, type] of Object.entries(added))
    if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE workers ADD COLUMN ${name} ${type}`)
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
    /** @param {Omit<Worker, 'killedReason' | 'traceparent' | 'failures' | 'retryAt' | 'traced'> & { traceparent?: string | null }} w */
    addWorker(w) {
      db.prepare(
        `INSERT OR REPLACE INTO workers (repo, issue, phase, pid, worktree, branch, attempt, started_at, host, stdout, stderr, killed_reason, traceparent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        w.repo,
        w.issue,
        w.phase,
        w.pid,
        w.worktree,
        w.branch,
        w.attempt,
        w.startedAt,
        w.host,
        w.stdout,
        w.stderr,
        w.traceparent ?? null,
      )
    },
    /** @param {string} repo @param {number} issue @param {string} reason */
    markKilled(repo, issue, reason) {
      db.prepare('UPDATE workers SET killed_reason = ? WHERE repo = ? AND issue = ?').run(reason, repo, issue)
    },
    /**
     * One more failed reconcile of the row; it is not reconciled again before `retryAt`.
     * @param {string} repo @param {number} issue @param {number} retryAt @returns {number} the failures so far
     */
    noteFailure(repo, issue, retryAt) {
      db.prepare('UPDATE workers SET failures = failures + 1, retry_at = ? WHERE repo = ? AND issue = ?').run(
        retryAt,
        repo,
        issue,
      )
      const r = /** @type {any} */ (
        db.prepare('SELECT failures FROM workers WHERE repo = ? AND issue = ?').get(repo, issue)
      )
      return Number(r?.failures ?? 0)
    },
    /** @param {string} repo @param {number} issue */
    markTraced(repo, issue) {
      db.prepare('UPDATE workers SET traced = 1 WHERE repo = ? AND issue = ?').run(repo, issue)
    },
    /** @param {string} repo @param {number} issue */
    removeWorker(repo, issue) {
      db.prepare('DELETE FROM workers WHERE repo = ? AND issue = ?').run(repo, issue)
    },
    /**
     * Add one worker run to a repo's ledger for `day` (`YYYY-MM-DD`, UTC) and phase.
     * @param {string} repo @param {string} day @param {string} phase @param {import('./cost.mjs').Tally} run
     */
    addCost(repo, day, phase, run) {
      db.prepare(
        `INSERT INTO costs (repo, day, phase, usd, input, output, cache_read, cache_creation, runs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, day, phase) DO UPDATE SET usd = usd + excluded.usd, input = input + excluded.input,
           output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
           cache_creation = cache_creation + excluded.cache_creation, runs = runs + excluded.runs`,
      ).run(repo, day, phase, run.usd, run.input, run.output, run.cacheRead, run.cacheCreation, run.runs)
    },
    /**
     * The ledger from `since` (`YYYY-MM-DD`) on, oldest first.
     * @param {string} since @returns {{ repo: string, day: string, phase: string, usd: number, runs: number }[]}
     */
    costs: (since) =>
      db
        .prepare('SELECT repo, day, phase, usd, runs FROM costs WHERE day >= ? ORDER BY day, repo, phase')
        .all(since)
        .map((/** @type {any} */ r) => ({
          repo: r.repo,
          day: r.day,
          phase: r.phase,
          usd: Number(r.usd),
          runs: Number(r.runs),
        })),
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
