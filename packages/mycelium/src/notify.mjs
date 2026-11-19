// @ts-check
import { fingerprintOf } from './intake.mjs'

export const NOTIFY_KEY = 'notify'
export const NOTIFY_INTERVAL_MS = 60_000
/** Re-read this far behind the last pass, so an issue updated mid-pass is not missed. */
const SKEW_MS = 60_000

/**
 * @typedef {{ source: string, fingerprint: string | null, url: string | null, fields: Record<string, string> }} Intake
 * @typedef {{
 *   number: number,
 *   state: string,
 *   state_reason?: string | null,
 *   labels?: Array<string | { name?: string }>,
 *   body?: string | null,
 *   html_url?: string,
 * }} Issue
 * @typedef {'fixed' | 'duplicate' | 'not-planned'} CloseOutcome
 * @typedef {{
 *   filed: (intake: Intake, issue: Issue) => Promise<void>,
 *   closed: (intake: Intake, issue: Issue, outcome: CloseOutcome) => Promise<void>,
 * }} Channel
 *   How a source answers its reporter. `filed` is the one acknowledgement,
 *   `closed` the one outcome note; each is called at most once per issue.
 * @typedef {{ since: string, done: Record<string, 'acked' | 'closed'> }} NotifyCursor
 */

/** A table cell back to its value: `` `x` `` → x, `<url>` → url. */
const uncell = (/** @type {string} */ v) => {
  const s = v.trim()
  const m = /^`(.*)`$/.exec(s) ?? /^<(.*)>$/.exec(s)
  return m ? m[1] : s
}

/**
 * The `## Intake` table of a body mycelium filed, or null for any other body.
 * Only bodies with the first-line marker count, so a hand-written issue that
 * quotes a table is never answered.
 *
 * @param {string | null | undefined} body
 * @returns {Intake | null}
 */
export function intakeOf(body) {
  const text = String(body ?? '')
  const fp = fingerprintOf(text)
  if (!fp) return null
  const start = text.indexOf('\n## Intake\n')
  if (start < 0) return null
  /** @type {Record<string, string>} */
  const fields = {}
  for (const line of text.slice(start).split('\n').slice(2)) {
    if (line.startsWith('## ')) break
    const m = /^\| ([^|]+?) \| (.*) \|$/.exec(line)
    if (m && m[1] !== 'field' && !/^-+$/.test(m[1])) fields[m[1]] = uncell(m[2])
  }
  if (!fields.source) return null
  return { source: fields.source, fingerprint: fp, url: fields.url || null, fields }
}

/**
 * A closed issue → which outcome note it gets; null while it is open. An
 * `invalid` label, or a close with no reason, never claims a fix.
 *
 * @param {Issue} issue
 * @returns {CloseOutcome | null}
 */
export function closeOutcome(issue) {
  if (issue?.state !== 'closed') return null
  const labels = new Set((issue.labels ?? []).map((l) => String(typeof l === 'string' ? l : (l?.name ?? ''))))
  if (labels.has('invalid')) return 'not-planned'
  const reason = issue.state_reason ?? null
  if (reason === 'duplicate') return 'duplicate'
  if (reason === 'not_planned') return labels.has('duplicate') ? 'duplicate' : 'not-planned'
  if (reason === 'completed') return 'fixed'
  return 'not-planned'
}

/** The acknowledgement: it promises exactly one more message, the outcome note. */
export const filedText = (/** @type {number} */ number, /** @type {string} */ url) =>
  `Filed as #${number} ${url}. You'll get one more message here when it closes.`

/** The outcome note: one bold line and the issue URL. */
export function closedText(/** @type {CloseOutcome} */ outcome, /** @type {string} */ url) {
  const line = {
    fixed: '**Fixed.** The fix is in an upcoming build.',
    duplicate: '**Closed as a duplicate.** The issue names the report this one duplicates.',
    'not-planned': '**Closed without a fix.** The issue has the reason.',
  }[outcome]
  return `${line}\n${url}`
}

/**
 * Answers reporters. Each pass reads the repository's issues updated since
 * the last pass (any state, any label: triage moves intents off `q:intake`),
 * keeps the ones mycelium filed, and for each whose source has a channel
 * posts the acknowledgement once while it is open and the outcome note once
 * when it closes. What was posted is recorded per issue in the state file
 * before the cursor moves, so a restart never posts twice; a failed post is
 * retried next pass (the cursor holds).
 *
 * @param {{
 *   github: { issuesSince: (since: string) => Promise<Issue[]> },
 *   channels: Record<string, Channel>,
 *   state: import('./runner.mjs').State,
 *   backfillMs: number,
 *   dryRun?: boolean,
 *   print?: (record: any) => void,
 *   intervalMs?: number,
 * }} opts
 */
export function createNotifier({
  github,
  channels,
  state,
  backfillMs,
  dryRun = false,
  print = () => {},
  intervalMs = NOTIFY_INTERVAL_MS,
}) {
  return {
    name: NOTIFY_KEY,
    intervalMs,
    /** @param {number} now */
    async run(now) {
      /** @type {NotifyCursor} */
      const prev = state.get(NOTIFY_KEY) ?? { since: new Date(now - backfillMs).toISOString(), done: {} }
      const cur = { since: prev.since, done: { ...prev.done } }
      const tally = { seen: 0, acked: 0, closed: 0, failed: 0 }
      /** @type {string[]} */
      const errors = []
      for (const issue of await github.issuesSince(prev.since)) {
        const intake = intakeOf(issue.body)
        const channel = intake && channels[intake.source]
        if (!intake || !channel) continue
        tally.seen++
        const key = String(issue.number)
        const outcome = closeOutcome(issue)
        const step = outcome ? (cur.done[key] === 'closed' ? null : 'closed') : cur.done[key] ? null : 'acked'
        if (!step) continue
        const record = { notify: intake.source, issue: issue.number, step, outcome, url: intake.url }
        if (dryRun) {
          print(record)
          continue
        }
        try {
          if (step === 'closed') await channel.closed(intake, issue, /** @type {CloseOutcome} */ (outcome))
          else await channel.filed(intake, issue)
          cur.done[key] = step
          state.set(NOTIFY_KEY, cur)
          tally[step]++
          print(record)
        } catch (err) {
          tally.failed++
          errors.push(`#${issue.number}: ${/** @type {Error} */ (err).message}`)
        }
      }
      // A failure holds `since`, so the next pass reads that issue again.
      if (!dryRun) state.set(NOTIFY_KEY, tally.failed ? cur : { ...cur, since: new Date(now - SKEW_MS).toISOString() })
      const line = `notify: ${tally.acked} acked, ${tally.closed} closed, ${tally.failed} failed (${tally.seen} intake issues updated)`
      return errors.length ? `${line}; ${errors.join('; ')}` : line
    },
  }
}
