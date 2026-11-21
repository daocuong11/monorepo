// @ts-check
/**
 * The `rescue` graph (engine: "graph"): finding stuck items, a read-only rescue worker's verdict, and cambium carrying
 * it out: the item unstuck, root causes filed (or re-noted) as tickets, and a comment documenting it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { toMermaid, validateGraph } from '../src/graph/index.mjs'
import { rescue } from '../src/graphs/rescue.mjs'
import { causeMarker, checkPlan, findStuck, readRescue, RescueResult } from '../src/phases/rescue.mjs'
import { renderMarker, newMarker } from '../src/marker.mjs'
import { tick } from '../src/tick.mjs'
import { runIssue } from '../src/graph-engine.mjs'
import { harness, SLUG, T0 } from './fakes.mjs'

const MIN = 60_000
const HOUR = 60 * MIN
const old = new Date(T0 - 48 * HOUR).toISOString()

/** A stream-json stdout log whose final message ends in `verdict` as a fenced JSON block. @param {unknown} verdict */
const logWith = (verdict) =>
  [
    { type: 'system', subtype: 'init', session_id: 's1' },
    {
      type: 'result',
      subtype: 'success',
      result: `I read the timeline.\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`\n`,
      session_id: 's1',
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n')

/** A state comment with this marker. @param {Partial<import('../src/marker.mjs').Marker>} m */
const comment = (m) => ({ id: 77, body: renderMarker(newMarker({ node: 'start-worker', ...m })) })

/** @param {{ issues?: any[], prs?: any[], config?: any }} [o] */
function rig({ issues = [], prs = [], config = {} } = {}) {
  return harness({
    issues,
    prs,
    config: { engine: 'graph', phases: { task: { cap: 0 }, dispatch: { cap: 0 }, rescue: { cap: 1 } }, ...config },
  })
}

/**
 * Tick once to start the rescue worker for `n`, end it with `verdict` as its final message, and tick again.
 * @param {ReturnType<typeof harness>} h @param {number} n @param {unknown} verdict
 */
async function rescueWith(h, n, verdict) {
  await tick(h.deps)
  const w = h.deps.store.worker(SLUG, n)
  assert.ok(w, `a rescue worker is tracked for #${n}`)
  assert.equal(w.phase, 'rescue')
  h.spawner.logs.set(w.stdout, typeof verdict === 'string' ? verdict : logWith(verdict))
  h.procs.live.delete(w.pid)
  await tick(h.deps)
  return w
}

const comments = (/** @type {ReturnType<typeof harness>} */ h, /** @type {number} */ n) =>
  h.gh.calls.filter((c) => c.op === 'comment' && c.args[1] === n).map((c) => String(c.args[2]))

test('rescue graph: six nodes, one wait, valid', () => {
  assert.deepEqual(validateGraph(rescue), [])
  assert.deepEqual(
    rescue.nodes.map((n) => n.name),
    ['start-rescue', 'diagnosing', 'unstick', 'file-causes', 'report', 'to-human'],
  )
  assert.deepEqual(
    rescue.nodes.filter((n) => n.kind === 'wait').map((n) => n.name),
    ['diagnosing'],
  )
})

test('README shows the rescue graph exactly as toMermaid renders it', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(readme.includes(`\`\`\`mermaid\n${toMermaid(rescue)}\`\`\``), 'regenerate the README diagram')
})

// ---- findStuck

/** @param {Partial<import('../src/github.mjs').Issue>} i @returns {import('../src/github.mjs').Issue} */
const issue = (i) => ({
  number: 1,
  title: 't',
  url: '',
  state: 'OPEN',
  createdAt: old,
  body: '',
  labels: [],
  stateComment: null,
  blockedBy: [],
  ...i,
})

/** @param {Partial<import('../src/github.mjs').PullRequest>} p @returns {import('../src/github.mjs').PullRequest} */
const pull = (p) => ({
  number: 50,
  url: '',
  branch: 'agent/1-x',
  state: 'OPEN',
  headSha: 'abc',
  branchExists: true,
  inMergeQueue: false,
  autoMerge: false,
  checks: 'SUCCESS',
  failing: [],
  closes: [1],
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  createdAt: old,
  updatedAt: old,
  ...p,
})

/** @param {import('../src/github.mjs').Issue[]} issues @param {import('../src/github.mjs').PullRequest[]} [prs] @param {any} [o] */
const stuck = (issues, prs = [], o = {}) =>
  findStuck(
    { issues: new Map(issues.map((i) => [i.number, i])), prs },
    {
      slug: SLUG,
      now: T0,
      host: 'mac',
      running: true,
      staleHours: 12,
      graceMinutes: 30,
      free: { task: 1, dispatch: 1 },
      busy: () => false,
      ...o,
    },
  )

