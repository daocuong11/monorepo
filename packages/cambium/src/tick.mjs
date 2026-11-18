// @ts-check
/**
 * One tick: Read → Reconcile → Watch → Sweep → Schedule → Release →
 * Heartbeat. Every collaborator is injected ({@link Deps}); the daemon is a
 * loop around this function. Each step is bounded by `stepTimeoutSeconds`; a
 * step that throws or times out is recorded and the tick moves on. Nothing
 * here waits on a worker.
 */
import { byPriorityThenAge, move, Q, queueOf, RUNNING, WHY } from './labels.mjs'
import { withHistory } from './marker.mjs'
import { failureSummary, iso, key, markerOf, MIN, setLabels, setMarker } from './issue-state.mjs'
import { GRAPH_ENGINE } from './graph-engine.mjs'
import { prFor, taskExit, taskPrompt } from './phases/task.mjs'
import { branchName } from './convention.mjs'
import { PREPARE_FAILED_LINE } from './prepare.mjs'
import { releaseDue, releaseNotBuilt } from './phases/release.mjs'
import { DISPATCH_NOT_BUILT, dispatchNotBuilt } from './phases/dispatch.mjs'

/**
 * @typedef {import('./github.mjs').Issue} Issue
 * @typedef {import('./github.mjs').Snapshot} Snapshot
 * @typedef {import('./store.mjs').Worker} Worker
 * @typedef {{ at: string, level: 'info' | 'warn' | 'error', msg: string, repo?: string, issue?: number }} Event
 * @typedef {{
 *   config: import('./config.mjs').Config,
 *   clock: { now(): number },
 *   github: import('./github.mjs').GitHub,
 *   store: import('./store.mjs').Store,
 *   spawner: import('./workers.mjs').Spawner,
 *   procs: import('./workers.mjs').Procs,
 *   log: (level: Event['level'], msg: string, where?: { repo?: string, issue?: number }) => void,
 *   events?: () => Event[],
 *   heartbeat?: (state: HeartbeatState) => void | Promise<void>,
 *   dispatch?: import('./phases/dispatch.mjs').Dispatch,
 *   release?: import('./phases/release.mjs').Release,
 *   tickNumber?: number,
 *   daemonStartedAt?: number,
 *   pid?: number,
 * }} Deps
 * @typedef {{ name: string, ok: boolean, ms: number, error: string | null }} StepResult
 * @typedef {{
 *   now: number, mode: import('./store.mjs').Mode, snaps: Map<string, Snapshot>,
 *   readErrors: Map<string, string>, touched: Set<string>, steps: StepResult[],
 * }} Ctx
 */

/**
 * @typedef {(deps: Deps, ctx: Ctx) => Promise<void>} StepFn
 * @typedef {{ reconcile: StepFn, watch: StepFn, sweep: StepFn, scheduleTasks: StepFn }} Engine
 *   The Task-phase steps. `config.engine` picks the legacy stage tick (this file) or the `task` graph
 *   (graph-engine.mjs); Read, dispatch, Release and Heartbeat are shared.
 */

/** @param {Deps} deps @returns {Ctx} */
export function newCtx(deps) {
  return {
    now: deps.clock.now(),
    mode: deps.store.mode(),
    snaps: new Map(),
    readErrors: new Map(),
    touched: new Set(),
    steps: [],
  }
}

/**
 * @param {Deps} deps
 * @returns {Promise<HeartbeatState>}
 */
