// @ts-check
/**
 * mycelium's intake sources, as `mycelium run` records them in its status file (mycelium's README, Status file:
 * `version: 1`), joined with what its `mycelium.intake` spans say it filed. canopy imports nothing of mycelium and never
 * opens its settings file: the status file names what each source reads, never its credentials.
 */
import { readFile } from 'node:fs/promises'

export const SUPPORTED_INTAKE_VERSION = 1
/** A source counts as overdue once its next pass is this late, or one interval late if that is longer. */
export const OVERDUE_GRACE_MS = 2 * 60_000
const DAY_MS = 24 * 3_600_000
const WEEK_MS = 7 * DAY_MS
export const RECENT_FILINGS = 25

/**
 * @typedef {'ok' | 'waiting' | 'failing' | 'overdue' | 'stopped' | 'off'} SourceState
 *   `waiting`: configured, no pass yet. `off`: not configured. `stopped`: mycelium stopped cleanly.
 * @typedef {{
 *   status: 'ok' | 'missing' | 'unreadable' | 'unknown-version',
 *   path: string,
 *   message: string | null,
 *   running: boolean,
 *   data: any,
 * }} IntakeStatus
 */

const arr = (/** @type {any} */ v) => (Array.isArray(v) ? v : [])
const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v ? v : null)
const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const time = (/** @type {unknown} */ v) => {
  const t = Date.parse(String(v ?? ''))
  return Number.isFinite(t) ? t : null
}

/** @param {any} l */
const lastOf = (l) =>
  l && typeof l === 'object'
    ? {
        at: str(l.at),
        ms: num(l.ms),
        ok: l.ok !== false && !l.error,
        created: num(l.created),
        commented: num(l.commented),
        skipped: num(l.skipped),
        error: str(l.error),
        message: str(l.message),
      }
    : null

/**
 * One source's state at `now`.
 *
 * @param {{ configured: boolean, intervalMs: number | null, last: any, nextAt: string | null }} s
 * @param {{ stopped: boolean, now: number }} at
 * @returns {SourceState}
 */
export function stateOf(s, { stopped, now }) {
  if (!s.configured) return 'off'
  if (stopped) return 'stopped'
  const next = time(s.nextAt)
  if (next !== null && now > next + Math.max(OVERDUE_GRACE_MS, s.intervalMs ?? 0)) return 'overdue'
  if (s.last && !s.last.ok) return 'failing'
  if (!s.last) return 'waiting'
  return 'ok'
}

/**
 * Judge an already-parsed status file. Never throws.
 *
 * @param {unknown} raw @param {{ path?: string, now?: number }} [o] @returns {IntakeStatus}
 */