const codes = (/** @type {ReturnType<typeof findStuck>} */ s) => s.map((x) => [x.number, x.symptoms.map((y) => y.code)])

test('findStuck: labels that break the queue rules', () => {
  const s = stuck(
    [
      issue({ number: 1, labels: ['q:task', 'q:human'] }),
      issue({ number: 2, labels: ['running'] }),
      issue({ number: 3, labels: ['q:task', 'why:budget'] }),
      issue({ number: 4, labels: ['q:task', 'wait:deferred'] }),
      issue({ number: 5, state: 'CLOSED', labels: ['q:task', 'running'] }),
      issue({ number: 6, state: 'CLOSED', labels: ['q:promote'] }),
      issue({ number: 7, labels: ['q:human', 'why:budget'] }),
      issue({
        number: 8,
        labels: ['q:intake', 'wait:blocked'],
        blockedBy: [{ number: 1, state: 'OPEN', closedAt: null }],
      }),
    ],
    [],
    { free: { task: 0, dispatch: 0 } },
  )
  assert.deepEqual(codes(s), [
    [1, ['many-queues']],
    [2, ['running-unqueued']],
    [3, ['why-outside-human']],
    [4, ['wait-outside-intake']],
    [5, ['closed-labelled']],
  ])
})

test('findStuck: a fresh change is in its grace; a busy item or another host lease is left alone', () => {
  const fresh = new Date(T0 - 5 * MIN).toISOString()
  const other = newMarker({ node: 'worker-running', host: 'other-mac', enteredAt: old })
  const s = stuck(
    [
      issue({ number: 1, labels: ['q:task', 'q:human'], createdAt: fresh }),
      issue({ number: 2, labels: ['q:task', 'q:human'] }),
      issue({ number: 3, labels: ['running'], stateComment: { id: 1, marker: other } }),
    ],
    [],
    { busy: (/** @type {number} */ n) => n === 2 },
  )
  assert.deepEqual(codes(s), [])
})

test('findStuck: stranded by a closed PR, open after its PR merged', () => {
  const s = stuck(
    [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 })],
    [
      pull({ number: 60, closes: [2], state: 'MERGED' }),
      pull({ number: 61, closes: [3], updatedAt: new Date(T0 - HOUR).toISOString() }),
    ],
    { closed: [pull({ number: 59, closes: [1], state: 'CLOSED' })] },
  )
  assert.deepEqual(codes(s), [
    [1, ['stranded']],
    [2, ['merged-open']],
  ])
  assert.equal(s[0].pr, 59)
  assert.equal(s[1].pr, 60)
})

test('findStuck: waiting past staleHours only with a free slot, a green base, not parked', () => {
  const deferred = newMarker({
    graph: 'dispatch',
    node: 'deferred',
    deferUntil: new Date(T0 + HOUR).toISOString(),
    enteredAt: old,
  })
  const issues = [
    issue({ number: 1, labels: ['q:task'] }),
    issue({ number: 2, labels: ['q:intake'] }),
    issue({ number: 3, labels: ['q:intake'], stateComment: { id: 1, marker: deferred } }),
    issue({ number: 4, labels: ['q:task'], createdAt: new Date(T0 - HOUR).toISOString() }),
    issue({ number: 5, labels: ['q:human'] }),
  ]
  assert.deepEqual(codes(stuck(issues)), [
    [1, ['stale-task']],
    [2, ['stale-intake']],
  ])
  assert.deepEqual(codes(stuck(issues, [], { free: { task: 0, dispatch: 0 } })), [])
  assert.deepEqual(codes(stuck(issues, [], { running: false })), [])
  assert.deepEqual(codes(stuck(issues, [], { recheck: true, free: { task: 0, dispatch: 0 } })), [
    [1, ['stale-task']],
    [2, ['stale-intake']],
    [4, ['stale-task']],
  ])
})

