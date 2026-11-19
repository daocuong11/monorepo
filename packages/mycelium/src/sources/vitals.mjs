// @ts-check
import { envelope } from '../envelope.mjs'
import { requestJson } from '../http.mjs'
import { REPORTING_SCOPE } from '../jwt.mjs'
import { googleToken } from './play.mjs'

export const VITALS_BASE = 'https://playdeveloperreporting.googleapis.com/v1beta1'
/** Vitals data lands hourly at best; an hourly pass keeps well inside the Reporting API's quota. */
export const VITALS_INTERVAL_MS = 60 * 60_000
/** The Play Console permission the service account needs for the Reporting API. */
export const VITALS_PERMISSION = 'View app information (read-only)'
/** An issue not reported for this long is dropped from the cursor; if it returns it is new again. */
export const VITALS_FORGET_MS = 30 * 24 * 3_600_000
const PAGE_SIZE = 100
const MAX_PAGES = 10
const TRACE_MAX = 8_000

/**
 * What the cursor keeps per issue: the highest report count seen, the app
 * version range, and the last report time (for forgetting).
 *
 * @typedef {{ count: number, versions: string, last: number }} Seen
 * @typedef {{ issues: Record<string, Seen> }} VitalsCursor
 */

export const issuesPath = (/** @type {string} */ pkg, /** @type {string} */ token = '') =>
  `/apps/${pkg}/errorIssues:search?pageSize=${PAGE_SIZE}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`

export const reportsPath = (/** @type {string} */ pkg, /** @type {string} */ issueId) =>
  `/apps/${pkg}/errorReports:search?pageSize=1&filter=${encodeURIComponent(`errorIssueId = ${issueId}`)}`

/** The issue id: the last segment of `apps/{app}/errorIssues/{issue}`. */
export const issueId = (/** @type {any} */ issue) =>
  String(issue?.name ?? '')
    .split('/')
    .pop() ?? ''

const version = (/** @type {any} */ v) => (v?.versionCode ? String(v.versionCode) : '')

/** The affected app versions as `first..last` (or one code when they agree). */
export function versionRange(/** @type {any} */ issue) {
  const first = version(issue?.firstAppVersion)
  const last = version(issue?.lastAppVersion)
  return first === last ? first : `${first}..${last}`
}

/**
 * @param {any} issue
 * @param {string} packageName
 * @param {{ change: 'new' | 'count' | 'versions', previous?: Seen, trace?: string }} what
 */
export function issueEnvelope(issue, packageName, { change, previous, trace = '' }) {
  const count = Number(issue?.errorReportCount ?? 0)
  const versions = versionRange(issue)
  const kind = String(issue?.type ?? 'ERROR')
  const lines = [
    `${kind}: ${issue?.cause ?? '(unknown cause)'}`,
    `at ${issue?.location ?? '(unknown location)'}`,
    '',
    `${count} reports, ${issue?.distinctUsers ?? '?'} users in the last 24 hours; app versions ${versions || '?'}`,
  ]
  if (previous && change === 'count') lines.push(`Up from ${previous.count} reports.`)
  if (previous && change === 'versions') lines.push(`App versions were ${previous.versions || '?'}.`)
  if (trace)
    lines.push('', 'Sample report:', trace.length > TRACE_MAX ? `${trace.slice(0, TRACE_MAX)}\n[truncated]` : trace)
  return envelope({
    source: 'vitals',
    externalId: issueId(issue),
    receivedAt: issue?.lastErrorReportTime,
    author: 'Android vitals',
    title: `${kind}: ${issue?.cause ?? ''} at ${issue?.location ?? ''}`,
    body: lines.join('\n'),
    url: issue?.issueUri ?? null,
    meta: {
      packageName,
      type: kind,
      change,
      errorReportCount: count,
      distinctUsers: issue?.distinctUsers ?? null,
      appVersions: versions || null,
      osVersions: [issue?.firstOsVersion?.apiLevel, issue?.lastOsVersion?.apiLevel].filter(Boolean).join('..') || null,
    },
  })
}

