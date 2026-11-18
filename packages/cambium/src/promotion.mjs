// @ts-check
/**
 * Merged, not yet promoted (`engine: "graph"`): for a repo whose `release.from` ≠ `release.to`, an issue whose
 * agent PR merged into `from` carries `q:promote` (the issue stays closed) until that PR is no longer ahead of
 * `to`. Runs at the end of Watch, after close-out, whether or not the repo's daily release is on.
 *
 * - **Label.** A merged agent PR among `release.merged` (the PRs on `from` not yet in `to`) → each closed,
 *   cambium-owned issue it closes gains `q:promote` (and leaves every other queue).
 * - **Unlabel.** A closed issue with `q:promote` whose PR (the marker's `pr`, else a merged PR closing it) is no
 *   longer among `release.merged` → `q:promote` off. Skipped while `to` is missing or `from` is more than 100
 *   commits ahead (the comparison lists only the last 100, so an older PR would look promoted).
 */
import { key, setLabels } from './issue-state.mjs'
import { move, Q } from './labels.mjs'
import { each } from './tick.mjs'

/** How many commits ahead the snapshot's comparison lists (github.mjs `commits(last: 100)`). */
export const COMPARE_WINDOW = 100

/**
 * The issue → PR pairs to label and the issues to unlabel, for one repo's snapshot. Pure.
 * @param {import('./github.mjs').Snapshot} snap
 * @returns {{ label: import('./github.mjs').Issue[], unlabel: import('./github.mjs').Issue[] }}
 */
export function promotionMoves(snap) {
  const release = snap.release
  /** @type {{ label: import('./github.mjs').Issue[], unlabel: import('./github.mjs').Issue[] }} */
  const out = { label: [], unlabel: [] }
  if (!release || release.aheadBy === null) return out
  const ahead = new Set(release.merged.map((p) => p.number))
  /** @type {Map<number, number>} issue → the merged agent PR that closes it */
  const mergedFor = new Map()
  for (const pr of snap.prs) if (pr.state === 'MERGED') for (const n of pr.closes) mergedFor.set(n, pr.number)
  const seen = new Set()
  for (const [n, pr] of mergedFor) {
    const issue = snap.issues.get(n)
    if (!issue?.stateComment || issue.state !== 'CLOSED' || issue.labels.includes(Q.promote)) continue
    if (ahead.has(pr) && !seen.has(n)) {
      seen.add(n)
      out.label.push(issue)
    }
  }
  if (release.aheadBy > COMPARE_WINDOW) return out
  for (const issue of snap.issues.values()) {
    if (issue.state !== 'CLOSED' || !issue.labels.includes(Q.promote)) continue
    const pr = issue.stateComment?.marker.pr ?? mergedFor.get(issue.number) ?? null
    if (pr !== null && !ahead.has(pr)) out.unlabel.push(issue)
  }
  return out
}

/** @param {import('./tick.mjs').Deps} deps @param {import('./tick.mjs').Ctx} ctx */
export async function trackPromotion(deps, ctx) {
  for (const [slug, snap] of ctx.snaps) {
    const { label, unlabel } = promotionMoves(snap)
    const to = snap.release?.to
    await each(
      deps,
      label,
      async (issue) => {
        await setLabels(deps, slug, issue, move(issue.labels, Q.promote))
        ctx.touched.add(key(slug, issue.number))
        deps.log('info', `merged into \`${snap.release?.from}\`; waiting for promotion to \`${to}\``, {
          repo: slug,
          issue: issue.number,
        })
      },
      (issue) => ({ repo: slug, issue: issue.number }),
    )
    await each(
      deps,
      unlabel,
      async (issue) => {
        await setLabels(deps, slug, issue, { add: [], remove: [Q.promote] })
        deps.log('info', `promoted to \`${to}\``, { repo: slug, issue: issue.number })
      },
      (issue) => ({ repo: slug, issue: issue.number }),
    )
  }
}
