// @ts-check
/**
 * The rescue graph: one stuck item (phases/rescue.mjs `findStuck`) is diagnosed by a one-shot, read-only `claude -p`
 * worker whose final message carries a typed verdict ({@link RescueResult}): how the item got stuck, the actions that
 * unstick it, and the root causes worth a ticket. cambium checks the verdict, carries out the actions, files or
 * re-notes each root-cause ticket in `q:intake` (labelled `rescue`, so triage takes it from there), and documents it
 * all in a comment on the item. A missing or invalid verdict, or an item rescued `rescue.maxRescues` times this week,
 * goes to `q:human` with `why:rescue`.
 *
 * The item is not claimed while it is diagnosed: its labels are the evidence. The rescue worker's row (phase
 * `rescue`) keeps Schedule and Sweep off it meanwhile, and the verdict is acted on only while the item is still
 * stuck.
 */
import { z } from 'zod'
import { advance, defineGraph, defineNode, defineWait, END } from '../graph/index.mjs'
import { withAskLabels } from '../ask.mjs'
import { iso, key, markerOf, setLabels, setMarker } from '../issue-state.mjs'
import { move, Q, RESCUE_LABEL, WHY } from '../labels.mjs'
import { newMarker, withHistory } from '../marker.mjs'
import {
  causeBody,
  causeMarker,
  checkPlan,
  describe,
  readRescue,
  recordRescue,
  recordSymptoms,
  RescueResult,
  rescueReport,
  rescuePrompt,
  rescuesOf,
  seenAgain,
} from '../phases/rescue.mjs'
import { traceWorker } from '../tracing.mjs'
import { recordCost } from '../cost.mjs'
import { stopOverdue } from '../workers.mjs'
import { dispatch } from './dispatch.mjs'
import { issueOf, task } from './task.mjs'

/**
 * @typedef {import('../github.mjs').Issue} Issue
 * @typedef {import('../marker.mjs').Marker} Marker
 * @typedef {import('../phases/rescue.mjs').Stuck} Stuck
 * @typedef {import('../phases/rescue.mjs').Rescue} Rescue
 * @typedef {import('../phases/rescue.mjs').Action} Action
 * @typedef {import('./task.mjs').Subject & { stuck?: Stuck | null }} RescueSubject
 *   `stuck`: the item as `findStuck` sees it now; null once it is no longer stuck.
 * @typedef {import('./task.mjs').TaskCtx & { subject: RescueSubject }} RescueCtx
 */

/** The pseudo-branch that names an item's rescue checkout; never created. @param {number} n */
export const rescueBranch = (n) => `cambium/rescue-${n}`

/** Where root-cause tickets may go: the item's repo, then `rescue.causeRepo`. @param {RescueCtx} ctx */
export const causeRepos = (ctx) => [
  ...new Set([ctx.subject.slug, ...(ctx.config.rescue.causeRepo ? [ctx.config.rescue.causeRepo] : [])]),
]

/** @param {RescueCtx} ctx */
function stuckOf(ctx) {
  const { stuck } = ctx.subject
  if (!stuck) throw new Error(`${ctx.subject.slug}#${ctx.subject.number} is not stuck`)
  return stuck
}

/** @param {Stuck} stuck */
const symptomsLine = (stuck) => stuck.symptoms.map((s) => s.code).join(', ')

/** @param {unknown} err */
const errText = (err) => /** @type {Error} */ (err)?.message ?? String(err)

/** A marker as cambium writes it now: no stage-tick `stage`. @param {Marker} m */
const graphMarker = (m) => /** @type {Marker} */ (Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'stage')))

/**
 * The marker, then the labels; the issue counts as moved this tick.
 * @param {RescueCtx} ctx @param {Issue} issue @param {Marker} marker @param {{ add: string[], remove: string[] }} labels
 */
async function place(ctx, issue, marker, labels) {
  await setMarker(ctx, ctx.subject.slug, issue, marker)
  await setLabels(ctx, ctx.subject.slug, issue, labels)
  ctx.tick.touched.add(key(ctx.subject.slug, issue.number))
}

/** The history entry a rescue move leaves. @param {RescueCtx} ctx @param {Marker} m @param {string} reason */
const rescued = (ctx, m, reason) =>
  withHistory(m, { at: iso(ctx.tick.now), attempt: m.attempt, outcome: 'rescued', reason })

