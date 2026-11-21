// @ts-check
/**
 * Release as two graphs (`engine: "graph"`), replacing the `phases/release.mjs` stub there. Their subject is the
 * repo's promotion PR, `release.from` → `release.to` (e.g. `develop` → `main`), and the marker (v2) is cambium's
 * state comment on that PR, written through the same path as an issue's (issue-state.mjs).
 *
 * - `release-prepare`: a clock entry, once a day at the repo's `release.time` (`releaseDue`, with the last run in
 *   the store). `cleanup` closes, with a comment, every open promotion PR older than 24 h; `prepare` opens the
 *   promotion PR (or refreshes the open one) when `from` is ahead of `to`, labels it `q:promote` and exits.
 * - `release-promote`: `q:promote` is its queue. It enters at `merge` once the PR is approved, merges through
 *   `graft pr merge --auto` (auto-merge, or a merge now when the PR is clean), waits at `merging`, and exits at
 *   `promoted` (merged) or `abandoned` (closed unmerged), taking `q:promote` off.
 *
 * Neither graph has a timeout: the daily cleanup is the only 24 h rule.
 */
import { z } from 'zod'
import { advance, defineGraph, defineNode, defineWait, END } from '../graph/index.mjs'
import { iso, setLabels, setMarker } from '../issue-state.mjs'
import { move, Q } from '../labels.mjs'
import { effectivePosition, newMarker, withHistory } from '../marker.mjs'
import { releaseDue } from '../phases/release.mjs'
import { markerTrace, turnTracer } from '../tracing.mjs'

/**
 * @typedef {import('../github.mjs').PromotionPr} PromotionPr
 * @typedef {import('../github.mjs').Release} Release
 * @typedef {import('../marker.mjs').Marker} Marker
 * @typedef {{
 *   slug: string, repo: import('../config.mjs').Repo, release: Release, pr?: PromotionPr, traceparent?: string | null,
 * }} ReleaseSubject
 *   One repo's turn; `pr` is the promotion PR a `release-promote` turn is about; `traceparent` the turn's trace
 *   while it is traced (tracing.mjs `turnTracer`), which markers written in the turn take when they have none.
 * @typedef {import('../tick.mjs').Deps & { tick: import('../tick.mjs').Ctx, subject: ReleaseSubject }} ReleaseCtx
 * @typedef {{ queue: string | null, about?: string, enter?: (input: any, ctx: ReleaseCtx) => Promise<void> }} Declared
 *   `queue`: the label a PR resting here carries. `enter`: the write that lands a PR on this wait.
 */

const DAY = 24 * 60 * 60 * 1000

/**
 * @template {import('../graph/define.mjs').GraphNode} N @param {N} node @param {Declared} decl
 * @returns {N & Declared}
 */
const declare = (node, decl) => Object.freeze({ ...node, ...decl })

/** @param {ReleaseCtx} ctx */
function prOf(ctx) {
  const { pr } = ctx.subject
  if (!pr) throw new Error(`${ctx.subject.slug}: no promotion PR in this turn`)
  return pr
}

/** @param {ReleaseCtx} ctx @param {number} pr */
const where = (ctx, pr) => ({ repo: ctx.subject.slug, issue: pr })

/** A PR's marker, or a fresh one for a release graph. @param {PromotionPr} pr @param {string} graph @param {string} node */
const markerOn = (pr, graph, node) =>
  pr.stateComment?.marker ?? newMarker({ graph, node, phase: 'release', pr: pr.number })

/** Release markers carry none of the stage tick's fields. @param {Marker} m */
const releaseMarker = (m) =>
  /** @type {Marker} */ (Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'stage')))

/**
 * Put `pr` at `node` of `graph`: the marker first, then the labels `node` declares, via `move()`.
 * @param {ReleaseCtx} ctx @param {PromotionPr} pr @param {import('../graph/define.mjs').Graph} graph @param {string} node
 * @param {Marker} marker @param {{ status?: Marker['status'] }} [opts]
 */
