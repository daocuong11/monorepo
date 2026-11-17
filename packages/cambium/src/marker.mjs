// @ts-check
/**
 * The cambium-owned state comment: a hidden JSON marker that is the truth,
 * plus a human-readable rendering of it. One per issue; cambium edits it in
 * place on every transition.
 */

/**
 * @typedef {'queued' | 'running' | 'submitted' | 'human' | 'done'} Stage
 * @typedef {{ at: string, attempt: number, outcome: string, reason?: string, pr?: number, log?: string }} HistoryEntry
 * @typedef {{
 *   v: 1,
 *   phase: 'task' | 'dispatch',
 *   stage: Stage,
 *   attempt: number,
 *   pr: number | null,
 *   branch: string | null,
 *   host: string | null,
 *   start: string | null,
 *   submittedAt?: string | null,
 *   queued?: boolean,
 *   failedSha?: string | null,
 *   lastFailure?: string | null,
 *   history: HistoryEntry[],
 * }} Marker
 */

const PREFIX = '<!-- cambium:state '
const RE = /<!-- cambium:state (.*?) -->/s
const HISTORY_KEPT = 20

/** @param {Partial<Marker>} [from] @returns {Marker} */
export function newMarker(from = {}) {
  return {
    v: 1,
    phase: 'task',
    stage: 'queued',
    attempt: 1,
    pr: null,
    branch: null,
    host: null,
    start: null,
    history: [],
    ...from,
  }
}

/** @param {string | null | undefined} body @returns {Marker | null} */
export function parseMarker(body) {
  const m = RE.exec(body ?? '')
  if (!m) return null
  try {
    const parsed = JSON.parse(m[1])
    return parsed && typeof parsed === 'object' ? newMarker(parsed) : null
  } catch {
    return null
  }
}

/** @param {Marker} marker @param {HistoryEntry} entry @returns {Marker} */
export const withHistory = (marker, entry) => ({ ...marker, history: [...marker.history, entry].slice(-HISTORY_KEPT) })

/**
 * The comment body. `--` inside the JSON would end the HTML comment early, so
 * it is written as a JSON escape.
 *
 * @param {Marker} marker
 * @param {{ maxAttempts?: number }} [opts]
 */
export function renderMarker(marker, { maxAttempts } = {}) {
  const json = JSON.stringify(marker).replace(/--/g, '-\\u002d')
  const of = maxAttempts ? `/${maxAttempts}` : ''
  const lines = [
    `${PREFIX}${json} -->`,
    `**cambium** · ${marker.phase} · ${marker.stage} · attempt ${marker.attempt}${of}` +
      (marker.pr ? ` · PR #${marker.pr}` : '') +
      (marker.host ? ` · host \`${marker.host}\`` : '') +
      (marker.start ? ` · started ${marker.start}` : ''),
  ]
  if (marker.lastFailure)
    lines.push(
      '',
      '<details><summary>Last failure</summary>',
      '',
      '```',
      marker.lastFailure.replace(/```/g, "'''"),
      '```',
      '</details>',
    )
  if (marker.history.length) {
    lines.push('', '| at | attempt | outcome | detail |', '|---|---|---|---|')
    for (const h of marker.history)
      lines.push(
        `| ${h.at} | ${h.attempt} | ${h.outcome} | ${[
          h.pr ? `#${h.pr}` : '',
          h.reason ?? '',
          h.log ? `log \`${h.log}\`` : '',
        ]
          .filter(Boolean)
          .join(' · ')
          .replace(/\|/g, '\\|')
          .replace(/\n/g, ' ')} |`,
      )
  }
  lines.push('', '_Written by cambium. Only cambium moves this issue’s labels._')
  return lines.join('\n')
}
