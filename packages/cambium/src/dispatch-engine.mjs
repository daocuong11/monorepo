// @ts-check
/**
 * `engine: "graph"`: the Dispatch-phase steps of the tick, driven through the `dispatch` graph
 * (graphs/dispatch.mjs). The legacy engine keeps the stub (phases/dispatch.mjs) and leaves `q:intake` alone.
 *
 * - Reconcile: every tracked triage worker's issue at `triaging`.
 * - Sweep: a stale `running` lease on a `q:intake` issue runs `retry-triage`.
 * - Schedule: first parks: a `q:intake` issue without a lease that has an open GitHub `blockedBy` issue goes to the
 *   `blocked` node (`wait:blocked`) if it is not there yet, and every other one gets the `wait:*` label its marker
 *   calls for (`wait:deferred` while its `deferUntil` is ahead, none once due or unblocked). Then `q:intake` issues
 *   without a lease, by priority then age, up to `phases.dispatch.cap` counted from live triage workers, skipping
 *   one deferred until later or blocked; each starts at `start-triage`.
 *
 * A turn advances one transition at a time and stops on entering a wait, at the entry node again (only Schedule
 * admits entries), at a wait that is not ready, or at the end.
 */
import { advance } from './graph/index.mjs'
import { dispatch, lostLeaseOf, nodeOf, openBlockers } from './graphs/dispatch.mjs'
import { setLabels } from './issue-state.mjs'
import { byPriorityThenAge, Q, RUNNING, WAIT } from './labels.mjs'
import { each, staleLeases } from './tick.mjs'
import { markerTrace, turnTracer } from './tracing.mjs'

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
  // A new issue's cambium.issue root continues mycelium's intake span from the body, so these node and wait spans
  // join the intake trace (tracing.mjs `issueTrace`); the marker carries it on into the task graph.
  const traced = turnTracer(deps.telemetry, subject, {
    graph: dispatch.name,
    graphVersion: dispatch.version,
    repo: subject.slug,
    issue: subject.number,
    issueBody: subject.issue?.body ?? null,
    ...markerTrace(subject.issue?.stateComment?.marker),
  })
  /** @type {Transition[]} */
  const transitions = []
  let pos = at
  for (;;) {
    const r = await advance(dispatch, pos, c, { maxTransitions: 1, instrument: traced.instrument })
    if (r.error) throw r.error.cause instanceof Error ? r.error.cause : r.error
    traced.sync()
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
        !store.worker(slug, issue.number) &&
        !deferredPast(issue, ctx.now) &&
        !openBlockers(issue).length
      )
        candidates.push({ slug, issue, snap })
  const order = byPriorityThenAge(config.priorityLabels)
  candidates.sort((a, b) => order(a.issue, b.issue))
  return candidates.slice(0, free)
}

/**
 * Resting at `deferred` with its recheck time still ahead: triage waits for it. Unless it was unblocked meanwhile:
 * every GitHub "blocked by" issue is closed and one closed after the defer, so it is triaged again at once rather
 * than at `deferUntil`. A blocker closed before the defer did not cause it, so it wakes nothing.
 * @param {import('./github.mjs').Issue} issue @param {number} now
 */
const deferredPast = (issue, now) => {
  const m = issue.stateComment?.marker
  if (!(m?.graph === dispatch.name && m.node === 'deferred' && !!m.deferUntil && Date.parse(m.deferUntil) > now))
    return false
  return !unblockedSince(issue.blockedBy ?? [], m.enteredAt)
}

/**
 * The `q:intake` issues at rest (no `running`, no tracked worker), whatever the cap: these are parked or unparked.
 * @param {Deps} deps @param {Ctx} ctx
 */
function restingIntake(deps, ctx) {
  /** @type {{ slug: string, issue: import('./github.mjs').Issue, snap: import('./github.mjs').Snapshot }[]} */
  const out = []
  for (const [slug, snap] of ctx.snaps)
    for (const issue of snap.issues.values())
      if (
        issue.state === 'OPEN' &&
        issue.labels.includes(Q.intake) &&
        !issue.labels.includes(RUNNING) &&
        !deps.store.worker(slug, issue.number)
      )
        out.push({ slug, issue, snap })
  return out
}

/**
 * The `wait:*` label a resting `q:intake` issue should carry, open blockers aside: `wait:deferred` while its
 * `deferUntil` is ahead, else none (it awaits triage).
 * @param {import('./github.mjs').Issue} issue @param {number} now
 */
const waitLabelOf = (issue, now) => (deferredPast(issue, now) ? WAIT.deferred : null)

/**
 * Park and unpark: an issue with an open `blockedBy` goes to the `blocked` node unless it rests there already with
 * `wait:blocked`; any other gets the `wait:*` label {@link waitLabelOf} says, and loses the rest.
 * @param {Deps} deps @param {Ctx} ctx
 */
async function park(deps, ctx) {
  await each(
    deps,
    restingIntake(deps, ctx),
    async (c) => {
      const { issue } = c
      const open = openBlockers(issue)
      const m = issue.stateComment?.marker
      const atBlocked = m?.graph === dispatch.name && m.node === 'blocked'
      if (open.length) {
        if (atBlocked && issue.labels.includes(WAIT.blocked)) return
        const subject = { slug: c.slug, number: issue.number, snap: c.snap, issue }
        const reason =
          m?.graph === dispatch.name && m.node === 'deferred' && m.deferReason
            ? m.deferReason
            : `GitHub shows it blocked by ${open.map((n) => `#${n}`).join(', ')}.`
        await driveDispatch(deps, ctx, subject, { node: 'blocked', input: { blockedBy: open, reason } })
        return
      }
      const want = waitLabelOf(issue, ctx.now)
      const has = issue.labels.filter((l) => l.startsWith('wait:'))
      await setLabels(deps, c.slug, issue, {
        add: want && !has.includes(want) ? [want] : [],
        remove: has.filter((l) => l !== want),
      })
    },
    (c) => ({ repo: c.slug, issue: c.issue.number }),
  )
}

/**
 * All blockers closed, at least one after `since`.
 * @param {import('./github.mjs').Blocker[]} blockers @param {string | null} since
 */
const unblockedSince = (blockers, since) =>
  blockers.length > 0 &&
  blockers.every((b) => b.state === 'CLOSED') &&
  blockers.some((b) => !since || (!!b.closedAt && Date.parse(b.closedAt) > Date.parse(since)))

/** @param {Deps} deps @param {Ctx} ctx */
async function schedule(deps, ctx) {
  if (deps.config.phases.dispatch.cap <= 0) return
  await park(deps, ctx)
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
