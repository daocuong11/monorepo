// @ts-check
/**
 * Watched workflows: each repo's `watch` list names (workflow, branch) pairs whose latest run must be green, such
 * as a deploy on `main` or e2e on `develop`. Every `watchEveryMinutes` cambium reads each pair's newest completed
 * run (cancelled and skipped runs say nothing, so they are passed over) and compares it with the verdict it stored.
 *
 * - **Red** (failure, timed out, startup failure, action required): a warn event, and, unless the pair says
 *   `issue: false`, one `q:human` issue labelled {@link WATCH_LABEL} that names the run. A repo without that label
 *   gets the issue with `q:human` alone.
 * - **Green again:** an info event, and the issue cambium opened for it is closed.
 * - **No run yet, or a read that fails:** the stored verdict stands; nothing fires.
 *
 * Verdicts live in the store (`watch:<repo>:<workflow>@<branch>`), so a restart neither re-fires nor forgets an
 * open issue, and the heartbeat carries them (`repos[].watch`).
 */
import { iso, MIN } from './issue-state.mjs'
import { Q } from './labels.mjs'

/** Marks an issue cambium opened for a failing watched workflow. */
export const WATCH_LABEL = 'watch'

const PASSED = new Set(['success', 'neutral'])
const SILENT = new Set(['cancelled', 'skipped', 'stale'])

/**
 * @typedef {{ id: number, url: string, sha: string, conclusion: string, at: string }} WorkflowRun
 * @typedef {{
 *   workflow: string, branch: string, state: 'green' | 'red' | 'unknown', run: WorkflowRun | null,
 *   issue: number | null, checkedAt: string | null, error: string | null,
 * }} WatchState
 */

/** @param {string} slug @param {{ workflow: string, branch: string }} w */
export const watchKey = (slug, w) => `watch:${slug}:${w.workflow}@${w.branch}`

/**
 * The verdict of the newest completed run that says anything, from runs newest first. Pure.
 * @param {WorkflowRun[]} runs @returns {{ state: 'green' | 'red', run: WorkflowRun } | null}
 */
export function verdictOf(runs) {
  const run = runs.find((r) => !SILENT.has(r.conclusion))
  if (!run) return null
  return { state: PASSED.has(run.conclusion) ? 'green' : 'red', run }
}

/** @param {import('./store.mjs').Store} store @param {string} key @returns {WatchState | null} */
function load(store, key) {
  try {
    return JSON.parse(store.get(key) ?? 'null')
  } catch {
    return null
  }
}

/** Every repo's watch verdicts, as the heartbeat shows them. @param {import('./tick.mjs').Deps} deps @param {string} slug */
export function watchStates(deps, slug) {
  const repo = deps.config.repos.find((r) => r.slug === slug)
  return (repo?.watch ?? []).map(
    (w) =>
      load(deps.store, watchKey(slug, w)) ?? {
        workflow: w.workflow,
        branch: w.branch,
        state: 'unknown',
        run: null,
        issue: null,
        checkedAt: null,
        error: null,
      },
  )
}

/** @param {WatchState} s @param {string} slug */
const title = (s, slug) => `Watch: \`${s.workflow}\` is failing on \`${s.branch}\` in ${slug}`

/** @param {WatchState} s */
function body(s) {
  const run = /** @type {WorkflowRun} */ (s.run)
  return [
    `The newest completed run of \`${s.workflow}\` on \`${s.branch}\` concluded **${run.conclusion}**: ${run.url} (${run.sha.slice(0, 7)}, ${run.at}).`,
    '',
    `Opened by cambium because this repo's config watches it. cambium closes this issue once a run on \`${s.branch}\` is green again.`,
  ].join('\n')
}

/**
 * The watch step: due every `watchEveryMinutes` per repo, then each pair is read and compared.
 * @param {import('./tick.mjs').Deps} deps @param {import('./tick.mjs').Ctx} ctx
 */
export async function watchWorkflows(deps, ctx) {
  const every = deps.config.watchEveryMinutes
  for (const repo of deps.config.repos) {
    if (!repo.watch.length || every <= 0) continue
    const dueKey = `watch.checkedAt:${repo.slug}`
    const last = Number(deps.store.get(dueKey) ?? 0)
    if (ctx.now - last < every * MIN) continue
    deps.store.set(dueKey, String(ctx.now))
    for (const w of repo.watch) await checkOne(deps, ctx, repo.slug, w)
  }
}

