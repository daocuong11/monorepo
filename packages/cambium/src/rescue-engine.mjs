// @ts-check
/**
 * `engine: "graph"`: the rescue graph's steps (graphs/rescue.mjs), run in upkeep while `phases.rescue.cap > 0`.
 *
 * - Reconcile (every tick): every tracked rescue worker's item at `diagnosing`, with the item as `findStuck` sees it
 *   now (null once it is no longer stuck, so a stale verdict is never applied).
 * - Sweep (every `rescue.everyMinutes`): read each repo's closed-unmerged agent PRs and the open issues they left in no
 *   queue, find the stuck items (phases/rescue.mjs `findStuck`), skip any rescued in the last `rescue.cooldownHours`,
 *   and start each at `start-rescue`: those over `rescue.maxRescues` go to a human whatever the cap, the rest up to
 *   the free rescue slots, oldest issue first.
 */
import { advance, END } from './graph/index.mjs'
import { rescue } from './graphs/rescue.mjs'
import { key, MIN } from './issue-state.mjs'
import { findStuck, rescuesOf, stillStuck } from './phases/rescue.mjs'
import { branchIssue } from './github.mjs'
import { each, eachWorker } from './tick.mjs'
import { markerTrace, turnTracer } from './tracing.mjs'

/**
 * @typedef {import('./tick.mjs').Deps} Deps
 * @typedef {import('./tick.mjs').Ctx} Ctx
 * @typedef {import('./github.mjs').Snapshot} Snapshot
 * @typedef {import('./github.mjs').PullRequest} PullRequest
 * @typedef {import('./graphs/rescue.mjs').RescueSubject} RescueSubject
 * @typedef {import('./graph/advance.mjs').Transition} Transition
 */

export const PHASE = 'rescue'

/**
 * One item's turn through the rescue graph from `at`, until it waits or ends. A node error is rethrown (the step logs
 * it); a rescue worker whose `diagnosing` was left is torn down only after the turn's writes succeeded.
 * @param {Deps} deps @param {Ctx} ctx @param {RescueSubject} subject @param {{ node: string, input: unknown }} at
 */
export async function driveRescue(deps, ctx, subject, at) {
  const c = { ...deps, tick: ctx, subject }
  const traced = turnTracer(deps.telemetry, subject, {
    graph: rescue.name,
    graphVersion: rescue.version,
    repo: subject.slug,
    issue: subject.number,
    issueBody: subject.issue?.body ?? null,
    ...markerTrace(subject.issue?.stateComment?.marker),
  })
  /** @type {Transition[]} */
  const transitions = []
  let pos = at
  for (;;) {
    const r = await advance(rescue, pos, c, { maxTransitions: 1, instrument: traced.instrument })
    if (r.error) throw r.error.cause instanceof Error ? r.error.cause : r.error
    traced.sync()
    transitions.push(...r.transitions)
    pos = { node: r.node, input: r.input }
    if (r.reason !== 'limit') break
    if (rescue.nodes.find((n) => n.name === r.node)?.kind === 'wait') break
  }
  if (transitions.some((t) => t.from === 'diagnosing')) await releaseWorker(deps, subject)
  return { transitions, ended: transitions.some((t) => t.to === END), ...pos }
}

/** The rescue worker's row goes, then its read-only checkout. @param {Deps} deps @param {RescueSubject} s */
async function releaseWorker(deps, s) {
  const w = deps.store.worker(s.slug, s.number)
  if (!w || w.phase !== PHASE) return
  deps.store.removeWorker(s.slug, s.number)
  const repo = deps.config.repos.find((r) => r.slug === s.slug)
  if (!repo) return
  const t = await deps.spawner.cleanup({ repo, worktree: w.worktree, branch: w.branch, readOnly: true })
  if (!t.removed) deps.log('warn', `kept worktree ${w.worktree}: ${t.reason}`, { repo: s.slug, issue: s.number })
}

/** Live workers per phase. @param {Deps} deps @param {string} phase */
const live = (deps, phase) => deps.store.workers().filter((w) => w.phase === phase).length

/**
 * The repo's snapshot with the issues `numbers` read in where it lacks them. A copy: the tick's own snapshot is left as
 * Read made it; the issue objects are shared, so a write through either is seen by both.
 * @param {Deps} deps @param {string} slug @param {Snapshot} snap @param {number[]} numbers
 * @returns {Promise<Snapshot>}
 */