test('findStuck: an agent PR untouched past staleHours, not the Human Queue’s, on its issue', () => {
  const s = stuck(
    [
      issue({ number: 1 }),
      issue({ number: 2, labels: ['q:human', 'why:budget'] }),
      issue({ number: 3 }),
      issue({ number: 4, labels: ['q:task'], createdAt: new Date(T0 - HOUR).toISOString() }),
    ],
    [
      pull({ number: 70, closes: [1], checks: 'PENDING' }),
      pull({ number: 71, closes: [2] }),
      pull({ number: 73, closes: [4], checks: 'FAILURE' }),
      pull({ number: 72, closes: [3], updatedAt: new Date(T0 - HOUR).toISOString() }),
    ],
  )
  assert.deepEqual(codes(s), [[1, ['pr-stale']]])
  assert.equal(s[0].pr, 70)
  assert.match(s[0].symptoms[0].detail, /PR #70 untouched for 48h: checks PENDING/)
})

// ---- The verdict

test('readRescue: a valid verdict, defaults filled; malformed ones say what is wrong', () => {
  const ok = readRescue(logWith({ stuck: true, how: 'A human added why:budget by hand.' }))
  assert.ok(ok.ok && 'result' in ok)
  assert.deepEqual(ok.result, { stuck: true, how: 'A human added why:budget by hand.', actions: [], rootCauses: [] })
  const bad = readRescue(
    logWith({ stuck: true, how: 'x', rootCauses: [{ title: 't', body: 'b', fingerprint: 'No Way' }] }),
  )
  assert.ok(!bad.ok && 'error' in bad)
  assert.match(bad.error, /rootCauses\.0\.fingerprint/)
  const none = readRescue('')
  assert.ok(!none.ok && 'error' in none && /no result event/.test(none.error))
})

test('checkPlan: one move, last; open agent PRs only; cambium labels only; allowed repos only', () => {
  const at = {
    issue: issue({ number: 1, labels: ['q:task', 'why:budget'] }),
    snap: { issues: new Map(), prs: [pull({ number: 50 }), pull({ number: 51, state: 'CLOSED' })] },
    repos: [SLUG, 'o/cambium'],
  }
  /** @param {any} r */
  const plan = (r) => checkPlan(RescueResult.parse({ stuck: true, how: 'h', ...r }), at)
  assert.equal(
    plan({
      actions: [
        { do: 'clear-labels', labels: ['why:budget'] },
        { do: 'adopt-pr', pr: 50 },
      ],
    }),
    null,
  )
  assert.match(
    String(
      plan({
        actions: [
          { do: 'requeue', queue: 'task', reason: 'r' },
          { do: 'to-human', reason: 'r' },
        ],
      }),
    ),
    /more than one move/,
  )
  assert.match(
    String(
      plan({
        actions: [
          { do: 'requeue', queue: 'task', reason: 'r' },
          { do: 'close-pr', pr: 50, reason: 'r' },
        ],
      }),
    ),
    /must be the last action/,
  )
  assert.match(String(plan({ actions: [{ do: 'close-pr', pr: 51, reason: 'r' }] })), /not an open agent PR/)
  assert.match(String(plan({ actions: [{ do: 'clear-labels', labels: ['bug'] }] })), /not cambium labels/)
  assert.match(
    String(plan({ rootCauses: [{ title: 't', body: 'b', fingerprint: 'abc', repo: 'x/y' }] })),
    /x\/y is not one of/,
  )
  assert.equal(plan({ rootCauses: [{ title: 't', body: 'b', fingerprint: 'abc', repo: 'o/cambium' }] }), null)
  assert.match(
    String(checkPlan(RescueResult.parse({ stuck: false, how: 'h', actions: [{ do: 'to-human', reason: 'r' }] }), at)),
    /not stuck/,
  )
})

// ---- The graph through the tick

test('a mislabelled issue: diagnosed read-only, labels fixed, root cause filed, the rescue documented', async () => {
  const h = rig({ issues: [{ number: 7, labels: ['q:task', 'why:budget'], comment: comment({ enteredAt: old }) }] })
  await tick(h.deps)
  const s = h.spawner.started[0]
  assert.equal(s.issue, 7)
  assert.equal(s.phase, 'rescue')
  assert.equal(s.readOnly, true)
  assert.equal(s.branch, 'cambium/rescue-7')
  for (const needle of [
    'GitHub issue #7 looks stuck',
    '`why-outside-human`',
    'timeline',
    'never ask one and wait',
    '"rootCauses"',
  ])
    assert.ok(s.prompt.includes(needle), `prompt mentions ${needle}`)
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:task', 'why:budget'], 'the item is not claimed while diagnosed')
  const w = /** @type {import('../src/store.mjs').Worker} */ (h.deps.store.worker(SLUG, 7))
  h.spawner.logs.set(
    w.stdout,
    logWith({
      stuck: true,
      how: '2026-11-16 09:00 a person added why:budget while it sat in q:task.',
      actions: [{ do: 'clear-labels', labels: ['why:budget'], reason: 'why:* belongs only with q:human' }],
      rootCauses: [
        {
          title: 'Guard why:* labels outside q:human',
          body: 'Strip them on Read.',
          fingerprint: 'why-outside-human-unguarded',
        },
      ],
    }),
  )
  h.procs.live.delete(w.pid)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels, ['q:task'])
  const made = h.gh.calls.find((c) => c.op === 'createIssue')
  assert.ok(made, 'a root-cause ticket')
  assert.equal(made.args[0], SLUG)
  assert.equal(made.args[1].title, 'Guard why:* labels outside q:human')
  assert.deepEqual(made.args[1].labels, ['q:intake', 'rescue'])
  assert.ok(made.args[1].body.includes(causeMarker('why-outside-human-unguarded')))
  assert.ok(made.args[1].body.includes(`unsticking ${SLUG}#7`))
  const [report] = comments(h, 7)
  assert.match(report, /Rescue: this issue was stuck/)
  assert.match(report, /a person added why:budget/)
  assert.match(report, /Removed `why:budget`/)
  assert.match(report, new RegExp(`${SLUG}#9000 Guard why`))
  assert.equal(h.deps.store.worker(SLUG, 7), null, 'the worker row is gone')
  assert.ok(h.spawner.cleaned.includes(w.worktree))
})