/**
 * @param {import('./tick.mjs').Deps} deps @param {import('./tick.mjs').Ctx} ctx @param {string} slug
 * @param {import('./config.mjs').Watch} w
 */
async function checkOne(deps, ctx, slug, w) {
  const key = watchKey(slug, w)
  /** @type {WatchState} */
  const prev = load(deps.store, key) ?? {
    workflow: w.workflow,
    branch: w.branch,
    state: 'unknown',
    run: null,
    issue: null,
    checkedAt: null,
    error: null,
  }
  const save = (/** @type {Partial<WatchState>} */ next) =>
    deps.store.set(key, JSON.stringify({ ...prev, ...next, checkedAt: iso(ctx.now) }))
  const where = { repo: slug }
  const name = `\`${w.workflow}\` on \`${w.branch}\``
  /** @type {WorkflowRun[]} */
  let runs
  try {
    runs = await deps.github.workflowRuns(slug, w.workflow, w.branch)
  } catch (err) {
    const error = /** @type {Error} */ (err)?.message ?? String(err)
    save({ error })
    deps.log('error', `watch ${name}: ${error}`, where)
    return
  }
  const v = verdictOf(runs)
  if (!v) return save({ error: null })
  if (v.state === 'red') {
    const fresh = prev.state !== 'red' || prev.run?.id !== v.run.id
    let issue = prev.issue
    if (prev.state !== 'red') deps.log('warn', `watch ${name} is red: ${v.run.conclusion} ${v.run.url}`, where)
    if (w.issue && issue === null) {
      const next = { ...prev, state: /** @type {const} */ ('red'), run: v.run }
      const made = await openIssue(deps, slug, next)
      issue = made
      if (made !== null) deps.log('warn', `watch ${name} is red; opened #${made}`, { repo: slug, issue: made })
    } else if (w.issue && issue !== null && fresh && prev.state === 'red') {
      await deps.github
        .comment(slug, issue, `Still failing: ${v.run.conclusion} on ${v.run.sha.slice(0, 7)}, ${v.run.url}`)
        .catch((/** @type {Error} */ err) => deps.log('error', `watch ${name}: ${err?.message ?? err}`, where))
    }
    return save({ state: 'red', run: v.run, issue, error: null })
  }
  if (prev.state === 'red') {
    deps.log('info', `watch ${name} is green again at ${v.run.sha.slice(0, 7)}`, where)
    if (prev.issue !== null)
      try {
        await deps.github.close(
          slug,
          prev.issue,
          `\`${w.workflow}\` is green again on \`${w.branch}\`: ${v.run.url} (${iso(ctx.now)}).`,
          { reason: 'completed' },
        )
        deps.log('info', `watch ${name}: closed #${prev.issue}`, { repo: slug, issue: prev.issue })
      } catch (err) {
        deps.log('error', `watch ${name}: closing #${prev.issue}: ${/** @type {Error} */ (err)?.message ?? err}`, where)
        return save({ state: 'green', run: v.run, error: null })
      }
  }
  save({ state: 'green', run: v.run, issue: null, error: null })
}

/**
 * One `q:human` issue for a red pair; `q:human` alone when the repo has no {@link WATCH_LABEL} label. null when
 * neither works (logged), so the next due check tries again.
 * @param {import('./tick.mjs').Deps} deps @param {string} slug @param {WatchState} s
 */
async function openIssue(deps, slug, s) {
  const issue = { title: title(s, slug), body: body(s) }
  try {
    return (await deps.github.createIssue(slug, { ...issue, labels: [Q.human, WATCH_LABEL] })).number
  } catch (err) {
    const msg = /** @type {Error} */ (err)?.message ?? String(err)
    if (!/does not exist|not found/i.test(msg)) {
      deps.log('error', `watch \`${s.workflow}\`: opening an issue: ${msg}`, { repo: slug })
      return null
    }
  }
  try {
    return (await deps.github.createIssue(slug, { ...issue, labels: [Q.human] })).number
  } catch (err) {
    deps.log('error', `watch \`${s.workflow}\`: opening an issue: ${/** @type {Error} */ (err)?.message ?? err}`, {
      repo: slug,
    })
    return null
  }
}