async function land(ctx, pr, graph, node, marker, { status = 'waiting' } = {}) {
  const { slug } = ctx.subject
  const decl = /** @type {Declared} */ (/** @type {unknown} */ (graph.nodes.find((n) => n.name === node)))
  // The PR's state comment is an issue comment: setMarker / setLabels take the PR as the issue.
  const issue = /** @type {import('../github.mjs').Issue} */ (/** @type {unknown} */ (pr))
  await setMarker(ctx, slug, issue, {
    ...releaseMarker(marker),
    graph: graph.name,
    graphVersion: graph.version,
    node,
    status,
    pr: pr.number,
    enteredAt: iso(ctx.tick.now),
  })
  await setLabels(ctx, slug, issue, move(pr.labels, decl.queue))
}

/** Open, and from `from` to `to` or carrying a release marker. @param {Release} r @param {PromotionPr} pr */
const isPromotion = (r, pr) =>
  (pr.head === r.from && pr.base === r.to) || Boolean(pr.stateComment?.marker.graph.startsWith('release-'))

/** The promotion PR's body: what `to` gets. @param {Release} r */
export function promotionBody(r) {
  const lines = [
    `Promotes \`${r.from}\` → \`${r.to}\`: ${r.aheadBy} commit${r.aheadBy === 1 ? '' : 's'} ahead.`,
    '',
    r.merged.length ? `Merged into \`${r.from}\` since \`${r.to}\`:` : `No merged PRs found in the commits ahead.`,
    ...r.merged.map((p) => `- #${p.number} ${p.title}`),
    '',
    '_Opened by cambium (release-prepare). Approve it and cambium merges it (release-promote); ' +
      'an unmerged promotion PR is closed after 24 h._',
  ]
  return lines.join('\n')
}

// ---- release-prepare

const Empty = z.object({})
const Closed = z.object({ closed: z.array(z.number().int()) })

const cleanup = declare(
  defineNode({
    name: 'cleanup',
    input: Empty,
    output: Closed,
    /** Close every open promotion PR older than 24 h, with a comment. @param {{}} _ @param {ReleaseCtx} ctx */
    run: async (_, ctx) => {
      const { slug, release: r } = ctx.subject
      /** @type {number[]} */
      const closed = []
      for (const pr of r.prs) {
        if (pr.state !== 'OPEN' || !isPromotion(r, pr)) continue
        if (ctx.tick.now - Date.parse(pr.createdAt) <= DAY) continue
        const age = Math.floor((ctx.tick.now - Date.parse(pr.createdAt)) / (60 * 60 * 1000))
        const reason = `not merged within 24 h (opened ${age} h ago); a fresh promotion PR replaces it`
        if (pr.stateComment) {
          const m = pr.stateComment.marker
          await land(
            ctx,
            pr,
            releasePrepare,
            'cleanup',
            withHistory(m, { at: iso(ctx.tick.now), attempt: m.attempt, outcome: 'stale-closed', reason }),
            { status: 'done' },
          )
        } else if (pr.labels.includes(Q.promote))
          await setLabels(ctx, slug, /** @type {any} */ (pr), move(pr.labels, null))
        await ctx.github.closePull(slug, pr.number, `Closed by cambium: ${reason}.`)
        pr.state = 'CLOSED'
        closed.push(pr.number)
        ctx.log('info', `release: closed stale promotion PR #${pr.number}`, where(ctx, pr.number))
      }
      return { closed }
    },
  }),
  { queue: null, about: 'Closes every open promotion PR older than 24 h, with a comment.' },
)

