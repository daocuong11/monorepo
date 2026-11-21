// @ts-check
/**
 * Triage inputs: what a triage verdict was drawn from, hashed, so the daily re-triage can skip a `q:human` issue
 * nothing has changed on since triage answered needs-human (upkeep.mjs `retriage`).
 *
 * The fingerprint covers the issue's title and body, its labels (not cambium's own: `q:*`, `why:*`, `wait:*`,
 * `running`), the ids of its human comments (human-reply.mjs: not cambium, not a bot, not a state marker), its
 * GitHub `blockedBy` issues and their states, the agent PRs that name it and their states, and
 * {@link TRIAGE_RUBRIC}. `start-triage` records it on the marker (the inputs the worker saw), and `to-human` keeps
 * it only for a needs-human verdict.
 */
import { createHash } from 'node:crypto'
import { branchIssue } from './github.mjs'
import { parseMarker } from './marker.mjs'
import { RUNNING } from './labels.mjs'

/**
 * @typedef {import('./github.mjs').Issue} Issue
 * @typedef {import('./github.mjs').Snapshot} Snapshot
 * @typedef {{ hash: string, at: string }} Fingerprint
 *   `at`: when it was taken, the start of the triage that answered; the backstop counts from it.
 */

/**
 * The triage prompt and rubric's version. Bump it with any change to how triage judges an issue
 * (phases/dispatch.mjs `triagePrompt`): every fingerprint stops matching, so the next re-triage looks at every
 * `q:human` issue again.
 */
export const TRIAGE_RUBRIC = 1

const DAY = 24 * 60 * 60_000

/** cambium's own labels: moving an issue between queues is not a change triage should see. @param {string} l */
const cambiumLabel = (l) => l === RUNNING || /^(q|why|wait):/.test(l)

/**
 * The inputs, in a stable order. @param {Issue} issue @param {Snapshot | undefined} snap
 * @param {{ botLogin?: string | null, rubric?: number }} [o]
 */
export function triageInputs(issue, snap, { botLogin = null, rubric = TRIAGE_RUBRIC } = {}) {
  const self = new Set([botLogin, issue.stateComment?.author].filter(Boolean))
  return {
    rubric,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.filter((l) => !cambiumLabel(l)).sort(),
    comments: (issue.comments ?? [])
      .filter((c) => !!c.author && !c.bot && !self.has(c.author) && !parseMarker(c.body))
      .map((c) => String(c.id ?? `${c.author}@${c.createdAt}`))
      .sort(),
    blockedBy: (issue.blockedBy ?? []).map((b) => `${b.number}:${b.state}`).sort(),
    // Merged PRs come from the snapshot's newest 30; one that ages out of it changes the hash once.
    prs: (snap?.prs ?? [])
      .filter((p) => p.closes.includes(issue.number) || branchIssue(p.branch) === issue.number)
      .map((p) => `${p.number}:${p.state}`)
      .sort(),
  }
}

/**
 * @param {Issue} issue @param {Snapshot | undefined} snap @param {{ botLogin?: string | null, rubric?: number }} [o]
 * @returns {string}
 */
export const fingerprintOf = (issue, snap, o) =>
  createHash('sha256')
    .update(JSON.stringify(triageInputs(issue, snap, o)))
    .digest('hex')
    .slice(0, 16)

/**
 * Whether re-triage sends a `q:human` issue back to triage. Pure.
 * - `unchanged`: the marker's fingerprint matches and is younger than `maxSkipDays`: stays.
 * - `changed`, `no fingerprint` (an issue triage never answered needs-human on, or one from before fingerprints),
 *   `backstop` (unchanged for `maxSkipDays`, so a change the fingerprint cannot see is seen eventually): goes.
 *
 * @param {Issue} issue @param {Snapshot | undefined} snap
 * @param {{ now: number, maxSkipDays: number, botLogin?: string | null, rubric?: number }} o
 * @returns {{ retriage: boolean, why: 'unchanged' | 'changed' | 'no fingerprint' | 'backstop' }}
 */
export function retriageDecision(issue, snap, { now, maxSkipDays, botLogin, rubric }) {
  const fp = issue.stateComment?.marker?.fingerprint
  const at = fp ? Date.parse(fp.at) : NaN
  if (!fp?.hash || !Number.isFinite(at)) return { retriage: true, why: 'no fingerprint' }
  if (fp.hash !== fingerprintOf(issue, snap, { botLogin, rubric })) return { retriage: true, why: 'changed' }
  if (now - at >= maxSkipDays * DAY) return { retriage: true, why: 'backstop' }
  return { retriage: false, why: 'unchanged' }
}