export async function tick(deps) {
  const ctx = newCtx(deps)
  const paused = ctx.mode === 'paused'
  const engine = engineOf(deps)
  /** @type {StepFn} */
  const schedule = async (d, c) => {
    await engine.scheduleTasks(d, c)
    await scheduleDispatch(d, c)
  }
  /** @type {[string, StepFn][]} */
  const steps = [
    ['read', read],
    ...(paused
      ? []
      : /** @type {[string, StepFn][]} */ ([
          ['reconcile', engine.reconcile],
          ['watch', engine.watch],
          ['sweep', engine.sweep],
        ])),
    ...(ctx.mode === 'running' ? /** @type {[string, StepFn][]} */ ([['schedule', schedule]]) : []),
    ...(paused ? [] : /** @type {[string, any][]} */ ([['release', release]])),
  ]
  for (const [name, fn] of steps) await runStep(deps, ctx, name, () => fn(deps, ctx))
  const state = heartbeatState(deps, ctx)
  if (deps.heartbeat) await runStep(deps, ctx, 'heartbeat', async () => deps.heartbeat?.(state))
  return state
}

/** @type {Engine} */
const LEGACY = { reconcile, watch, sweep, scheduleTasks }

/** @param {Deps} deps @returns {Engine} */
export const engineOf = (deps) => (deps.config.engine === 'graph' ? GRAPH_ENGINE : LEGACY)

/**
 * @param {Deps} deps @param {Ctx} ctx @param {string} name @param {() => Promise<void>} fn
 */