/**
 * What changed since the cursor's record of an issue, or null when nothing
 * worth a comment did: a count no higher than before and the same versions.
 *
 * @param {Seen | undefined} seen
 * @param {{ count: number, versions: string }} now
 * @returns {'new' | 'count' | 'versions' | null}
 */
export function change(seen, now) {
  if (!seen) return 'new'
  if (now.versions !== seen.versions) return 'versions'
  if (now.count > seen.count) return 'count'
  return null
}

/**
 * Android vitals crash and ANR issues (Play Developer Reporting API), already
 * grouped by Google. One envelope per new issue, and one more whenever an
 * issue's 24-hour report count passes its highest yet or its app version range
 * changes; nothing for an issue that did neither.
 *
 * @param {{
 *   fetch: import('../http.mjs').Fetch,
 *   config: NonNullable<ReturnType<typeof import('./play.mjs').playConfig>>,
 *   sleep?: (ms: number) => Promise<void>,
 *   intervalMs?: number,
 * }} ports
 */
export function vitalsSource({ fetch, config, sleep, intervalMs = VITALS_INTERVAL_MS }) {
  const token = googleToken({ fetch, sleep, account: config.account, scope: REPORTING_SCOPE, label: 'vitals' })
  const get = async (/** @type {string} */ path, /** @type {number} */ now) => {
    try {
      return await requestJson({ fetch, sleep, label: 'vitals' }, `${VITALS_BASE}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${await token(now)}` },
      })
    } catch (err) {
      if (/** @type {any} */ (err)?.status !== 403) throw err
      throw new Error(
        `vitals: 403 from the Play Developer Reporting API; in Play Console > Users and permissions, give ${config.account.client_email} "${VITALS_PERMISSION}" for ${config.packageName} (${/** @type {Error} */ (err).message})`,
      )
    }
  }
  const sample = async (/** @type {string} */ id, /** @type {number} */ now) => {
    try {
      const body = await get(reportsPath(config.packageName, id), now)
      return String(body?.errorReports?.[0]?.reportText ?? '').trim()
    } catch {
      return '' // the trace is a nicety; the issue is filed without it
    }
  }

  return {
    name: 'vitals',
    intervalMs,
    /**
     * @param {VitalsCursor | null} cursor
     * @param {{ now: number, since: number }} at
     */
    async pull(cursor, { now }) {
      /** @type {any[]} */
      const issues = []
      let next = ''
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await get(issuesPath(config.packageName, next), now)
        issues.push(...(body?.errorIssues ?? []))
        next = body?.nextPageToken ?? ''
        if (!next) break
      }
      /** @type {Record<string, Seen>} */
      let state = {}
      for (const [id, s] of Object.entries(cursor?.issues ?? {})) if (now - s.last < VITALS_FORGET_MS) state[id] = s
      const before = JSON.stringify(state)
      /** @type {{ envelope: import('../envelope.mjs').Envelope | null, cursor: VitalsCursor }[]} */
      const items = []
      issues.sort((a, b) => Date.parse(a?.lastErrorReportTime) - Date.parse(b?.lastErrorReportTime))
      for (const issue of issues) {
        const id = issueId(issue)
        const last = Date.parse(issue?.lastErrorReportTime)
        if (!id || !Number.isFinite(last)) continue
        const seen = state[id]
        const snap = { count: Number(issue?.errorReportCount ?? 0), versions: versionRange(issue) }
        const what = change(seen, snap)
        state = { ...state, [id]: { count: Math.max(snap.count, seen?.count ?? 0), versions: snap.versions, last } }
        if (!what) continue
        const trace = what === 'new' ? await sample(id, now) : ''
        const e = issueEnvelope(issue, config.packageName, { change: what, previous: seen, trace })
        items.push({ envelope: e, cursor: { issues: state } })
      }
      // Times moved or old issues were forgotten with nothing to file: still save it.
      const final = JSON.stringify(state)
      if (final !== before && (items.length === 0 || JSON.stringify(items.at(-1)?.cursor.issues) !== final))
        items.push({ envelope: null, cursor: { issues: state } })
      return items
    },
  }
}