/**
 * Into the Human Queue with `why:rescue`, resting at this graph's `to-human`; an `ask` adds its `ask:*` labels and is
 * rendered in the state comment.
 * @param {RescueCtx} ctx @param {Issue} issue @param {string} reason @param {string} outcome
 * @param {import('../ask.mjs').AskT} [ask]
 */
async function handToHuman(ctx, issue, reason, outcome, ask) {
  const m = markerOf(issue)
  const where = { repo: ctx.subject.slug, issue: issue.number }
  await withAskLabels(ctx, where, ask, (labels) =>
    place(
      ctx,
      issue,
      {
        ...graphMarker(withHistory(m, { at: iso(ctx.tick.now), attempt: m.attempt, outcome, reason })),
        graph: rescue.name,
        graphVersion: rescue.version,
        phase: 'rescue',
        node: 'to-human',
        status: 'waiting',
        enteredAt: iso(ctx.tick.now),
        lastFailure: reason,
        ask: ask ?? null,
        host: null,
        start: null,
        input: null,
      },
      move(issue.labels, Q.human, { extra: [WHY.rescue, ...labels] }),
    ),
  )
}

/**
 * Back to a queue at its graph's entry, attempt 1, the history kept.
 * @param {RescueCtx} ctx @param {Issue} issue @param {'task' | 'intake'} queue @param {string} reason
 */
async function requeue(ctx, issue, queue, reason) {
  const m = markerOf(issue)
  const g = queue === 'task' ? task : dispatch
  await place(
    ctx,
    issue,
    newMarker({
      graph: g.name,
      graphVersion: g.version,
      node: g.entry.node,
      phase: queue === 'task' ? 'task' : 'dispatch',
      enteredAt: iso(ctx.tick.now),
      traceparent: m.traceparent,
      history: rescued(ctx, m, reason).history,
    }),
    move(issue.labels, queue === 'task' ? Q.task : Q.intake),
  )
}

/**
 * One action of a checked verdict.
 * @param {RescueCtx} ctx @param {Issue} issue @param {Action} a
 */
async function act(ctx, issue, a) {
  const { slug, snap } = ctx.subject
  switch (a.do) {
    case 'clear-labels':
      return setLabels(ctx, slug, issue, { add: [], remove: a.labels.filter((l) => issue.labels.includes(l)) })
    case 'close-pr': {
      await ctx.github.closePull(slug, a.pr, `${a.reason}\n\nClosed by cambium's rescue (#${issue.number}).`)
      const pr = snap?.prs.find((p) => p.number === a.pr)
      if (pr) pr.state = 'CLOSED'
      return
    }
    case 'requeue':
      return requeue(ctx, issue, a.queue, a.reason)
    case 'to-human':
      return handToHuman(ctx, issue, a.reason, 'rescued', a.ask)
    case 'close-issue': {
      const m = markerOf(issue)
      await place(
        ctx,
        issue,
        { ...graphMarker(rescued(ctx, m, a.reason)), status: 'done', host: null, input: null },
        move(issue.labels, null),
      )
      await ctx.github.close(slug, issue.number, `${a.reason}\n\nClosed by cambium's rescue.`, { reason: a.as })
      issue.state = 'CLOSED'
      return
    }
    case 'adopt-pr': {
      const pr = snap?.prs.find((p) => p.number === a.pr)
      if (!pr) throw new Error(`PR #${a.pr} is not in the snapshot`)
      // The task graph's `submit`, as a worker's publish or the reaper's adoption: the PR graph takes it next tick.
      const r = await advance(task, { node: 'submit', input: { pr: pr.number, branch: pr.branch } }, ctx, {
        maxTransitions: 1,
      })
      if (r.error) throw r.error.cause instanceof Error ? r.error.cause : r.error
      return
    }
  }
}

// ---- Schemas and edge predicates

const Empty = z.object({})
const failure = { reason: z.string(), outcome: z.string() }
const Verdict = z.object({ result: RescueResult, log: z.string() })
const Filed = z.object({ slug: z.string(), number: z.number().int(), title: z.string(), again: z.boolean() })

const started = (/** @type {{ to: string }} */ o) => o.to === 'running'
const budgetSpent = (/** @type {{ to: string }} */ o) => o.to === 'human'
const resolved = (/** @type {{ exit: string }} */ o) => o.exit === 'resolved' || o.exit === 'lost'
const diagnosed = (/** @type {{ exit: string }} */ o) => o.exit === 'diagnosed'