const prepare = declare(
  defineNode({
    name: 'prepare',
    input: Closed,
    output: z.discriminatedUnion('to', [
      z.object({ to: z.literal('opened'), pr: z.number().int() }),
      z.object({ to: z.literal('updated'), pr: z.number().int() }),
      z.object({ to: z.literal('nothing'), reason: z.string() }),
    ]),
    /**
     * `from` ahead of `to`: open the promotion PR (or refresh the open one), label it `q:promote`, write the
     * marker. Nothing ahead: a log line.
     * @param {z.infer<typeof Closed>} _ @param {ReleaseCtx} ctx
     */
    run: async (_, ctx) => {
      const { slug, release: r } = ctx.subject
      if (!r.aheadBy) {
        const reason =
          r.aheadBy === null
            ? `\`${r.to}\` not found; nothing to promote`
            : `\`${r.from}\` is not ahead of \`${r.to}\`; nothing to promote`
        ctx.log('info', `release: ${reason}`, { repo: slug })
        return { to: 'nothing', reason }
      }
      const title = `Promote ${r.from} → ${r.to}`
      const body = promotionBody(r)
      const at = iso(ctx.tick.now)
      const open = r.prs.find((p) => p.state === 'OPEN' && p.head === r.from && p.base === r.to)
      if (open) {
        await ctx.github.editPull(slug, open.number, { title, body })
        const m = markerOn(open, releasePrepare.name, 'prepare')
        const entry = { at, attempt: m.attempt, outcome: 'updated', pr: open.number }
        // Already in release-promote (approved, merging): keep its position, record the refresh.
        if (m.graph === releasePromote.name && m.status !== 'done') {
          await setMarker(ctx, slug, /** @type {any} */ (open), withHistory(m, entry))
          await setLabels(ctx, slug, /** @type {any} */ (open), move(open.labels, Q.promote))
        } else await land(ctx, open, releasePrepare, 'prepare', withHistory(m, entry), { status: 'done' })
        ctx.log('info', `release: refreshed promotion PR #${open.number}`, where(ctx, open.number))
        return { to: 'updated', pr: open.number }
      }
      const made = await ctx.github.openPull(slug, { head: r.from, base: r.to, title, body })
      /** @type {PromotionPr} */
      const pr = {
        number: made.number,
        url: made.url,
        title,
        state: 'OPEN',
        createdAt: at,
        head: r.from,
        base: r.to,
        headSha: null,
        labels: [],
        approved: false,
        autoMerge: false,
        stateComment: null,
      }
      r.prs.push(pr)
      const m = markerOn(pr, releasePrepare.name, 'prepare')
      await land(
        ctx,
        pr,
        releasePrepare,
        'prepare',
        withHistory(m, { at, attempt: m.attempt, outcome: 'opened', pr: pr.number }),
        { status: 'done' },
      )
      ctx.log('info', `release: opened promotion PR #${pr.number} (${r.from} → ${r.to})`, where(ctx, pr.number))
      return { to: 'opened', pr: pr.number }
    },
  }),
  // The PR it opens waits in `q:promote`, release-promote's queue.
  {
    queue: Q.promote,
    about: 'When from is ahead of to, opens the promotion PR (or refreshes the open one) and labels it q:promote.',
  },
)

/** Bump `version` when a node is removed or renamed. */
export const releasePrepare = defineGraph({
  name: 'release-prepare',
  about: 'Once a day, opens or refreshes the promotion PR from the integration branch to the release branch.',
  version: 1,
  entry: { node: 'cleanup', input: () => ({}) },
  nodes: [cleanup, prepare],
  edges: [
    ['cleanup', 'prepare'],
    ['prepare', END],
  ],
})

// ---- release-promote

const PrIn = z.object({ pr: z.number().int() })

const armed = (/** @type {{ to: string }} */ o) => o.to === 'armed'
const merged = (/** @type {{ to: string }} */ o) => o.to === 'merged'