export function judgeIntake(raw, { path = '', now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { status: 'unreadable', path, message: `${path} is not a JSON object`, running: false, data: null }
  const doc = /** @type {any} */ (raw)
  if (doc.version !== SUPPORTED_INTAKE_VERSION)
    return {
      status: 'unknown-version',
      path,
      message: `mycelium status version ${JSON.stringify(doc.version ?? null)} is not one canopy reads (expects ${SUPPORTED_INTAKE_VERSION}); upgrade canopy or mycelium so they agree`,
      running: false,
      data: null,
    }
  const stopped = Boolean(str(doc.stoppedAt))
  const sources = arr(doc.sources)
    .filter((s) => str(s?.name))
    .map((s) => {
      const src = {
        name: String(s.name),
        configured: s.configured === true,
        needs: str(s.needs),
        target: str(s.target),
        intervalMs: num(s.intervalMs),
        last: lastOf(s.last),
        nextAt: str(s.nextAt),
      }
      return { ...src, state: stateOf(src, { stopped, now }) }
    })
  const on = sources.filter((s) => s.configured)
  // Every configured source overdue: the process is gone without saying so (killed, or the machine slept).
  const quiet = !stopped && on.length > 0 && on.every((s) => s.state === 'overdue')
  const n = doc.notify
  const notify =
    n && typeof n === 'object'
      ? {
          channels: arr(n.channels).filter((c) => typeof c === 'string'),
          intervalMs: num(n.intervalMs),
          last: lastOf(n.last),
          nextAt: str(n.nextAt),
        }
      : null
  const updated = time(doc.updatedAt)
  return {
    status: 'ok',
    path,
    message: stopped
      ? `mycelium stopped ${doc.stoppedAt}; nothing is being read. Start it with: oakgreen start mycelium`
      : quiet
        ? `no source has run on time since ${doc.updatedAt ?? 'mycelium started'}. Check that mycelium is running: oakgreen services`
        : null,
    running: !stopped && !quiet,
    data: {
      version: doc.version,
      pid: num(doc.pid),
      host: str(doc.host),
      repo: str(doc.repo),
      startedAt: str(doc.startedAt),
      updatedAt: str(doc.updatedAt),
      ageMs: updated === null ? null : Math.max(0, now - updated),
      stoppedAt: str(doc.stoppedAt),
      sources,
      notify,
    },
  }
}

/**
 * Read and judge mycelium's status file.
 *
 * @param {string} path
 * @param {{ now?: number, read?: (p: string) => Promise<string> }} [o]
 * @returns {Promise<IntakeStatus>}
 */
export async function readIntake(path, { now = Date.now(), read = (p) => readFile(p, 'utf8') } = {}) {
  let text
  try {
    text = await read(path)
  } catch (err) {
    const missing = /** @type {any} */ (err)?.code === 'ENOENT'
    return {
      status: missing ? 'missing' : 'unreadable',
      path,
      message: missing
        ? `no mycelium status at ${path}: mycelium has not run here (oakgreen start mycelium), or it predates the status file, or --intake points elsewhere`
        : `cannot read ${path}: ${/** @type {Error} */ (err).message}`,
      running: false,
      data: null,
    }
  }
  try {
    return judgeIntake(JSON.parse(text), { path, now })
  } catch (err) {
    return {
      status: 'unreadable',
      path,
      message: `${path} is not JSON: ${/** @type {Error} */ (err).message}`,
      running: false,
      data: null,
    }
  }
}

/**
 * What mycelium filed, from its `mycelium.intake` spans: per source, issues opened and comments added in the last day
 * and week, failures, and the last filing; plus the newest filings across sources.
 *
 * @param {Map<string, import('./traces.mjs').Span[]>} traces
 * @param {number} now
 */
export function intakeActivity(traces, now) {
  /** @type {Record<string, { day: { created: number, commented: number, failed: number }, week: { created: number, commented: number, failed: number }, lastAt: number | null }>} */
  const bySource = {}
  /** @type {{ at: number, source: string, action: string | null, issue: number | null, externalId: string | null, failed: boolean, traceId: string }[]} */
  const filings = []
  for (const [traceId, spans] of traces)
    for (const sp of spans) {
      if (sp.name !== 'mycelium.intake') continue
      const source = str(sp.attrs['mycelium.source'])
      if (!source) continue
      const action = str(sp.attrs['mycelium.action'])
      const failed = sp.status === 'error'
      const issue = Number(sp.attrs['mycelium.issue.number'])
      filings.push({
        at: sp.end,
        source,
        action,
        issue: Number.isInteger(issue) && issue > 0 ? issue : null,
        externalId: str(sp.attrs['mycelium.external_id']),
        failed,
        traceId,
      })
      bySource[source] ??= {
        day: { created: 0, commented: 0, failed: 0 },
        week: { created: 0, commented: 0, failed: 0 },
        lastAt: null,
      }
      const b = bySource[source]
      b.lastAt = Math.max(b.lastAt ?? 0, sp.end)
      for (const [w, ms] of /** @type {const} */ ([
        ['day', DAY_MS],
        ['week', WEEK_MS],
      ]))
        if (sp.end >= now - ms) {
          if (failed) b[w].failed++
          else if (action === 'comment') b[w].commented++
          else b[w].created++
        }
    }
  filings.sort((a, b) => b.at - a.at)
  return { bySource, recent: filings.slice(0, RECENT_FILINGS) }
}