async function withIssues(deps, slug, snap, numbers) {
  const issues = new Map(snap.issues)
  const unread = [...new Set(numbers)].filter((n) => !issues.has(n))
  if (unread.length) for (const [n, i] of await deps.github.readIssues(slug, unread)) issues.set(n, i)
  return { ...snap, issues }
}

/**
 * The repo's snapshot as the sweep sees it: plus its closed-unmerged agent PRs, and the issues they name.
 * @param {Deps} deps @param {string} slug @param {Snapshot} snap
 * @returns {Promise<{ view: Snapshot, closed: PullRequest[] }>}
 */
export async function sweepView(deps, slug, snap) {
  const closed = (await deps.github.closedPulls(slug)).filter((p) => p.branch.startsWith('agent/'))
  const named = closed.flatMap((p) => (p.closes.length ? p.closes : [branchIssue(p.branch)].filter((n) => n !== null)))
  const view = await withIssues(deps, slug, snap, /** @type {number[]} */ (named))
  // Only an open issue left in no queue is stranded; a closed one is no concern of the rescue.
  for (const n of named)
    if (!snap.issues.has(/** @type {number} */ (n))) {
      const i = view.issues.get(/** @type {number} */ (n))
      if (i && (i.state !== 'OPEN' || i.labels.some((l) => l.startsWith('q:')))) view.issues.delete(i.number)
    }
  return { view, closed }
}

/**
 * The stuck items in one repo's view.
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {Snapshot} view
 * @param {{ closed?: PullRequest[], recheck?: boolean, busy?: (n: number) => boolean }} [o]
 */
export function stuckIn(deps, ctx, slug, view, { closed = [], recheck = false, busy } = {}) {
  const { config } = deps
  return findStuck(view, {
    slug,
    now: ctx.now,
    host: config.host,
    running: ctx.mode === 'running',
    staleHours: config.rescue.staleHours,
    graceMinutes: config.rescue.graceMinutes,
    free: {
      task: config.phases.task.cap - live(deps, 'task'),
      dispatch: config.phases.dispatch.cap - live(deps, 'dispatch'),
    },
    busy: busy ?? ((n) => ctx.touched.has(key(slug, n)) || Boolean(deps.store.worker(slug, n))),
    closed,
    recheck,
  })
}

/** @param {Deps} deps @param {Ctx} ctx */
async function reconcile(deps, ctx) {
  await eachWorker(
    deps,
    ctx,
    deps.store.workers().filter((w) => w.phase === PHASE),
    async (w) => {
      const base = ctx.snaps.get(w.repo)
      const snap = base ? await withIssues(deps, w.repo, base, [w.issue]) : undefined
      const issue = snap?.issues.get(w.issue)
      const stuck = snap
        ? stillStuck(
            deps.store,
            stuckIn(deps, ctx, w.repo, snap, { recheck: true, busy: (n) => ctx.touched.has(key(w.repo, n)) }).find(
              (s) => s.number === w.issue,
            ),
          )
        : null
      await driveRescue(
        deps,
        ctx,
        { slug: w.repo, number: w.issue, snap, issue, stuck },
        {
          node: 'diagnosing',
          input: { attempt: w.attempt },
        },
      )
    },
  )
}

/** @param {Deps} deps @param {Ctx} ctx */
async function sweep(deps, ctx) {
  const { config, store } = deps
  const last = Number(store.get('rescue.lastRun') ?? 0)
  if (!config.rescue.everyMinutes || ctx.now - last < config.rescue.everyMinutes * MIN) return
  store.set('rescue.lastRun', String(ctx.now))
  let free = config.phases.rescue.cap - live(deps, PHASE)
  for (const [slug, snap] of ctx.snaps) {
    /** @type {{ view: Snapshot, closed: PullRequest[] }} */
    let read
    try {
      read = await sweepView(deps, slug, snap)
    } catch (err) {
      deps.log('error', `rescue: reading closed PRs: ${/** @type {Error} */ (err)?.message ?? err}`, { repo: slug })
      read = { view: snap, closed: [] }
    }
    const found = stuckIn(deps, ctx, slug, read.view, { closed: read.closed })
    const cooled = found.filter((s) => {
      const at = rescuesOf(store, slug, s.number, ctx.now)
      return !at.length || ctx.now - /** @type {number} */ (at.at(-1)) >= config.rescue.cooldownHours * 60 * MIN
    })
    if (found.length)
      deps.log(
        'info',
        `rescue: ${found.length} stuck (${found.map((s) => `#${s.number} ${s.symptoms.map((x) => x.code).join('+')}`).join(', ')}); ${found.length - cooled.length} cooling down`,
        { repo: slug },
      )
    const spent = cooled.filter((s) => rescuesOf(store, slug, s.number, ctx.now).length >= config.rescue.maxRescues)
    const fresh = cooled.filter((s) => !spent.includes(s)).slice(0, Math.max(0, free))
    free -= fresh.length
    await each(
      deps,
      [...spent, ...fresh],
      async (stuck) => {
        const issue = read.view.issues.get(stuck.number)
        const pr = stuck.pr ? ([...read.view.prs, ...read.closed].find((p) => p.number === stuck.pr) ?? null) : null
        await driveRescue(
          deps,
          ctx,
          { slug, number: stuck.number, snap: read.view, issue, pr, stuck },
          {
            node: rescue.entry.node,
            input: {},
          },
        )
      },
      (s) => ({ repo: slug, issue: s.number }),
    )
  }
}

