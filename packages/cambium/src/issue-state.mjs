// @ts-check
/**
 * GitHub writes shared by both engines. Each updates the in-memory issue so
 * later steps in the same tick see it.
 */
import { apply } from './labels.mjs'
import { newMarker, renderMarker } from './marker.mjs'

/**
 * @typedef {import('./github.mjs').Issue} Issue
 * @typedef {{ config: import('./config.mjs').Config, github: import('./github.mjs').GitHub }} Writers
 */

export const MIN = 60_000
export const iso = (/** @type {number} */ ms) => new Date(ms).toISOString()
export const key = (/** @type {string} */ slug, /** @type {number} */ n) => `${slug}#${n}`

/** @param {Writers} deps @param {string} slug @param {Issue} issue @param {{ add: string[], remove: string[] }} change */
export async function setLabels(deps, slug, issue, change) {
  if (!change.add.length && !change.remove.length) return
  await deps.github.label(slug, issue.number, change)
  issue.labels = apply(issue.labels, change)
}

/** @param {Writers} deps @param {string} slug @param {Issue} issue @param {import('./marker.mjs').Marker} marker */
export async function setMarker(deps, slug, issue, marker) {
  // A traced graph turn keeps its issue trace on the subject (tracing.mjs `turnTracer`); a marker without one
  // takes it, so later ticks parent on the same trace. One that already has a trace keeps it.
  const tp = /** @type {any} */ (deps).subject?.traceparent
  if (tp && !marker.traceparent) marker = { ...marker, traceparent: tp }
  const maxAttempts = deps.config.phases[marker.phase]?.maxAttempts
  const id = await deps.github.writeState(
    slug,
    issue.number,
    issue.stateComment?.id ?? null,
    renderMarker(marker, { maxAttempts }),
  )
  issue.stateComment = { id, marker }
}

/** @param {Issue} issue */
export const markerOf = (issue) => issue.stateComment?.marker ?? newMarker()

/** @param {import('./github.mjs').PullRequest} pr */
export function failureSummary(pr) {
  const lines = pr.failing.map(
    (f) => `${f.name}${f.url ? ` (${f.url})` : ''}${f.summary ? `\n  ${f.summary.replace(/\n/g, '\n  ')}` : ''}`,
  )
  return `CI red on PR #${pr.number} at ${(pr.headSha ?? '').slice(0, 7)}:\n${lines.join('\n') || '(no failing check reported)'}`
}