const merge = declare(
  defineNode({
    name: 'merge',
    input: PrIn,
    output: z.discriminatedUnion('to', [
      z.object({ to: z.literal('armed'), pr: z.number().int() }),
      z.object({ to: z.literal('refused'), reason: z.string() }),
    ]),
    /**
     * The PR is approved: merge it through `graft pr merge --auto`. A refusal stays here, recorded with the head
     * it was refused on; the gate does not retry that head.
     * @param {z.infer<typeof PrIn>} input @param {ReleaseCtx} ctx
     */
    run: async (input, ctx) => {
      const pr = prOf(ctx)
      try {
        await ctx.github.mergePull(ctx.subject.slug, input.pr)
      } catch (err) {
        const reason = `merge refused: ${/** @type {Error} */ (err)?.message ?? err}`
        const m = markerOn(pr, releasePromote.name, 'merge')
        await land(ctx, pr, releasePromote, 'merge', {
          ...withHistory(m, { at: iso(ctx.tick.now), attempt: m.attempt, outcome: 'merge-refused', reason }),
          lastFailure: reason,
          failedSha: pr.headSha,
          input: { pr: input.pr },
        })
        ctx.log('warn', `release: ${reason.split('\n')[0]}`, where(ctx, input.pr))
        return { to: 'refused', reason }
      }
      return { to: 'armed', pr: input.pr }
    },
  }),
  {
    queue: Q.promote,
    about: 'The promotion PR is approved: merges it through graft pr merge --auto. A refused head is not retried.',
  },
)

const merging = declare(
  defineWait({
    name: 'merging',
    input: PrIn,
    output: z.object({ to: z.enum(['merged', 'closed']), pr: z.number().int() }),
    /** Merged or closed unmerged; open: hold (no timeout). @param {z.infer<typeof PrIn>} input @param {ReleaseCtx} ctx */
    poll: async (input, ctx) => {
      const { state } = prOf(ctx)
      if (state === 'MERGED') return { ready: true, output: { to: 'merged', pr: input.pr } }
      if (state === 'CLOSED') return { ready: true, output: { to: 'closed', pr: input.pr } }
      return { ready: false }
    },
  }),
  {
    queue: Q.promote,
    about: 'Holds while the promotion PR is open; moves on once it merges or closes unmerged.',
    /** @param {{ pr: number }} input @param {ReleaseCtx} ctx */
    enter: async (input, ctx) => {
      const pr = prOf(ctx)
      const m = markerOn(pr, releasePromote.name, 'merging')
      await land(ctx, pr, releasePromote, 'merging', {
        ...withHistory(m, { at: iso(ctx.tick.now), attempt: m.attempt, outcome: 'merge-armed', pr: input.pr }),
        lastFailure: null,
        input: { pr: input.pr },
      })
      ctx.log('info', `release: merging promotion PR #${input.pr}`, where(ctx, input.pr))
    },
  },
)

/** @param {'promoted' | 'abandoned'} name @param {string} outcome @param {string} said */
const exit = (name, outcome, said) =>
  declare(
    defineNode({
      name,
      input: PrIn,
      output: Empty,
      /** @param {z.infer<typeof PrIn>} input @param {ReleaseCtx} ctx */
      run: async (input, ctx) => {
        const pr = prOf(ctx)
        const m = markerOn(pr, releasePromote.name, name)
        await land(
          ctx,
          pr,
          releasePromote,
          name,
          { ...withHistory(m, { at: iso(ctx.tick.now), attempt: m.attempt, outcome, pr: input.pr }), input: null },
          { status: 'done' },
        )
        ctx.log('info', `release: promotion PR #${input.pr} ${said}`, where(ctx, input.pr))
        return {}
      },
    }),
    { queue: null, about: `The promotion PR ${said}.` },
  )

