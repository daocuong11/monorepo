// @ts-check
/**
 * The base branch's health, and the repair of a red one.
 *
 * Every Task PR lands on the repo's `baseBranch`. When that branch is red, every worker's verify fails for a
 * reason that is not its own, and without this module each one spends its attempts and lands in `q:human`
 * (sektorapp/monorepo#3972: three attempts, three kills, on a break #4624 + #4625 made together). So:
 *
 * - **Observe.** The snapshot reads the base's last {@link HISTORY} commits with their `requiredCheck` run
 *   ({@link BASE_FIELDS}); {@link baseHealthOf} turns them into green / red / unknown, the last green commit and
 *   the merges since it.
 * - **Gate.** While red, Schedule starts no Task worker for that repo except the repair (tick.mjs
 *   `taskCandidates`), and a failure is requeued without spending an attempt (graphs/task.mjs `requeue`).
 * - **Resolve.** {@link trackBaseHealth} opens one repair issue per red base ({@link REPAIR_LABEL}, `q:task`,
 *   the top priority): its body is the worker's spec, and its PR merges through graft's red-base rescue. A base
 *   that goes green again closes a repair issue nobody is working.
 *
 * Unknown (no completed run in the window: the base has no `requiredCheck` on push, or every run is cancelled or
 * pending) gates nothing.
 */
import { iso, key } from './issue-state.mjs'
import { Q } from './labels.mjs'

/** Marks the repair issue. Not a `why:` label: those leave with `q:human` (labels.mjs `move`). */
export const REPAIR_LABEL = 'red-base'

/** How many base commits the snapshot reads, newest first. */
export const HISTORY = 20

/**
 * The snapshot's base read, under `repository`. Needs `$baseRef`, `$check` and `$health`.
 */
export const BASE_FIELDS = `baseRef: ref(qualifiedName: $baseRef) @include(if: $health) {
      target { ... on Commit { history(first: ${HISTORY}) { nodes {
        oid messageHeadline
        associatedPullRequests(first: 1) { nodes { number } }
        checkSuites(first: 30) { nodes { branch { name } checkRuns(first: 3, filterBy: { checkName: $check }) { nodes { status conclusion detailsUrl } } } }
      } } } }
    }
    repairs: issues(labels: ["${REPAIR_LABEL}"], states: OPEN, first: 5) @include(if: $health) { nodes { number } }`

/**
 * @typedef {{ sha: string, headline: string, pr: number | null }} BaseCommit
 * @typedef {{
 *   branch: string, check: string, state: 'green' | 'red' | 'unknown', head: string | null,
 *   red: (BaseCommit & { url: string | null }) | null, lastGreen: BaseCommit | null, suspects: BaseCommit[],
 *   repairs: number[],
 * }} BaseHealth
 *   `red`: the newest commit whose run failed (the verdict); `lastGreen`: the newest passing commit older than
 *   it; `suspects`: the commits between them, newest first, `red` included, one per PR. `repairs`: open repair
 *   issues.
 */

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE'])

/**
 * A commit's verdict from its `check` runs on `branch`: the first completed run that says anything. Only a suite
 * run for the base branch counts: the history also holds the merged PRs' own commits, whose runs judged the PR
 * against an older base (PR CI on sektorapp is affected-only), not the base.
 * @param {any} node @param {string} branch
 */
function verdictOf(node, branch) {
  for (const suite of node?.checkSuites?.nodes ?? []) {
    if (suite?.branch?.name !== branch) continue
    for (const run of suite?.checkRuns?.nodes ?? []) {
      if (run?.status !== 'COMPLETED') continue
      if (PASSED.has(run.conclusion)) return { pass: true, url: run.detailsUrl ?? null }
      if (FAILED.has(run.conclusion)) return { pass: false, url: run.detailsUrl ?? null }
    }
  }
  return null
}

/** @param {any} n @returns {BaseCommit} */
const commitOf = (n) => ({
  sha: n.oid,
  headline: n.messageHeadline ?? '',
  pr: n.associatedPullRequests?.nodes?.[0]?.number ?? null,
})

/**
 * The base's health from its history, newest first. The newest commit with a verdict decides: a pending or
 * cancelled run on the head says nothing, so a red base stays red until a run passes.
 *
 * @param {any} repo the snapshot's `repository` @param {{ branch: string, check: string }} at
 * @returns {BaseHealth}
 */
export function baseHealthOf(repo, { branch, check }) {
  const nodes = repo?.baseRef?.target?.history?.nodes ?? []
  const repairs = (repo?.repairs?.nodes ?? []).map((/** @type {any} */ n) => n.number)
  const base = { branch, check, head: nodes[0]?.oid ?? null, repairs }
  const verdict = (/** @type {any} */ n) => verdictOf(n, branch)
  const decided = nodes.findIndex(verdict)
  if (decided === -1) return { ...base, state: 'unknown', red: null, lastGreen: null, suspects: [] }
  const v = /** @type {{ pass: boolean, url: string | null }} */ (verdict(nodes[decided]))
  if (v.pass) return { ...base, state: 'green', red: null, lastGreen: commitOf(nodes[decided]), suspects: [] }
  const greenAt = nodes.findIndex((/** @type {any} */ n, /** @type {number} */ i) => i > decided && verdict(n)?.pass)
  /** @type {Set<number>} */
  const seen = new Set()
  const suspects = nodes
    .slice(decided, greenAt === -1 ? undefined : greenAt)
    .map(commitOf)
    .filter((c) => c.pr === null || (!seen.has(c.pr) && seen.add(c.pr)))
  return {
    ...base,
    state: 'red',
    red: { ...commitOf(nodes[decided]), url: v.url },
    lastGreen: greenAt === -1 ? null : commitOf(nodes[greenAt]),
    suspects,
  }
}