// ---- Nodes

const startRescue = defineNode({
  name: 'start-rescue',
  input: Empty,
  output: z.discriminatedUnion('to', [
    z.object({ to: z.literal('running'), pid: z.number().int(), attempt: z.number().int() }),
    z.object({ to: z.literal('human'), ...failure }),
    z.object({ to: z.literal('failed'), reason: z.string() }),
  ]),
  /**
   * Over budget (`rescue.maxRescues` this week): to a human without another diagnosis. Else count the rescue and
   * start the rescue worker in a read-only checkout. A start that fails ends here; the next sweep tries again after
   * `rescue.cooldownHours`, and counts it.
   * @param {{}} _ @param {RescueCtx} ctx
   */
  run: async (_, ctx) => {
    const { config, spawner, store } = ctx
    const { slug, number } = ctx.subject
    const issue = issueOf(ctx)
    const stuck = stuckOf(ctx)
    const repo = config.repos.find((r) => r.slug === slug)
    if (!repo) throw new Error(`${slug} is not in the config`)
    const previous = rescuesOf(store, slug, number, ctx.tick.now).length
    const { maxRescues } = config.rescue
    if (previous >= maxRescues)
      return {
        to: 'human',
        reason: `rescued ${previous} time${previous === 1 ? '' : 's'} this week and still stuck (${symptomsLine(stuck)})`,
        outcome: 'budget',
      }
    recordRescue(store, slug, number, ctx.tick.now)
    recordSymptoms(store, stuck)
    const caps = config.phases.rescue
    const pr = ctx.subject.pr ?? (stuck.pr ? (ctx.subject.snap?.prs.find((p) => p.number === stuck.pr) ?? null) : null)
    /** @type {import('../workers.mjs').Started} */
    let s
    try {
      const convention = spawner.convention(repo)
      s = await spawner.start({
        repo,
        convention,
        issue: number,
        attempt: previous + 1,
        branch: rescueBranch(number),
        phase: 'rescue',
        maxTurns: caps.maxTurns,
        readOnly: true,
        foreground: ctx.subject.foreground ?? false,
        env: ctx.traceparent ? { TRACEPARENT: ctx.traceparent } : undefined,
        buildPrompt: (agentsMd) =>
          rescuePrompt({
            repo: slug,
            baseBranch: repo.baseBranch,
            stuck,
            issue,
            pr,
            agentsMd,
            logs: config.paths.logs,
            repos: causeRepos(ctx),
            previous,
          }),
      })
    } catch (err) {
      ctx.log('warn', `rescue: could not start a worker: ${errText(err)}`, { repo: slug, issue: number })
      return { to: 'failed', reason: errText(err) }
    }
    store.addWorker({
      repo: slug,
      issue: number,
      phase: 'rescue',
      pid: s.pid,
      worktree: s.worktree,
      branch: rescueBranch(number),
      attempt: previous + 1,
      startedAt: ctx.tick.now,
      host: config.host,
      stdout: s.stdout,
      stderr: s.stderr,
      traceparent: ctx.traceparent ?? null,
    })
    ctx.log('info', `rescue: started worker pid ${s.pid} (${symptomsLine(stuck)})`, { repo: slug, issue: number })
    ctx.subject.started = { ...s, attempt: previous + 1 }
    return { to: 'running', pid: s.pid, attempt: previous + 1 }
  },
})