/** Bump `version` when a node is removed or renamed. */
export const releasePromote = defineGraph({
  name: 'release-promote',
  about: 'Merges an approved q:promote promotion PR and closes it out.',
  version: 1,
  entry: { queue: Q.promote, node: 'merge' },
  nodes: [
    merge,
    merging,
    exit('promoted', 'merged', 'merged'),
    exit('abandoned', 'closed-unmerged', 'closed without merging'),
  ],
  edges: [
    ['merge', 'merging', armed],
    ['merge', END],
    ['merging', 'promoted', merged],
    ['merging', 'abandoned'],
    ['promoted', END],
    ['abandoned', END],
  ],
})

/** `q:promote` belongs to release-promote. */
export const RELEASE_QUEUES = {
  [Q.promote]: {
    graph: releasePromote.name,
    entryNode: releasePromote.entry.node,
    nodes: releasePromote.nodes.map((n) => n.name),
  },
}

// ---- Driving them (the tick's Release step)

/**
 * Advance `graph` from `at`, one transition at a time, writing a wait's `enter` when an edge lands on it. Stops
 * at END, at a wait that is not ready, or on entering a wait (polled next tick). A node error is rethrown.
 *
 * @param {import('../graph/define.mjs').Graph} graph @param {ReleaseCtx} ctx
 * @param {{ node: string, input: unknown }} at
 * @returns {Promise<import('../graph/advance.mjs').Transition[]>}
 */
async function drive(graph, ctx, at) {
  const { pr } = ctx.subject
  // A promote turn is traced on its PR (the marker's trace); a prepare run is a root of its own, which the PR it
  // opens or updates takes into its marker when that has none.
  const traced = turnTracer(ctx.telemetry, ctx.subject, {
    graph: graph.name,
    graphVersion: graph.version,
    repo: ctx.subject.slug,
    issue: pr?.number,
    ...markerTrace(pr?.stateComment?.marker),
  })
  /** @type {import('../graph/advance.mjs').Transition[]} */
  const transitions = []
  let pos = at
  for (;;) {
    const r = await advance(graph, pos, ctx, { maxTransitions: 1, instrument: traced.instrument })
    if (r.error) throw r.error.cause instanceof Error ? r.error.cause : r.error
    traced.sync()
    transitions.push(...r.transitions)
    const t = r.transitions[0]
    const next = /** @type {(import('../graph/define.mjs').GraphNode & Declared) | undefined} */ (
      graph.nodes.find((n) => n.name === r.node)
    )
    if (t && t.to !== END) await next?.enter?.(t.next, ctx)
    if (r.reason !== 'limit' || next?.kind === 'wait') return transitions
    pos = { node: r.node, input: r.input }
  }
}

/**
 * Where a `q:promote` PR's turn starts, or null for none. Merged or closed: `merging`, which exits. Open: the
 * marker's `merging`, else the entry once the PR is approved, unless a merge was already refused on this head.
 * @param {PromotionPr} pr @returns {{ node: string, input: { pr: number } } | null}
 */
export function promoteStart(pr) {
  if (!pr.labels.includes(Q.promote)) return null
  const marker = pr.stateComment?.marker ?? null
  const input = { pr: pr.number }
  if (pr.state !== 'OPEN') return { node: 'merging', input }
  const pos = effectivePosition(pr.labels, marker, RELEASE_QUEUES)
  if (pos?.node === 'merging' && !pos.reset) return { node: 'merging', input }
  if (!pr.approved) return null
  const refusedHere = !pos?.reset && pos?.node === 'merge' && marker?.lastFailure && marker.failedSha === pr.headSha
  return refusedHere ? null : { node: releasePromote.entry.node, input }
}

/** The store key for a repo's last release-prepare run. @param {string} slug */
export const lastRunKey = (slug) => `release.lastRun:${slug}`

/**
 * The tick's Release step on `engine: "graph"`, per repo with `release` on (and `from` ≠ `to`): release-prepare
 * when it is due, then a release-promote turn for each `q:promote` PR. One repo's failure is logged; the rest
 * still run.
 *
 * @param {import('../tick.mjs').Deps} deps @param {import('../tick.mjs').Ctx} tick
 */