/**
 * The rescue steps, in upkeep: tracked rescue workers every tick (even with the cap since set to 0), the sweep on its
 * clock while `phases.rescue.cap > 0`.
 * @param {Deps} deps @param {Ctx} ctx
 */
export async function rescueStep(deps, ctx) {
  await reconcile(deps, ctx)
  if (deps.config.phases.rescue.cap > 0) await sweep(deps, ctx)
}

/**
 * `cambium run rescue [--repo <slug>] [--issue <n>]`. Without `--issue`: list what the sweep would find now (the
 * cooldown aside), and change nothing. With it: rescue that item in the foreground if the sweep would find it stuck
 * (the cooldown aside; one over `rescue.maxRescues` goes to a human): a foreground rescue worker, then its verdict
 * carried out.
 * @param {Deps} deps
 * @param {{ slug: string, number?: number, out: (line: string) => void, newCtx: (deps: Deps) => Ctx }} o
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function runRescue(deps, { slug, number, out, newCtx }) {
  const ctx = newCtx(deps)
  const snap = await deps.github.read(slug)
  ctx.snaps.set(slug, snap)
  const { view, closed } = await sweepView(deps, slug, snap)
  if (number === undefined) {
    const found = stuckIn(deps, ctx, slug, view, { closed })
    if (!found.length) out(`${slug}: nothing stuck`)
    for (const s of found) {
      const n = rescuesOf(deps.store, slug, s.number, ctx.now).length
      out(`${slug}#${s.number}${n ? ` (rescued ${n}× this week)` : ''}`)
      for (const x of s.symptoms) out(`  ${x.code}: ${x.detail}`)
    }
    return { ok: true }
  }
  if (deps.store.worker(slug, number)) return { ok: false, error: `${slug}#${number} has a tracked worker` }
  const pre = await withIssues(deps, slug, view, [number])
  const stuck = stuckIn(deps, ctx, slug, pre, { closed }).find((s) => s.number === number)
  if (!stuck) return { ok: false, error: `${slug}#${number} is not stuck` }
  const issue = pre.issues.get(number)
  const pr = stuck.pr ? ([...pre.prs, ...closed].find((p) => p.number === stuck.pr) ?? null) : null
  /** @type {RescueSubject} */
  const subject = { slug, number, snap: pre, issue, pr, stuck, foreground: true }
  const first = await driveRescue(deps, ctx, subject, { node: rescue.entry.node, input: {} })
  if (subject.started) {
    const s = subject.started
    out(`rescue worker pid ${s.pid} in ${s.worktree}\n  stdout ${s.stdout}\n  stderr ${s.stderr}`)
    out(`rescue worker exited ${await s.exited}`)
    const after = newCtx(deps)
    const snap2 = await withIssues(deps, slug, await deps.github.read(slug), [number])
    after.snaps.set(slug, snap2)
    const now = stillStuck(
      deps.store,
      stuckIn(deps, after, slug, snap2, { closed, recheck: true, busy: () => false }).find(
        (s2) => s2.number === number,
      ),
    )
    const turn = await driveRescue(
      deps,
      after,
      { slug, number, snap: snap2, issue: snap2.issues.get(number), stuck: now, reaped: new Set([s.pid]) },
      { node: 'diagnosing', input: { attempt: s.attempt } },
    )
    out(`${slug}#${number}: ${turn.transitions.map((t) => String(t.to)).join(' → ') || 'waiting'}`)
    return { ok: true }
  }
  out(`${slug}#${number}: ${first.transitions.map((t) => String(t.to)).join(' → ')}`)
  return { ok: true }
}