test('a root cause already open is noted again, not filed twice', async () => {
  const h = rig({
    issues: [
      { number: 7, labels: ['q:task', 'q:intake'] },
      { number: 20, labels: ['q:intake', 'rescue'], body: `Fix it.\n\n${causeMarker('two-queues')}` },
    ],
  })
  await rescueWith(h, 7, {
    stuck: true,
    how: 'Two queues.',
    actions: [{ do: 'requeue', queue: 'task', reason: 'the work is clear' }],
    rootCauses: [{ title: 'Two queues', body: 'b', fingerprint: 'two-queues' }],
  })
  assert.equal(h.gh.calls.filter((c) => c.op === 'createIssue').length, 0)
  assert.match(comments(h, 20)[0], /struck again, on o\/r#7/)
  assert.deepEqual(h.gh.issue(7).labels, ['q:task'])
  const m = h.gh.marker(7)
  assert.equal(m?.graph, 'task')
  assert.equal(m?.node, 'start-worker')
  assert.equal(m?.attempt, 1)
  assert.equal(m?.history.at(-1)?.outcome, 'rescued')
})

test('an issue stranded by a closed PR is requeued', async () => {
  const h = rig({
    issues: [{ number: 8, labels: [], comment: comment({ node: 'submit', status: 'done', pr: 30, enteredAt: old }) }],
    prs: [{ number: 30, closes: [8], state: 'CLOSED', updatedAt: old }],
  })
  await tick(h.deps)
  const s = h.spawner.started[0]
  assert.equal(s?.issue, 8)
  assert.match(s.prompt, /`stranded`: open in no queue with no open agent PR: its PR #30 closed unmerged/)
  assert.match(s.prompt, /--- PR #30/)
  const w = /** @type {import('../src/store.mjs').Worker} */ (h.deps.store.worker(SLUG, 8))
  h.spawner.logs.set(
    w.stdout,
    logWith({
      stuck: true,
      how: 'PR #30 was closed by hand.',
      actions: [{ do: 'requeue', queue: 'task', reason: 'r' }],
    }),
  )
  h.procs.live.delete(w.pid)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(8).labels, ['q:task'])
  assert.match(comments(h, 8)[0], /Requeued to `q:task` at attempt 1/)
})

test('a tracked PR whose checks never ran: closed, and the issue requeued', async () => {
  // Untracked PRs are the reaper's (upkeep.mjs); this one its issue's marker tracks, but its checks never report.
  const h = rig({
    issues: [{ number: 9, labels: [], comment: comment({ node: 'submit', status: 'done', pr: 40, enteredAt: old }) }],
    prs: [{ number: 40, closes: [9], checks: 'PENDING', updatedAt: old }],
  })
  await rescueWith(h, 9, {
    stuck: true,
    how: 'The required check never reported on PR #40.',
    actions: [
      { do: 'close-pr', pr: 40, reason: 'its checks never ran' },
      { do: 'requeue', queue: 'task', reason: 'a fresh PR gets fresh checks' },
    ],
  })
  assert.equal(h.gh.pr(40).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(9).labels, ['q:task'])
  assert.match(comments(h, 9)[0], /`pr-stale`: PR #40 untouched for 48h: checks PENDING/)
})

test('an invalid verdict hands the item to a human with why:rescue', async () => {
  const h = rig({ issues: [{ number: 7, labels: ['q:task', 'wait:deferred'] }] })
  await rescueWith(h, 7, { stuck: true, how: 'x', actions: [{ do: 'close-pr', pr: 99, reason: 'r' }] })
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:rescue'])
  const m = h.gh.marker(7)
  assert.equal(m?.graph, 'rescue')
  assert.equal(m?.node, 'to-human')
  assert.match(String(m?.lastFailure), /#99 is not an open agent PR/)
  assert.match(comments(h, 7)[0], /needs a person/)
})

test('an item unstuck while it was diagnosed: the verdict is not applied', async () => {
  const h = rig({ issues: [{ number: 7, labels: ['q:task', 'why:budget'] }] })
  await tick(h.deps)
  const w = /** @type {import('../src/store.mjs').Worker} */ (h.deps.store.worker(SLUG, 7))
  h.gh.issue(7).labels = ['q:task']
  h.spawner.logs.set(w.stdout, logWith({ stuck: true, how: 'x', actions: [{ do: 'to-human', reason: 'r' }] }))
  h.procs.live.delete(w.pid)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels, ['q:task'])
  assert.deepEqual(comments(h, 7), [])
  assert.equal(h.deps.store.worker(SLUG, 7), null)
})

test('cooldown, budget and the sweep clock', async () => {
  const h = rig({ issues: [{ number: 7, labels: ['q:task', 'q:human'] }] })
  // Rescued an hour ago: cooling down.
  h.deps.store.set(`rescue:${SLUG}#7`, JSON.stringify([T0 - HOUR]))
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 0)
  // Rescued twice this week, the last past the cooldown: straight to a human, no worker.
  h.deps.store.set(`rescue:${SLUG}#7`, JSON.stringify([T0 - 3 * 24 * HOUR, T0 - 2 * 24 * HOUR]))
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 0, 'the sweep runs every rescue.everyMinutes')
  h.clock.advance(61 * MIN)
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 0)
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:rescue'])
  assert.match(String(h.gh.marker(7)?.lastFailure), /rescued 2 times this week and still stuck \(many-queues\)/)
})

