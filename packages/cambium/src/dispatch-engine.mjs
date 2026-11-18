// @ts-check
/**
 * `engine: "graph"`: the Dispatch-phase steps of the tick, driven through the `dispatch` graph
 * (graphs/dispatch.mjs). The legacy engine keeps the stub (phases/dispatch.mjs) and leaves `q:intake` alone.
 *
 * - Reconcile: every tracked triage worker's issue at `triaging`.
 * - Sweep: a stale `running` lease on a `q:intake` issue runs `retry-triage`.
 * - Schedule: `q:intake` issues without a lease, by priority then age, up to `phases.dispatch.cap` counted from
 *   live triage workers; each starts at `start-triage`.
 *
 * A turn advances one transition at a time and stops on entering a wait, at the entry node again (only Schedule
 * admits entries), at a wait that is not ready, or at the end.
 */
import { advance } from './graph/index.mjs'
import { dispatch, lostLeaseOf, nodeOf } from './graphs/dispatch.mjs'
import { byPriorityThenAge, Q, RUNNING } from './labels.mjs'
import { each, staleLeases } from './tick.mjs'

/**
 * @typedef {import('./tick.mjs').Deps} Deps
 * @typedef {import('./tick.mjs').Ctx} Ctx
 * @typedef {import('./graphs/task.mjs').Subject} Subject
 * @typedef {import('./graph/advance.mjs').Transition} Transition
 */

export const PHASE = 'dispatch'

/**
 * One issue's turn through the dispatch graph from `at`. A node error is rethrown (the step logs it); a triage
 * worker whose `triaging` was left is torn down only after the turn's writes succeeded.
 *
 * @param {Deps} deps @param {Ctx} ctx @param {Subject} subject @param {{ node: string, input: unknown }} at
 */
export async function driveDispatch(deps, ctx, subject, at) {
  const c = { ...deps, tick: ctx, subject }
  /** @type {Transition[]} */
  const transitions = []
  let pos = at
  for (;;) {
    // TRACING (follow-up): pass `instrument: advanceHooks(telemetry, { graph: 'dispatch', …, issueBody }).instrument`
    // here; the issue's cambium.issue root continues mycelium's intake span from the body, so these node and wait
    // spans join the intake trace (tracing.mjs `issueTrace`).
    const r = await advance(dispatch, pos, c, { maxTransitions: 1 })
    if (r.error) throw r.error.cause instanceof Error ? r.error.cause : r.error
    transitions.push(...r.transitions)
    pos = { node: r.node, input: r.input }
    if (r.reason !== 'limit' || r.node === dispatch.entry.node) break
    if (nodeOf(r.node).kind === 'wait') break
  }
  if (transitions.some((t) => t.from === 'triaging')) await releaseWorker(deps, subject)
  return { transitions, ...pos }
}

/** The triage worker's row goes, then its read-only checkout. @param {Deps} deps @param {Subject} s */
async function releaseWorker(deps, s) {
  const w = deps.store.worker(s.slug, s.number)
  if (!w) return
  deps.store.removeWorker(s.slug, s.number)
  const repo = deps.config.repos.find((r) => r.slug === s.slug)
  if (!repo) return
  const t = await deps.spawner.cleanup({ repo, worktree: w.worktree, branch: w.branch, readOnly: true })
  if (!t.removed) deps.log('warn', `kept worktree ${w.worktree}: ${t.reason}`, { repo: s.slug, issue: s.number })
}

/** @param {Deps} deps @param {Ctx} ctx */
async function reconcile(deps, ctx) {
  await each(
    deps,
    deps.store.workers().filter((w) => w.phase === PHASE),
    async (w) => {
      const snap = ctx.snaps.get(w.repo)
      const subject = { slug: w.repo, number: w.issue, snap, issue: snap?.issues.get(w.issue) }
      await driveDispatch(deps, ctx, subject, { node: 'triaging', input: { attempt: w.attempt } })
    },
    (w) => ({ repo: w.repo, issue: w.issue }),
  )
}

/** @param {Deps} deps @param {Ctx} ctx */
async function sweep(deps, ctx) {
  for (const [slug, snap] of ctx.snaps)
    await each(
      deps,
      staleLeases(deps, ctx, slug, snap).filter((i) => i.labels.includes(Q.intake)),
      async (issue) => {
        const subject = { slug, number: issue.number, snap, issue }
        await driveDispatch(deps, ctx, subject, {
          node: 'retry-triage',
          input: lostLeaseOf({ ...deps, tick: ctx, subject }),
        })
      },
      (issue) => ({ repo: slug, issue: issue.number }),
    )
}

/**
 * The `q:intake` issues to triage this tick: no `running`, no tracked worker, by priority then age, up to the free
 * slots counted from live triage workers.
 * @param {Deps} deps @param {Ctx} ctx
 */
export function intakeCandidates(deps, ctx) {
  const { config, store } = deps
  const free = config.phases.dispatch.cap - store.workers().filter((w) => w.phase === PHASE).length
  if (free <= 0) return []
  /** @type {{ slug: string, issue: import('./github.mjs').Issue, snap: import('./github.mjs').Snapshot }[]} */
  const candidates = []
  for (const [slug, snap] of ctx.snaps)
    for (const issue of snap.issues.values())
      if (
        issue.state === 'OPEN' &&
        issue.labels.includes(Q.intake) &&
        !issue.labels.includes(RUNNING) &&
        !store.worker(slug, issue.number)
      )
        candidates.push({ slug, issue, snap })
  const order = byPriorityThenAge(config.priorityLabels)
  candidates.sort((a, b) => order(a.issue, b.issue))
  return candidates.slice(0, free)
}

/** @param {Deps} deps @param {Ctx} ctx */
async function schedule(deps, ctx) {
  await each(
    deps,
    intakeCandidates(deps, ctx),
    async (c) => {
      const subject = { slug: c.slug, number: c.issue.number, snap: c.snap, issue: c.issue }
      await driveDispatch(deps, ctx, subject, { node: dispatch.entry.node, input: {} })
    },
    (c) => ({ repo: c.slug, issue: c.issue.number }),
  )
}

/** The Dispatch phase's steps for the graph engine. */
export const DISPATCH_STEPS = { reconcile, sweep, schedule }
