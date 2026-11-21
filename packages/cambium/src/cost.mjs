// @ts-check
/**
 * Per-issue cost accounting. When a worker exits, its stream-json log's `result` event (`total_cost_usd`, `usage`)
 * is added to the issue's marker, per phase and overall, so the totals live on GitHub and survive a restart. Each
 * run is also added to a per-repo, per-day ledger in SQLite for the heartbeat's daily figures; losing that file
 * loses only the daily history.
 */
import { setMarker } from './issue-state.mjs'
import { resultEvent } from './tracing.mjs'

/**
 * @typedef {{ usd: number, input: number, output: number, cacheRead: number, cacheCreation: number, runs: number }} Tally
 * @typedef {'triage' | 'task' | 'rescue'} CostPhase
 * @typedef {{ total: Tally, triage: Tally, task: Tally, rescue: Tally, lastLog: string | null }} Cost
 *   `lastLog`: the stdout log of the last run counted, so a run is never counted twice.
 * @typedef {{ day: string, triage: number, task: number, rescue: number, total: number }} CostDay
 */

export const COST_PHASES = /** @type {const} */ (['triage', 'task', 'rescue'])

/** A worker row's `phase` → the cost phase it counts under. */
const PHASE_OF = /** @type {Record<string, CostPhase>} */ ({ dispatch: 'triage', task: 'task', rescue: 'rescue' })

/** @returns {Tally} */
export const zeroTally = () => ({ usd: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, runs: 0 })

const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** @param {any} t @returns {Tally} */
const tallyOf = (t) => ({
  usd: num(t?.usd),
  input: num(t?.input),
  output: num(t?.output),
  cacheRead: num(t?.cacheRead),
  cacheCreation: num(t?.cacheCreation),
  runs: num(t?.runs),
})

/** @param {Tally} a @param {Tally} b @returns {Tally} */
const plus = (a, b) => ({
  usd: Math.round((a.usd + b.usd) * 1e6) / 1e6,
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheCreation: a.cacheCreation + b.cacheCreation,
  runs: a.runs + b.runs,
})

/**
 * A marker's cost, zeros when it has none (a marker from before cost accounting) or it is malformed.
 * @param {{ cost?: unknown } | null | undefined} marker @returns {Cost}
 */
export function costOf(marker) {
  const c = /** @type {any} */ (marker?.cost)
  return {
    total: tallyOf(c?.total),
    triage: tallyOf(c?.triage),
    task: tallyOf(c?.task),
    rescue: tallyOf(c?.rescue),
    lastLog: typeof c?.lastLog === 'string' ? c.lastLog : null,
  }
}

/**
 * One run's cost and tokens from its stream-json log, or null when the log has no `result` event (a killed
 * worker, a truncated log) or it carries no cost. Never throws.
 * @param {string | Iterable<string | Record<string, any>>} stream @returns {Tally | null}
 */
export function runCost(stream) {
  let r
  try {
    r = resultEvent(stream)
  } catch {
    return null
  }
  if (!r || typeof r.total_cost_usd !== 'number' || !Number.isFinite(r.total_cost_usd)) return null
  const u = r.usage ?? {}
  return {
    usd: num(r.total_cost_usd),
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreation: num(u.cache_creation_input_tokens),
    runs: 1,
  }
}

/**
 * `cost` with one more run added to `phase` and the total. A run whose log was the last one counted is not added
 * again.
 * @param {unknown} cost a marker's `cost`, possibly missing @param {CostPhase} phase @param {Tally} run
 * @param {string | null} log @returns {Cost}
 */
export function addCost(cost, phase, run, log) {
  const c = costOf({ cost })
  if (log && c.lastLog === log) return c
  return { ...c, total: plus(c.total, run), [phase]: plus(c[phase], run), lastLog: log ?? c.lastLog }
}

/** The UTC day of a time, `YYYY-MM-DD`. @param {number} ms */
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

/**
 * A finished worker's cost onto its issue's marker (and the day's ledger). Nothing happens when the worker phase
 * is not counted, the log has no `result` (a killed worker), or this run was already counted. Never throws:
 * accounting must not fail a tick.
 *
 * @param {{ config: import('./config.mjs').Config, github: import('./github.mjs').GitHub,
 *   spawner: { readLog(path: string): string },
 *   store: { addCost?(repo: string, day: string, phase: string, run: Tally): void },
 *   log: (level: 'info' | 'warn' | 'error', msg: string, where?: { repo?: string, issue?: number }) => void }} deps
 * @param {import('./github.mjs').Issue | null | undefined} issue
 * @param {{ repo: string, issue: number, phase: string, stdout: string }} w @param {number} now
 * @returns {Promise<Cost | null>} the marker's new cost, when one was recorded
 */
export async function recordCost(deps, issue, w, now) {
  const phase = PHASE_OF[w.phase]
  if (!phase) return null
  try {
    const run = runCost(deps.spawner.readLog(w.stdout))
    if (!run) return null
    const marker = issue?.stateComment?.marker
    if (marker && costOf(marker).lastLog === w.stdout) return null
    let cost = null
    if (issue && marker) {
      cost = addCost(marker.cost, phase, run, w.stdout)
      await setMarker(deps, w.repo, issue, { ...marker, cost })
    }
    deps.store.addCost?.(w.repo, dayOf(now), phase, run)
    return cost
  } catch (err) {
    deps.log('warn', `cost: ${/** @type {Error} */ (err)?.message ?? err}`, { repo: w.repo, issue: w.issue })
    return null
  }
}

/**
 * Whether an issue's task spend is over `flagUsd` with no merged PR for it: a candidate for a human session.
 * `flagUsd` 0 switches the flag off.
 * @param {Cost} cost @param {number} flagUsd @param {boolean} merged
 */
export const overBudget = (cost, flagUsd, merged) => flagUsd > 0 && cost.task.usd > flagUsd && !merged

/**
 * Ledger rows → one entry per day (oldest first), each phase's spend and the total.
 * @param {{ day: string, phase: string, usd: number }[]} rows @returns {CostDay[]}
 */
export function costDays(rows) {
  /** @type {Map<string, CostDay>} */
  const days = new Map()
  for (const r of rows) {
    const d = days.get(r.day) ?? { day: r.day, triage: 0, task: 0, rescue: 0, total: 0 }
    const usd = num(r.usd)
    if (r.phase === 'triage' || r.phase === 'task' || r.phase === 'rescue') d[r.phase] = round(d[r.phase] + usd)
    d.total = round(d.total + usd)
    days.set(r.day, d)
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
}

const round = (/** @type {number} */ n) => Math.round(n * 1e6) / 1e6