/** Red, per the snapshot. @param {import('./github.mjs').Snapshot | undefined} snap */
export const baseRed = (snap) => snap?.base?.state === 'red'

/** @param {import('./github.mjs').Issue} issue */
export const isRepair = (issue) => issue.labels.includes(REPAIR_LABEL)

const short = (/** @type {string} */ sha) => sha.slice(0, 7)

/** @param {BaseHealth} h */
export const repairTitle = (h) => `Red base: ${h.branch} \`${h.check}\` failing since ${short(h.red?.sha ?? '')}`

/**
 * The repair issue's body: the worker's spec.
 * @param {BaseHealth} h
 */
export function repairBody(h) {
  const red = /** @type {NonNullable<BaseHealth['red']>} */ (h.red)
  const line = (/** @type {BaseCommit} */ c) => `- ${short(c.sha)}${c.pr ? ` #${c.pr}` : ''} ${c.headline}`
  return [
    `\`${h.branch}\` is red: its \`${h.check}\` check failed on ${short(red.sha)}${red.url ? ` (${red.url})` : ''}.`,
    '',
    'Opened by cambium. While this is open cambium starts no other Task worker on this repo, and their failures cost no attempts.',
    '',
    '## Suspects',
    '',
    h.lastGreen
      ? `Last green: ${short(h.lastGreen.sha)} ${h.lastGreen.headline}. Merged since, newest first:`
      : `No green commit in the last ${HISTORY}. Newest first:`,
    '',
    ...h.suspects.map(line),
    '',
    '## Work',
    '',
    `1. Read why it failed: \`graft jobs ${red.url ?? '<run>'}\`. Reproduce with \`pnpm verify\` in your worktree, which starts at \`${h.branch}\`.`,
    '2. Two PRs that are each green can be red together, so the cause may span suspects.',
    '3. Fix forward when the fix is clear and small. Otherwise revert the merge that broke it, and say on the PR which one and why.',
    '4. Change only what makes the check green; do not fold other work into this PR.',
    '',
    `Your PR closes this issue. cambium merges it through graft's red-base rescue, once it is up to date with \`${h.branch}\` and its own \`${h.check}\` is green.`,
    '',
    '## Done when',
    '',
    `- \`pnpm verify\` passes on \`${h.branch}\` with your change.`,
    `- \`${h.branch}\`'s \`${h.check}\` is green after the merge.`,
  ].join('\n')
}

/**
 * The repair issue's lifecycle, once per tick before Schedule. Red with no open repair issue → open one
 * (`q:task`, the top priority label, {@link REPAIR_LABEL}). Green, with an open repair issue that has no open PR
 * and no worker → close it. Unknown → nothing.
 *
 * @param {import('./tick.mjs').Deps} deps @param {import('./tick.mjs').Ctx} ctx
 */
export async function trackBaseHealth(deps, ctx) {
  for (const [slug, snap] of ctx.snaps) {
    const h = snap.base
    if (!h) continue
    try {
      if (h.state === 'red' && !h.repairs.length) {
        const made = await deps.github.createIssue(slug, {
          title: repairTitle(h),
          body: repairBody(h),
          labels: [Q.task, deps.config.priorityLabels[0], REPAIR_LABEL].filter(Boolean),
        })
        h.repairs = [made.number]
        deps.log('warn', `${h.branch} is red at ${short(h.red?.sha ?? '')}; opened repair #${made.number}`, {
          repo: slug,
          issue: made.number,
        })
        continue
      }
      if (h.state !== 'green') continue
      /** @type {number[]} */
      const closed = []
      for (const n of h.repairs) {
        const worked = deps.store.worker(slug, n) || snap.prs.some((p) => p.state === 'OPEN' && p.closes.includes(n))
        if (worked || ctx.touched.has(key(slug, n))) continue
        await deps.github.close(
          slug,
          n,
          `\`${h.branch}\` is green again at ${short(h.lastGreen?.sha ?? h.head ?? '')} (${iso(ctx.now)}); nothing left to repair.`,
          { reason: 'completed' },
        )
        const issue = snap.issues.get(n)
        if (issue) issue.state = 'CLOSED'
        closed.push(n)
        deps.log('info', `${h.branch} is green again; closed repair #${n}`, { repo: slug, issue: n })
      }
      h.repairs = h.repairs.filter((n) => !closed.includes(n))
    } catch (err) {
      deps.log('error', `base health: ${/** @type {Error} */ (err)?.message ?? err}`, { repo: slug })
    }
  }
}