async function runStep(deps, ctx, name, fn) {
  const t0 = performance.now()
  const limit = deps.config.stepTimeoutSeconds * 1000
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`step exceeded ${deps.config.stepTimeoutSeconds}s`)), limit)
      }),
    ])
    ctx.steps.push({ name, ok: true, ms: Math.round(performance.now() - t0), error: null })
  } catch (err) {
    const error = /** @type {Error} */ (err)?.message ?? String(err)
    ctx.steps.push({ name, ok: false, ms: Math.round(performance.now() - t0), error })
    deps.log('error', `${name}: ${error}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run each item's work on its own: one failure is logged, the rest still run.
 *
 * @template T
 * @param {Deps} deps @param {T[]} items @param {(item: T) => Promise<void>} fn
 * @param {(item: T) => { repo?: string, issue?: number }} where
 */
export async function each(deps, items, fn, where) {
  for (const item of items) {
    try {
      await fn(item)
    } catch (err) {
      deps.log('error', /** @type {Error} */ (err)?.message ?? String(err), where(item))
    }
  }
}

// ---- Read

/** @param {Deps} deps @param {Ctx} ctx */
async function read(deps, ctx) {
  for (const repo of deps.config.repos) {
    try {
      ctx.snaps.set(repo.slug, await deps.github.read(repo.slug))
    } catch (err) {
      const msg = /** @type {Error} */ (err)?.message ?? String(err)
      ctx.readErrors.set(repo.slug, msg)
      deps.log('error', `read: ${msg}`, { repo: repo.slug })
    }
  }
  if (ctx.readErrors.size === deps.config.repos.length && ctx.readErrors.size)
    throw new Error(`no repository could be read`)
}

/**
 * Into the Human Queue with a reason label. The marker is written before the
 * labels: a half-applied transition is then re-done (and over-counted) on the
 * next tick, never under-counted.
 *
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {Issue} issue
 * @param {{ reason: string, outcome: string, pr?: number, log?: string, failedSha?: string | null, why?: string }} what
 */
export async function toHuman(deps, ctx, slug, issue, { reason, outcome, pr, log, failedSha, why = WHY.budget }) {
  const m = markerOf(issue)
  const marker = {
    ...withHistory(m, { at: iso(ctx.now), attempt: m.attempt, outcome, reason, pr, log }),
    stage: /** @type {const} */ ('human'),
    lastFailure: reason,
    host: null,
    start: null,
    ...(failedSha !== undefined ? { failedSha } : {}),
  }
  await setMarker(deps, slug, issue, marker)
  await setLabels(deps, slug, issue, move(issue.labels, Q.human, { extra: [why] }))
  ctx.touched.add(key(slug, issue.number))
  deps.log('warn', `→ q:human (${why}): ${reason.split('\n')[0]}`, { repo: slug, issue: issue.number })
}

/**
 * Back to `q:task` with attempt + 1, or to the Human Queue (`why:budget`)
 * when the attempts are spent.
 *
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {Issue} issue
 * @param {{ reason: string, outcome: string, pr?: number, log?: string, failedSha?: string | null }} what
 */
export async function requeue(deps, ctx, slug, issue, what) {
  const m = markerOf(issue)
  const max = deps.config.phases.task.maxAttempts
  if (m.attempt >= max)
    return toHuman(deps, ctx, slug, issue, {
      ...what,
      reason: `${max} attempts spent. Last: ${what.reason}`,
    })
  const { reason, outcome, pr, log, failedSha } = what
  const marker = {
    ...withHistory(m, { at: iso(ctx.now), attempt: m.attempt, outcome, reason, pr, log }),
    stage: /** @type {const} */ ('queued'),
    attempt: m.attempt + 1,
    lastFailure: reason,
    host: null,
    start: null,
    ...(failedSha !== undefined ? { failedSha } : {}),
  }
  await setMarker(deps, slug, issue, marker)
  await setLabels(deps, slug, issue, move(issue.labels, Q.task))
  ctx.touched.add(key(slug, issue.number))
  deps.log('info', `requeued (attempt ${marker.attempt}/${max}): ${reason.split('\n')[0]}`, {
    repo: slug,
    issue: issue.number,
  })
}

// ---- Reconcile

/** @param {Deps} deps @param {Ctx} ctx */
async function reconcile(deps, ctx) {
  const { config, store, procs } = deps
  await each(
    deps,
    store.workers(),
    async (w) => {
      const caps = config.phases[/** @type {'task'} */ (w.phase)] ?? config.phases.task
      if (procs.alive(w.pid)) {
        if (!w.killedReason && ctx.now - w.startedAt <= caps.wallClockMinutes * MIN) return
        const reason = w.killedReason ?? `killed: over the ${caps.wallClockMinutes} min wall-clock cap`
        procs.kill(w.pid)
        store.markKilled(w.repo, w.issue, reason)
        w.killedReason = reason
        deps.log('warn', `${reason} (pid ${w.pid})`, { repo: w.repo, issue: w.issue })
      }
      const snap = ctx.snaps.get(w.repo)
      if (snap) await finish(deps, ctx, w, snap)
    },
    (w) => ({ repo: w.repo, issue: w.issue }),
  )
}

/**
 * A worker whose process is gone: run the exit check and make the transition.
 * The row is removed only after GitHub took the writes, so a failed write is
 * retried next tick.
 *
 * @param {Deps} deps @param {Ctx} ctx @param {Worker} w @param {Snapshot} snap
 */
export async function finish(deps, ctx, w, snap) {
  const repo = deps.config.repos.find((r) => r.slug === w.repo)
  const issue = snap.issues.get(w.issue)
  const pr = prFor(snap, w)
  const done = async () => {
    deps.store.removeWorker(w.repo, w.issue)
    if (!repo) return
    const t = await deps.spawner.cleanup({ repo, worktree: w.worktree, branch: w.branch })
    if (!t.removed) deps.log('warn', `kept worktree ${w.worktree}: ${t.reason}`, { repo: w.repo, issue: w.issue })
  }
  if (issue?.state !== 'OPEN') {
    deps.log('info', 'worker gone; issue is closed or no longer queued', { repo: w.repo, issue: w.issue })
    return done()
  }
  const m = markerOf(issue)
  const prepFailed = !w.killedReason && deps.spawner.tail(w.stderr, 15).includes(PREPARE_FAILED_LINE)
  const verdict = w.killedReason
    ? { ok: false, reason: w.killedReason }
    : prepFailed
      ? { ok: false, reason: 'could not start the worker: prepare failed' }
      : taskExit(pr, m)
  if (verdict.ok && pr) {
    const marker = {
      ...withHistory(m, { at: iso(ctx.now), attempt: m.attempt, outcome: 'submitted', pr: pr.number, log: w.stdout }),
      stage: /** @type {const} */ ('submitted'),
      pr: pr.number,
      branch: pr.branch,
      submittedAt: iso(ctx.now),
      queued: false,
      lastFailure: null,
    }
    await setMarker(deps, w.repo, issue, marker)
    await setLabels(deps, w.repo, issue, move(issue.labels, null))
    ctx.touched.add(key(w.repo, w.issue))
    deps.log('info', `submitted PR #${pr.number}; watching CI`, { repo: w.repo, issue: w.issue })
  } else {
    const tail = deps.spawner.tail(w.stderr, 15)
    const reason = `${'reason' in verdict ? verdict.reason : 'worker failed'}${tail ? `\n--- stderr (last lines, ${w.stderr})\n${tail}` : ''}`
    await requeue(deps, ctx, w.repo, issue, {
      reason,
      outcome: w.killedReason ? 'killed' : prepFailed ? 'spawn-failed' : 'failed',
      pr: pr?.number,
      log: w.stdout,
    })
  }
  await done()
}

