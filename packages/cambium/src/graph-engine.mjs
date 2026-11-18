// @ts-check
/**
 * `engine: "graph"`: the Task-phase steps of the tick, driven through the `task` graph (graphs/task.mjs).
 *
 * The tick keeps its shape (Reconcile → Watch → Sweep → Schedule) so both engines make the same moves in the
 * same order; each step only chooses where an issue's turn starts:
 *
 * - Reconcile: every tracked worker's issue at `worker-running`.
 * - Watch: issues resting at `ci-running` / `merge-queue` (from the marker); a merged PR goes to `close-out`
 *   from wherever the issue is.
 * - Sweep: a stale `running` lease runs its node's `recover` (default: `requeue`).
 * - Schedule: the gate on the entry node. Caps and priority pick the issues; each starts at `start-worker`.
 *
 * A turn ({@link drive}) advances one transition at a time and stops when it reaches the entry node again (only
 * Schedule admits entries), when it enters a wait (polled next tick, unless the wait is `pollOnEntry`), at END,
 * or at a wait that is not ready.
 */
import { advance, END } from './graph/index.mjs'
import { deleteMergedBranch, inputFor, lostLeaseOf, nodeOf, task, TASK_QUEUES, TERMINAL } from './graphs/task.mjs'
import { iso, key, markerOf, setLabels, setMarker } from './issue-state.mjs'
import { effectivePosition, graphVersionDecision, withHistory } from './marker.mjs'
import { each, newCtx, staleLeases, taskCandidates, watched, watchPairs } from './tick.mjs'
import { move, Q } from './labels.mjs'

/**
 * @typedef {import('./tick.mjs').Deps} Deps
 * @typedef {import('./tick.mjs').Ctx} Ctx
 * @typedef {import('./graphs/task.mjs').Subject} Subject
 * @typedef {import('./graphs/task.mjs').Position} Position
 * @typedef {import('./graph/advance.mjs').Transition} Transition
 * @typedef {{ transitions: Transition[], reason: 'waiting' | 'gated' | 'end', node: string, input: unknown }} Turn
 */

/** @param {Deps} deps @param {Ctx} ctx @param {Subject} subject @returns {import('./graphs/task.mjs').TaskCtx} */
const taskCtx = (deps, ctx, subject) => ({ ...deps, tick: ctx, subject })

/**
 * One issue's turn from `at`. A node error is rethrown as the node's own error (the step logs it, as the legacy
 * tick does); a worker whose `worker-running` was left is torn down only after the turn's writes succeeded.
 *
 * @param {Deps} deps @param {Ctx} ctx @param {Subject} subject @param {Position} at
 * @returns {Promise<Turn>}
 */
export async function drive(deps, ctx, subject, at) {
  const c = taskCtx(deps, ctx, subject)
  /** @type {Transition[]} */
  const transitions = []
  let pos = at
  /** @type {Turn['reason']} */
  let reason
  for (;;) {
    const r = await advance(task, pos, c, { maxTransitions: 1 })
    if (r.error) throw r.error.cause instanceof Error ? r.error.cause : r.error
    transitions.push(...r.transitions)
    const t = r.transitions[0]
    if (t && t.to !== END) await nodeOf(t.to).enter?.(t.next, c)
    pos = { node: r.node, input: r.input }
    if (r.reason !== 'limit') {
      reason = r.reason === 'waiting' ? 'waiting' : 'end'
      break
    }
    if (r.node === task.entry.node) {
      reason = 'gated'
      break
    }
    const next = nodeOf(r.node)
    if (next.kind === 'wait' && !next.pollOnEntry) {
      reason = 'waiting'
      break
    }
  }
  if (transitions.some((t) => t.from === 'worker-running')) await releaseWorker(deps, subject)
  return { transitions, reason, ...pos }
}

/** The worker row goes, then its worktree (kept, with a warning, when it holds local-only work). @param {Deps} deps @param {Subject} s */
async function releaseWorker(deps, s) {
  const w = deps.store.worker(s.slug, s.number)
  if (!w) return
  deps.store.removeWorker(s.slug, s.number)
  const repo = deps.config.repos.find((r) => r.slug === s.slug)
  if (!repo) return
  const t = await deps.spawner.cleanup({ repo, worktree: w.worktree, branch: w.branch })
  if (!t.removed) deps.log('warn', `kept worktree ${w.worktree}: ${t.reason}`, { repo: s.slug, issue: s.number })
}