const diagnosing = defineWait({
  name: 'diagnosing',
  input: z.object({ attempt: z.number().int() }),
  output: z.discriminatedUnion('exit', [
    z.object({ exit: z.literal('diagnosed'), ...Verdict.shape }),
    z.object({ exit: z.literal('invalid'), ...failure }),
    z.object({ exit: z.literal('resolved') }),
    z.object({ exit: z.literal('lost') }),
  ]),
  /**
   * Alive and under the wall-clock cap: hold. Over it: kill. Gone: unstuck meanwhile (someone or something moved it)
   * ends the graph; otherwise the verdict, read from its stdout log and checked against the item (phases/rescue.mjs
   * `checkPlan`). A missing, invalid or unworkable one is `invalid`, with the error.
   * @param {unknown} _ @param {RescueCtx} ctx
   */
  poll: async (_, ctx) => {
    const { config, store, procs, spawner } = ctx
    const { slug, number, snap, issue, reaped, stuck } = ctx.subject
    const w = store.worker(slug, number)
    if (w?.phase !== 'rescue') return { ready: true, output: { exit: 'lost' } }
    const caps = config.phases.rescue
    if (
      !reaped?.has(w.pid) &&
      stopOverdue({ procs, store, log: ctx.log }, w, caps.wallClockMinutes, ctx.tick.now) !== 'gone'
    )
      return { ready: false }
    if (!snap || !issue) return { ready: false }
    traceWorker(ctx, w)
    await recordCost(ctx, issue, w, ctx.tick.now)
    if (!stuck) {
      ctx.log('info', 'rescue: no longer stuck; verdict not applied', { repo: slug, issue: number })
      return { ready: true, output: { exit: 'resolved' } }
    }
    const read = w.killedReason ? { ok: false, error: w.killedReason } : readRescue(spawner.readLog(w.stdout))
    if (!read.ok || !('result' in read)) {
      const error = 'error' in read ? read.error : 'no verdict'
      const tail = error.startsWith('invalid') ? '' : spawner.tail(w.stderr, 15)
      return {
        ready: true,
        output: {
          exit: 'invalid',
          reason: `${error}${tail ? `\n--- stderr (last lines, ${w.stderr})\n${tail}` : ''}`,
          outcome: w.killedReason ? 'killed' : 'invalid',
        },
      }
    }
    const problem = checkPlan(read.result, { issue, snap, repos: causeRepos(ctx) })
    if (problem)
      return {
        ready: true,
        output: { exit: 'invalid', reason: `unworkable rescue verdict: ${problem}`, outcome: 'invalid' },
      }
    return { ready: true, output: { exit: 'diagnosed', result: read.result, log: w.stdout } }
  },
})

const Unstuck = z.object({ ...Verdict.shape, done: z.array(z.string()) })
const unstick = defineNode({
  name: 'unstick',
  input: Verdict,
  output: Unstuck,
  /**
   * The verdict's actions, in order. A failed write throws: the worker row stays, so the next tick reads the same
   * verdict and tries again.
   * @param {z.infer<typeof Verdict>} v @param {RescueCtx} ctx
   */
  run: async (v, ctx) => {
    const issue = issueOf(ctx)
    /** @type {string[]} */
    const done = []
    for (const a of v.result.actions) {
      await act(ctx, issue, a)
      done.push(describe(a))
    }
    if (done.length)
      ctx.log('info', `rescue: ${v.result.actions.map((a) => a.do).join(', ')}`, {
        repo: ctx.subject.slug,
        issue: issue.number,
      })
    return { ...v, done }
  },
})

const Causes = z.object({ ...Unstuck.shape, filed: z.array(Filed) })
const fileCauses = defineNode({
  name: 'file-causes',
  input: Unstuck,
  output: Causes,
  /**
   * Each root cause: when an open issue in the target repo already carries its fingerprint, a comment there notes the
   * recurrence; otherwise a new ticket in `q:intake`, labelled `rescue`. A repo cambium does not read (only
   * `rescue.causeRepo` can be one) is de-duplicated by what this host filed there.
   * @param {z.infer<typeof Unstuck>} u @param {RescueCtx} ctx
   */
  run: async (u, ctx) => {
    const { slug, number } = ctx.subject
    const from = { slug, number, how: u.result.how }
    /** @type {z.infer<typeof Filed>[]} */
    const filed = []
    for (const c of u.result.rootCauses) {
      const target = c.repo ?? slug
      const snap = ctx.tick.snaps.get(target)
      const kvKey = `rescue-cause:${target}:${c.fingerprint}`
      const known = snap
        ? [...snap.issues.values()].find((i) => i.state === 'OPEN' && i.body.includes(causeMarker(c.fingerprint)))
            ?.number
        : Number(ctx.store.get(kvKey)) || undefined
      if (known) {
        await ctx.github.comment(target, known, seenAgain(from))
        filed.push({ slug: target, number: known, title: snap?.issues.get(known)?.title ?? c.title, again: true })
        continue
      }
      const body = causeBody(c, from)
      const labels = [Q.intake, RESCUE_LABEL]
      const made = await ctx.github.createIssue(target, { title: c.title, body, labels })
      ctx.store.set(kvKey, String(made.number))
      snap?.issues.set(made.number, {
        number: made.number,
        title: c.title,
        url: made.url,
        state: 'OPEN',
        createdAt: iso(ctx.tick.now),
        body,
        labels,
        stateComment: null,
        blockedBy: [],
      })
      ctx.log('info', `rescue: filed root cause ${target}#${made.number} (${c.fingerprint})`, {
        repo: slug,
        issue: number,
      })
      filed.push({ slug: target, number: made.number, title: c.title, again: false })
    }
    return { ...u, filed }
  },
})