// ---- Watch (no agent)

/** @param {Deps} deps @param {Ctx} ctx */
async function watch(deps, ctx) {
  for (const [slug, snap] of ctx.snaps) {
    const deleted = new Set()
    await each(
      deps,
      watchPairs(snap),
      async ([pr, issue]) => {
        if (ctx.touched.has(key(slug, issue.number))) return
        const m = markerOf(issue)
        if (pr.state === 'MERGED') {
          if (issue.state === 'OPEN') {
            const marker = {
              ...withHistory(m, { at: iso(ctx.now), attempt: m.attempt, outcome: 'merged', pr: pr.number }),
              stage: /** @type {const} */ ('done'),
            }
            await setMarker(deps, slug, issue, marker)
            await setLabels(deps, slug, issue, move(issue.labels, null))
            await deps.github.close(slug, issue.number, `Merged in #${pr.number}. Closed by cambium.`)
            issue.state = 'CLOSED'
            ctx.touched.add(key(slug, issue.number))
            deps.log('info', `PR #${pr.number} merged; closed`, { repo: slug, issue: issue.number })
          }
          if (pr.branchExists && !deleted.has(pr.branch)) {
            deleted.add(pr.branch)
            await deps.github.deleteBranch(slug, pr.branch)
          }
          return
        }
        if (pr.state !== 'OPEN' || issue.state !== 'OPEN') return
        if (!watched(deps, slug, issue)) return
        if ((pr.checks === 'FAILURE' || pr.checks === 'ERROR') && pr.headSha !== m.failedSha)
          return requeue(deps, ctx, slug, issue, {
            reason: failureSummary(pr),
            outcome: 'ci-red',
            pr: pr.number,
            failedSha: pr.headSha,
          })
        if (pr.inMergeQueue && !m.queued) await setMarker(deps, slug, issue, { ...m, queued: true })
        const settled = pr.checks !== 'PENDING' && pr.checks !== 'EXPECTED'
        if (m.queued && !pr.inMergeQueue && !pr.autoMerge && settled)
          return requeue(deps, ctx, slug, issue, {
            reason: `PR #${pr.number} left the merge queue without merging`,
            outcome: 'dequeued',
            pr: pr.number,
          })
        const cap = deps.config.mergeQueueMinutes
        if (m.submittedAt && ctx.now - Date.parse(m.submittedAt) > cap * MIN)
          return toHuman(deps, ctx, slug, issue, {
            reason: `PR #${pr.number} not merged within ${cap} min of submission`,
            outcome: 'stalled',
            pr: pr.number,
          })
      },
      ([, issue]) => ({ repo: slug, issue: issue.number }),
    )
  }
}

/**
 * Watch's work list: every (PR, issue it closes) pair where cambium already owns the issue's state comment.
 * @param {Snapshot} snap
 */