/**
 * Where an issue rests in the task graph, from its labels and marker: the label wins (marker.mjs
 * `effectivePosition`), a stage-era `submitted` that the merge queue holds is `merge-queue`, and a node the
 * current graph version no longer has restarts at the entry (with a `graph-changed` history note).
 *
 * @param {import('./github.mjs').Issue} issue @param {number} now
 * @returns {(Position & { note?: import('./marker.mjs').HistoryEntry }) | null} null: not in the task graph
 */
export function locate(issue, now) {
  const marker = issue.stateComment?.marker ?? null
  const pos = effectivePosition(issue.labels, marker, TASK_QUEUES)
  if (!pos || pos.graph !== task.name) return null
  if (pos.reset || !marker) return { node: task.entry.node, input: {} }
  const v = graphVersionDecision(marker, {
    version: task.version,
    nodes: task.nodes.map((n) => n.name),
    entryNode: task.entry.node,
    at: iso(now),
  })
  if (v.action === 'restart') return { node: v.node, input: {}, note: v.note }
  const node = pos.node === 'ci-running' && marker.queued ? 'merge-queue' : pos.node
  return { node, input: inputFor(node, marker) }
}

/**
 * A marker whose node is gone from the graph: back to `q:task` at the entry, with the note in its history.
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {import('./github.mjs').Issue} issue
 * @param {import('./marker.mjs').HistoryEntry} note
 */
async function restart(deps, ctx, slug, issue, note) {
  const m = markerOf(issue)
  await setMarker(deps, slug, issue, {
    ...withHistory(m, note),
    graph: task.name,
    graphVersion: task.version,
    node: task.entry.node,
    status: 'waiting',
    host: null,
    start: null,
    input: null,
  })
  await setLabels(deps, slug, issue, move(issue.labels, Q.task))
  ctx.touched.add(key(slug, issue.number))
  deps.log('info', note.reason ?? 'graph changed; restarting', { repo: slug, issue: issue.number })
}

// ---- The Task-phase steps

/** @param {Deps} deps @param {Ctx} ctx */
async function reconcile(deps, ctx) {
  await each(
    deps,
    deps.store.workers(),
    async (w) => {
      const snap = ctx.snaps.get(w.repo)
      const subject = { slug: w.repo, number: w.issue, snap, issue: snap?.issues.get(w.issue) }
      await drive(deps, ctx, subject, { node: 'worker-running', input: { branch: w.branch, attempt: w.attempt } })
    },
    (w) => ({ repo: w.repo, issue: w.issue }),
  )
}

/** @param {Deps} deps @param {Ctx} ctx */
async function watch(deps, ctx) {
  for (const [slug, snap] of ctx.snaps) {
    /** @type {Set<string>} */
    const deleted = new Set()
    await each(
      deps,
      watchPairs(snap),
      async ([pr, issue]) => {
        if (ctx.touched.has(key(slug, issue.number))) return
        /** @type {Subject} */
        const subject = { slug, number: issue.number, snap, issue, pr, deleted }
        if (pr.state === 'MERGED') {
          if (issue.state === 'OPEN') await drive(deps, ctx, subject, { node: 'close-out', input: { pr: pr.number } })
          else await deleteMergedBranch(taskCtx(deps, ctx, subject), pr)
          return
        }
        if (pr.state !== 'OPEN' || issue.state !== 'OPEN' || !watched(deps, slug, issue)) return
        const at = locate(issue, ctx.now)
        if (at?.note) return restart(deps, ctx, slug, issue, at.note)
        if (at?.node === 'ci-running' || at?.node === 'merge-queue') await drive(deps, ctx, subject, at)
      },
      ([, issue]) => ({ repo: slug, issue: issue.number }),
    )
  }
}

/** @param {Deps} deps @param {Ctx} ctx */
async function sweep(deps, ctx) {
  for (const [slug, snap] of ctx.snaps)
    await each(
      deps,
      staleLeases(deps, ctx, slug, snap),
      async (issue) => {
        const subject = { slug, number: issue.number, snap, issue }
        const c = taskCtx(deps, ctx, subject)
        const at = locate(issue, ctx.now)
        const recover = (at && nodeOf(at.node).recover) || defaultRecover
        await drive(deps, ctx, subject, recover(c))
      },
      (issue) => ({ repo: slug, issue: issue.number }),
    )
}