const report = defineNode({
  name: 'report',
  input: Causes,
  output: Empty,
  /** The comment that documents the rescue: what was seen, how it got stuck, what was done, the root causes. @param {z.infer<typeof Causes>} c @param {RescueCtx} ctx */
  run: async (c, ctx) => {
    const { slug, number } = ctx.subject
    await ctx.github.comment(
      slug,
      number,
      rescueReport({ stuck: stuckOf(ctx), result: c.result, done: c.done, filed: c.filed }),
    )
    ctx.log('info', `rescue: ${c.result.stuck ? 'unstuck' : 'not stuck'}; ${c.filed.length} root cause(s)`, {
      repo: slug,
      issue: number,
    })
    return {}
  },
})

const HumanIn = z.object(failure)
const toHuman = defineNode({
  name: 'to-human',
  input: HumanIn,
  output: Empty,
  /** Into the Human Queue with `why:rescue`, and a comment saying what cambium saw and why it stopped. @param {z.infer<typeof HumanIn>} what @param {RescueCtx} ctx */
  run: async (what, ctx) => {
    const issue = issueOf(ctx)
    const stuck = stuckOf(ctx)
    // A closed issue is not queued again: the comment is enough for whoever looks.
    if (issue.state === 'OPEN') await handToHuman(ctx, issue, what.reason, what.outcome)
    await ctx.github.comment(
      ctx.subject.slug,
      issue.number,
      [
        '**Rescue: this issue is stuck, and needs a person.**',
        '',
        '**What cambium saw**',
        ...stuck.symptoms.map((s) => `- \`${s.code}\`: ${s.detail}`),
        '',
        '**Why rescue stopped**',
        '```',
        what.reason.replace(/```/g, "'''"),
        '```',
      ].join('\n'),
    )
    ctx.log('warn', `rescue → q:human (${WHY.rescue}): ${what.reason.split('\n')[0]}`, {
      repo: ctx.subject.slug,
      issue: issue.number,
    })
    return {}
  },
})

/** A node with its one-line description, which the heartbeat carries (graph/describe.mjs). @template N @param {N} node @param {string} text */
const about = (node, text) => Object.freeze({ ...node, about: text })

/** The rescue graph. Bump `version` when a node is removed or renamed. */
export const rescue = defineGraph({
  name: 'rescue',
  version: 1,
  about: 'Diagnoses a stuck item with a one-shot read-only worker, unsticks it and files its root causes in q:intake.',
  entry: { node: 'start-rescue', input: () => ({}) },
  nodes: [
    about(
      startRescue,
      'Starts the rescue worker in a read-only checkout; over the weekly budget, the item goes to a human.',
    ),
    about(diagnosing, 'Holds while the worker diagnoses the item; on exit, checks its verdict against the item.'),
    about(unstick, "Carries out the verdict's actions, in order."),
    about(
      fileCauses,
      'Files each root cause as a q:intake ticket labelled rescue, or notes a recurrence on the open one.',
    ),
    about(report, 'Comments on the item: what was seen, how it got stuck, what was done, the root causes.'),
    about(toHuman, 'Into q:human with why:rescue and what cambium saw.'),
  ],
  edges: [
    ['start-rescue', 'diagnosing', started, (o) => ({ attempt: o.attempt })],
    ['start-rescue', 'to-human', budgetSpent],
    ['start-rescue', END],
    ['diagnosing', END, resolved],
    ['diagnosing', 'unstick', diagnosed, (o) => ({ result: o.result, log: o.log })],
    ['diagnosing', 'to-human'],
    ['unstick', 'file-causes'],
    ['file-causes', 'report'],
    ['report', END],
    ['to-human', END],
  ],
})