export async function releaseGraphs(deps, tick) {
  for (const repo of deps.config.repos) {
    const { enabled, time, from, to } = repo.release
    const release = tick.snaps.get(repo.slug)?.release
    if (!enabled || from === to || !release) continue
    /** @param {PromotionPr} [pr] @returns {ReleaseCtx} */
    const ctxFor = (pr) => ({ ...deps, tick, subject: { slug: repo.slug, repo, release, pr } })
    try {
      const last = deps.store.get(lastRunKey(repo.slug))
      if (releaseDue(tick.now, last === null ? null : Number(last), time)) {
        deps.store.set(lastRunKey(repo.slug), String(tick.now))
        await drive(releasePrepare, ctxFor(), { node: releasePrepare.entry.node, input: {} })
      }
    } catch (err) {
      deps.log('error', `release-prepare: ${/** @type {Error} */ (err)?.message ?? err}`, { repo: repo.slug })
    }
    for (const pr of [...release.prs]) {
      const at = promoteStart(pr)
      if (!at) continue
      try {
        await drive(releasePromote, ctxFor(pr), at)
      } catch (err) {
        deps.log('error', `release-promote: ${/** @type {Error} */ (err)?.message ?? err}`, {
          repo: repo.slug,
          issue: pr.number,
        })
      }
    }
  }
}

// ---- `cambium run release-prepare|release-promote --repo <slug> [--issue <pr>]`

/** @param {import('../graph/advance.mjs').Transition[]} ts */
const path = (ts) => ts.map((t) => (t.to === END ? 'end' : String(t.to))).join(' → ')

/**
 * One release graph in the foreground for one repo, whatever the clock: `release-prepare` runs once (and counts
 * as the day's run); `release-promote` takes a turn for each `q:promote` PR (or only PR `pr`) that is ready, and
 * reports the rest.
 *
 * @param {import('../tick.mjs').Deps} deps @param {import('../tick.mjs').Ctx} tick a fresh tick context
 * @param {{ graph: string, slug: string, pr?: number, out: (line: string) => void }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function runRelease(deps, tick, { graph, slug, pr: only, out }) {
  const repo = deps.config.repos.find((r) => r.slug === slug)
  if (!repo) return { ok: false, error: `${slug} is not in the config` }
  const { from, to } = repo.release
  if (from === to) return { ok: false, error: `${slug}: release.from = release.to (\`${from}\`); nothing to promote` }
  const snap = await deps.github.read(slug)
  tick.snaps.set(slug, snap)
  const release = snap.release
  if (!release) return { ok: false, error: `${slug}: no release state in the snapshot` }
  /** @param {PromotionPr} [pr] @returns {ReleaseCtx} */
  const ctxFor = (pr) => ({ ...deps, tick, subject: { slug, repo, release, pr } })
  if (graph === releasePrepare.name) {
    deps.store.set(lastRunKey(slug), String(tick.now))
    const ts = await drive(releasePrepare, ctxFor(), { node: releasePrepare.entry.node, input: {} })
    out(`${slug} release-prepare: ${path(ts)}`)
    return { ok: true }
  }
  const prs = release.prs.filter((p) => only === undefined || p.number === only)
  if (only !== undefined && !prs.length) return { ok: false, error: `${slug}: #${only} is not a promotion PR` }
  if (!prs.length) out(`${slug} release-promote: no promotion PR`)
  for (const pr of prs) {
    const at = promoteStart(pr)
    if (!at) {
      const why = !pr.labels.includes(Q.promote)
        ? `no ${Q.promote}`
        : !pr.approved
          ? 'not approved'
          : 'merge refused on this head'
      out(`PR #${pr.number}: not ready (${why}, ${pr.state.toLowerCase()})`)
      continue
    }
    const ts = await drive(releasePromote, ctxFor(pr), at)
    out(`PR #${pr.number}: ${path(ts) || at.node}`)
  }
  return { ok: true }
}