/** @param {Deps} deps @param {Ctx} ctx */
async function scheduleTasks(deps, ctx) {
  await each(
    deps,
    taskCandidates(deps, ctx),
    async (c) => {
      const subject = { slug: c.slug, number: c.issue.number, snap: c.snap, issue: c.issue }
      await drive(deps, ctx, subject, { node: task.entry.node, input: {} })
    },
    (c) => ({ repo: c.slug, issue: c.issue.number }),
  )
}

/** A stale lease at a node without its own `recover`: requeue. @param {import('./graphs/task.mjs').TaskCtx} c */
const defaultRecover = (c) => ({ node: 'requeue', input: lostLeaseOf(c) })

/** @type {import('./tick.mjs').Engine} */
export const GRAPH_ENGINE = { reconcile, watch, sweep, scheduleTasks }

// ---- `cambium run <graph> --issue <n> [--follow]`

/** Graphs `cambium run` knows, by name. */
export const GRAPHS = { [task.name]: task }

/**
 * The graph runtime in the foreground for one issue. A `q:task` issue without a lease starts at the entry with a
 * foreground worker, whose exit is awaited; anything else resumes where its marker rests. Stops at the first wait
 * that is not ready, unless `follow`, which re-reads and polls again every `tickSeconds` until the graph ends.
 *
 * @param {Deps} deps
 * @param {{
 *   graph: string, slug: string, number: number, follow?: boolean,
 *   out: (line: string) => void, sleep?: (ms: number) => Promise<void>, signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function runIssue(deps, { graph, slug, number, follow = false, out, sleep = delay, signal }) {
  if (!Object.hasOwn(GRAPHS, graph))
    return { ok: false, error: `unknown graph "${graph}"; known: ${Object.keys(GRAPHS).join(', ')}` }
  /** @type {Set<number>} */
  const reaped = new Set()
  let first = true
  for (;;) {
    const ctx = newCtx(deps)
    const snap = await deps.github.read(slug)
    ctx.snaps.set(slug, snap)
    const issue = snap.issues.get(number)
    if (issue?.state !== 'OPEN') {
      if (first) return { ok: false, error: `${slug}#${number} is not an open issue` }
      return report(out, slug, number, issue)
    }
    const worker = deps.store.worker(slug, number)
    const fresh = issue.labels.includes(Q.task) && !issue.labels.includes('running') && !worker
    const located = fresh
      ? { node: task.entry.node, input: {} }
      : worker
        ? { node: 'worker-running', input: { branch: worker.branch, attempt: worker.attempt } }
        : locate(issue, ctx.now)
    if (!located || TERMINAL.has(located.node)) {
      if (first) return { ok: false, error: `${slug}#${number} has nothing to run in the ${graph} graph` }
      return report(out, slug, number, issue)
    }
    if (located.note) await restart(deps, ctx, slug, issue, located.note)
    /** @type {Subject} */
    const subject = { slug, number, snap, issue, foreground: true, reaped }
    const turn = located.note ? null : await drive(deps, ctx, subject, located)
    if (subject.started) {
      const s = subject.started
      out(`worker pid ${s.pid} in ${s.worktree}\n  stdout ${s.stdout}\n  stderr ${s.stderr}`)
      const code = await s.exited
      out(`worker exited ${code}`)
      reaped.add(s.pid)
      first = false
      continue
    }
    if (first && fresh && !follow)
      return { ok: false, error: `${slug}#${number} was not started; see its state comment` }
    first = false
    if (turn?.reason === 'end' || !follow || signal?.aborted) return report(out, slug, number, issue)
    await sleep(deps.config.tickSeconds * 1000)
    if (signal?.aborted) return report(out, slug, number, issue)
  }
}

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {(line: string) => void} out @param {string} slug @param {number} n
 * @param {import('./github.mjs').Issue | undefined} issue
 */
function report(out, slug, n, issue) {
  const m = issue?.state === 'OPEN' ? issue.stateComment?.marker : null
  const where = m ? `${m.node}${m.status === 'waiting' ? '' : ` (${m.status})`}` : 'closed'
  out(`${slug}#${n}: ${where} · labels ${issue?.labels.join(', ') || '(none)'}`)
  return { ok: true }
}