export function watchPairs(snap) {
  /** @type {[import('./github.mjs').PullRequest, Issue][]} */
  const pairs = []
  for (const pr of snap.prs)
    for (const n of pr.closes) {
      const issue = snap.issues.get(n)
      if (issue?.stateComment) pairs.push([pr, issue])
    }
  return pairs
}

/**
 * Watch acts on an open PR only while its issue is in no queue, holds no lease and has no tracked worker.
 * @param {Deps} deps @param {string} slug @param {Issue} issue
 */
export const watched = (deps, slug, issue) =>
  !(queueOf(issue.labels) || issue.labels.includes(RUNNING) || deps.store.worker(slug, issue.number))

// ---- Sweep: stale leases (a `running` label on this host with no tracked worker)

/** @param {Deps} deps @param {Ctx} ctx */
async function sweep(deps, ctx) {
  for (const [slug, snap] of ctx.snaps)
    await each(
      deps,
      staleLeases(deps, ctx, slug, snap),
      (issue) => requeue(deps, ctx, slug, issue, lostLease(deps)),
      (issue) => ({ repo: slug, issue: issue.number }),
    )
}

/**
 * Open issues labelled `running` on this host (or no host) with no tracked worker, untouched this tick.
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {Snapshot} snap
 */
export function staleLeases(deps, ctx, slug, snap) {
  return [...snap.issues.values()].filter((issue) => {
    if (issue.state !== 'OPEN' || !issue.labels.includes(RUNNING)) return false
    if (ctx.touched.has(key(slug, issue.number)) || deps.store.worker(slug, issue.number)) return false
    const host = issue.stateComment?.marker.host
    return !host || host === deps.config.host
  })
}

/** @param {Deps} deps */
export const lostLease = (deps) => ({
  reason: `worker lost: \`running\` on ${deps.config.host} with no live process`,
  outcome: 'lost',
})

// ---- Schedule

/** @param {Deps} deps @param {Ctx} ctx */
async function scheduleTasks(deps, ctx) {
  await each(
    deps,
    taskCandidates(deps, ctx),
    async (c) => {
      await startTask(deps, ctx, c.slug, c.issue, c.snap)
    },
    (c) => ({ repo: c.slug, issue: c.issue.number }),
  )
}

/**
 * The `q:task` issues to start this tick: no `running`, no tracked worker, by priority then age, up to the free
 * slots counted from live task workers.
 * @param {Deps} deps @param {Ctx} ctx
 */
export function taskCandidates(deps, ctx) {
  const { config, store } = deps
  const free = config.phases.task.cap - store.workers().filter((w) => w.phase === 'task').length
  /** @type {{ slug: string, issue: Issue, snap: Snapshot }[]} */
  const candidates = []
  for (const [slug, snap] of ctx.snaps)
    for (const issue of snap.issues.values())
      if (
        issue.state === 'OPEN' &&
        issue.labels.includes(Q.task) &&
        !issue.labels.includes(RUNNING) &&
        !store.worker(slug, issue.number)
      )
        candidates.push({ slug, issue, snap })
  const order = byPriorityThenAge(config.priorityLabels)
  candidates.sort((a, b) => order(a.issue, b.issue))
  return candidates.slice(0, Math.max(0, free))
}

/** @param {Deps} deps @param {Ctx} ctx */
async function scheduleDispatch(deps, ctx) {
  const { config } = deps
  const dispatchCap = config.phases.dispatch.cap
  if (dispatchCap > 0) {
    const dispatch = deps.dispatch ?? dispatchNotBuilt
    for (const [slug, snap] of ctx.snaps) {
      const intake = [...snap.issues.values()].filter((i) => i.state === 'OPEN' && i.labels.includes(Q.intake))
      if (!intake.length) continue
      intake.sort(byPriorityThenAge([]))
      const { started } = await dispatch({ repo: slug, intake, capacity: dispatchCap, now: ctx.now })
      if (!started.length && !deps.dispatch) deps.log('info', DISPATCH_NOT_BUILT, { repo: slug })
    }
  }
}