test('off by default: no sweep without phases.rescue.cap', async () => {
  const h = harness({
    issues: [{ number: 7, labels: ['q:task', 'q:human'] }],
    config: { engine: 'graph', phases: { task: { cap: 0 } } },
  })
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 0)
  assert.equal(h.gh.calls.filter((c) => c.op === 'closedPulls').length, 0)
})

test('cambium run rescue lists what is stuck and changes nothing', async () => {
  const h = rig({
    issues: [
      { number: 7, labels: ['q:task', 'why:budget'] },
      { number: 8, labels: ['q:task'] },
    ],
  })
  /** @type {string[]} */
  const lines = []
  const r = await runIssue(h.deps, { graph: 'rescue', slug: SLUG, out: (l) => lines.push(l) })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(lines, [`${SLUG}#7`, '  why-outside-human: why:budget without q:human'])
  assert.equal(h.spawner.started.length, 0)
  assert.ok(!h.gh.calls.some((c) => ['label', 'writeState', 'comment', 'createIssue'].includes(c.op)))
})

test('cambium run rescue --issue rescues one item in the foreground', async () => {
  const h = rig({ issues: [{ number: 7, labels: ['q:task', 'why:budget'] }] })
  const orig = h.spawner.start
  h.spawner.start = async (spec) => {
    const s = await orig(spec)
    h.spawner.logs.set(
      s.stdout,
      logWith({ stuck: true, how: 'hand label', actions: [{ do: 'clear-labels', labels: ['why:budget'] }] }),
    )
    h.procs.live.delete(s.pid)
    return s
  }
  /** @type {string[]} */
  const lines = []
  const r = await runIssue(h.deps, { graph: 'rescue', slug: SLUG, number: 7, out: (l) => lines.push(l) })
  assert.deepEqual(r, { ok: true })
  assert.equal(h.spawner.started[0].foreground, true)
  assert.deepEqual(h.gh.issue(7).labels, ['q:task'])
  assert.match(lines.at(-1) ?? '', /unstick → file-causes → report → __end__/)
  const none = await runIssue(h.deps, { graph: 'rescue', slug: SLUG, number: 7, out: () => {} })
  assert.deepEqual(none, { ok: false, error: `${SLUG}#7 is not stuck` })
})