/**
 * Claim an issue and start its Task worker: marker, then `running`, then the
 * process. A crash between the claim and the spawn leaves a stale lease that
 * the next sweep requeues.
 *
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {Issue} issue @param {Snapshot} snap
 * @param {{ foreground?: boolean }} [opts]
 * @returns {Promise<(import('./workers.mjs').Started & { attempt: number }) | null>}
 */
export async function startTask(deps, ctx, slug, issue, snap, { foreground = false } = {}) {
  const { config } = deps
  const repo = config.repos.find((r) => r.slug === slug)
  if (!repo) throw new Error(`${slug} is not in the config`)
  const caps = config.phases.task
  const m0 = markerOf(issue)
  if (m0.attempt > caps.maxAttempts) {
    await toHuman(deps, ctx, slug, issue, { reason: `${caps.maxAttempts} attempts spent`, outcome: 'budget' })
    return null
  }
  /** @type {import('./convention.mjs').Convention} */
  let convention
  try {
    convention = deps.spawner.convention(repo)
  } catch (err) {
    await requeue(deps, ctx, slug, issue, {
      reason: `could not start the worker: ${/** @type {Error} */ (err)?.message ?? err}`,
      outcome: 'spawn-failed',
    })
    return null
  }
  const known = prFor(snap, { issue: issue.number, branch: m0.branch })
  const pr = known?.state === 'OPEN' ? known : null
  // Sticky: a retry keeps the branch (and so the worktree topic) its first attempt chose.
  const branch = pr?.branch ?? m0.branch ?? branchName(convention.branch, issue.number, issue.title)
  const marker = {
    ...m0,
    phase: /** @type {const} */ ('task'),
    stage: /** @type {const} */ ('running'),
    host: config.host,
    start: iso(ctx.now),
    branch,
    pr: pr?.number ?? m0.pr ?? null,
  }
  await setMarker(deps, slug, issue, marker)
  await setLabels(deps, slug, issue, move(issue.labels, Q.task, { running: true }))
  ctx.touched.add(key(slug, issue.number))

  let started
  try {
    started = await deps.spawner.start({
      repo,
      convention,
      issue: issue.number,
      attempt: marker.attempt,
      branch,
      phase: 'task',
      maxTurns: caps.maxTurns,
      foreground,
      buildPrompt: (agentsMd) =>
        taskPrompt({ repo: slug, issue, marker, branch, pr, agentsMd, maxAttempts: caps.maxAttempts }),
    })
  } catch (err) {
    await requeue(deps, ctx, slug, issue, {
      reason: `could not start the worker: ${/** @type {Error} */ (err)?.message ?? err}`,
      outcome: 'spawn-failed',
    })
    return null
  }
  deps.store.addWorker({
    repo: slug,
    issue: issue.number,
    phase: 'task',
    pid: started.pid,
    worktree: started.worktree,
    branch,
    attempt: marker.attempt,
    startedAt: ctx.now,
    host: config.host,
    stdout: started.stdout,
    stderr: started.stderr,
  })
  if (started.reused)
    deps.log('warn', `continuing in the previous worktree ${started.worktree}: ${started.reused}`, {
      repo: slug,
      issue: issue.number,
    })
  deps.log('info', `started task worker pid ${started.pid} (attempt ${marker.attempt}, ${branch})`, {
    repo: slug,
    issue: issue.number,
  })
  return { ...started, attempt: marker.attempt }
}

// ---- Release (once a day, no agent): schedule is real, the run is a seam.

/** @param {Deps} deps @param {Ctx} ctx */
async function release(deps, ctx) {
  const { config, store } = deps
  if (!config.release.enabled) return
  const last = store.get('release.lastRun')
  if (!releaseDue(ctx.now, last === null ? null : Number(last), config.release.time)) return
  store.set('release.lastRun', String(ctx.now))
  for (const repo of config.repos) {
    const result = await (deps.release ?? releaseNotBuilt)({ repo, now: ctx.now })
    deps.log('info', `release: ${result.note}`, { repo: repo.slug })
  }
}

// ---- Heartbeat

/**
 * @typedef {{ intake: number, task: number, human: number, promote: number, running: number, review: number }} Counts
 * @typedef {{
 *   version: 1,
 *   host: string,
 *   pid: number,
 *   mode: import('./store.mjs').Mode,
 *   daemon: { startedAt: string | null, tickSeconds: number },
 *   tick: { n: number, startedAt: string, finishedAt: string, durationMs: number, nextAt: string },
 *   steps: StepResult[],
 *   counts: Counts & { workers: number },
 *   caps: { task: number, dispatch: number },
 *   repos: { slug: string, ok: boolean, error: string | null, counts: Counts | null }[],
 *   workers: {
 *     repo: string, issue: number, phase: string, pid: number, alive: boolean, attempt: number, branch: string,
 *     worktree: string, startedAt: string, elapsedMs: number, wallClockMs: number, killedReason: string | null,
 *     logs: { stdout: string, stderr: string },
 *   }[],
 *   events: Event[],
 * }} HeartbeatState
 */

/** @param {Snapshot} snap @returns {Counts} */
function countsOf(snap) {
  const c = { intake: 0, task: 0, human: 0, promote: 0, running: 0, review: 0 }
  for (const issue of snap.issues.values()) {
    if (issue.state !== 'OPEN') continue
    const q = queueOf(issue.labels)
    if (q === Q.intake) c.intake++
    else if (q === Q.task) c.task++
    else if (q === Q.human) c.human++
    else if (q === Q.promote) c.promote++
    if (issue.labels.includes(RUNNING)) c.running++
  }
  c.review = snap.prs.filter((p) => p.state === 'OPEN').length
  return c
}

/** @param {Deps} deps @param {Ctx} ctx @returns {HeartbeatState} */
export function heartbeatState(deps, ctx) {
  const { config } = deps
  const finished = deps.clock.now()
  const repos = config.repos.map((r) => {
    const snap = ctx.snaps.get(r.slug)
    return {
      slug: r.slug,
      ok: Boolean(snap),
      error: ctx.readErrors.get(r.slug) ?? null,
      counts: snap ? countsOf(snap) : null,
    }
  })
  const total = { intake: 0, task: 0, human: 0, promote: 0, running: 0, review: 0 }
  for (const r of repos)
    if (r.counts) for (const k of /** @type {(keyof Counts)[]} */ (Object.keys(total))) total[k] += r.counts[k]
  const workers = deps.store.workers().map((w) => {
    const caps = config.phases[/** @type {'task'} */ (w.phase)] ?? config.phases.task
    return {
      repo: w.repo,
      issue: w.issue,
      phase: w.phase,
      pid: w.pid,
      alive: deps.procs.alive(w.pid),
      attempt: w.attempt,
      branch: w.branch,
      worktree: w.worktree,
      startedAt: iso(w.startedAt),
      elapsedMs: finished - w.startedAt,
      wallClockMs: caps.wallClockMinutes * MIN,
      killedReason: w.killedReason,
      logs: { stdout: w.stdout, stderr: w.stderr },
    }
  })
  return {
    version: 1,
    host: config.host,
    pid: deps.pid ?? process.pid,
    mode: ctx.mode,
    daemon: { startedAt: deps.daemonStartedAt ? iso(deps.daemonStartedAt) : null, tickSeconds: config.tickSeconds },
    tick: {
      n: deps.tickNumber ?? 0,
      startedAt: iso(ctx.now),
      finishedAt: iso(finished),
      durationMs: finished - ctx.now,
      nextAt: iso(finished + config.tickSeconds * 1000),
    },
    steps: [...ctx.steps],
    counts: { ...total, workers: workers.length },
    caps: { task: config.phases.task.cap, dispatch: config.phases.dispatch.cap },
    repos,
    workers,
    events: deps.events?.() ?? [],
  }
}
