// @ts-check
/**
 * The tick against a fake clock, GitHub, spawner and process table: every
 * queue transition, and each row of the plan's "Lessons from the old Clock".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG } from './fakes.mjs'

const MIN = 60_000
const task = (/** @type {number} */ number, /** @type {string[]} */ extra = []) => ({
  number,
  labels: ['q:task', ...extra],
})

test('schedule: claims q:task issues up to the cap, priority then age, with the four-point prompt', async () => {
  const h = harness({
    issues: [task(1), task(2, ['priority:low']), task(3, ['priority:high']), task(4)],
    config: { phases: { task: { cap: 2 } } },
  })
  const state = await tick(h.deps)
  assert.deepEqual(
    h.spawner.started.map((s) => s.issue),
    [3, 2],
  )
  const first = h.spawner.started[0]
  assert.equal(first.branch, 'agent/issue-3')
  assert.equal(first.attempt, 1)
  assert.equal(first.maxTurns, 200)
  for (const needle of [
    'GitHub issue #3',
    'pnpm verify',
    'graft publish agent/issue-3',
    '--closes 3',
    'graft ci wait agent/issue-3',
    '# AGENTS.md from the worktree',
    'Body of 3',
  ])
    assert.ok(first.prompt.includes(needle), needle)
  assert.deepEqual(h.gh.issue(3).labels.sort(), ['priority:high', 'q:task', 'running'])
  const m = h.gh.marker(3)
  assert.equal(m?.stage, 'running')
  assert.equal(m?.host, 'mac')
  assert.equal(m?.attempt, 1)
  assert.equal(m?.start, new Date(h.clock.now()).toISOString())
  assert.equal(h.deps.store.workers().length, 2)
  assert.equal(state.counts.workers, 2)
  assert.equal(state.counts.running, 2)
})

test('lesson #4309: capacity is counted from live workers, nothing is queued locally', async () => {
  const h = harness({ issues: [1, 2, 3, 4, 5].map((n) => task(n)), config: { phases: { task: { cap: 2 } } } })
  await tick(h.deps)
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 2, 'a second tick starts nothing while both workers live')
  // Worker for #1 finishes with a PR; its slot frees and the next oldest starts in the same tick.
  const w1 = /** @type {any} */ (h.deps.store.worker(SLUG, 1))
  h.procs.live.delete(w1.pid)
  h.gh.addPr({ number: 101, closes: [1] })
  await tick(h.deps)
  assert.deepEqual(
    h.spawner.started.map((s) => s.issue),
    [1, 2, 3],
  )
  assert.equal(h.deps.store.workers().length, 2)
})

test('reconcile: a finished worker with an open PR → submitted, out of every queue, worktree pruned', async () => {
  const h = harness({ issues: [task(7)] })
  await tick(h.deps)
  const w = /** @type {any} */ (h.deps.store.worker(SLUG, 7))
  h.procs.live.delete(w.pid)
  h.gh.addPr({ number: 70, closes: [7] })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels, [])
  const m = h.gh.marker(7)
  assert.equal(m?.stage, 'submitted')
  assert.equal(m?.pr, 70)
  assert.equal(m?.attempt, 1)
  assert.equal(h.deps.store.worker(SLUG, 7), null)
  assert.deepEqual(h.spawner.cleaned, [w.worktree])
  assert.equal(h.gh.calls.filter((c) => c.op === 'writeState' && c.args[1] === 7).length, 2)
  assert.equal(new Set(h.gh.calls.filter((c) => c.op === 'writeState').map((c) => c.args[2] ?? 'new')).size, 2)
})

test('lesson #4349: a dead worker without a result is requeued with attempt + 1 and the stderr tail', async () => {
  const h = harness({ issues: [task(8)], config: { phases: { task: { cap: 0 } } } })
  h.deps.store.addWorker({
    repo: SLUG,
    issue: 8,
    phase: 'task',
    pid: 999,
    worktree: '/wt/8',
    branch: 'agent/issue-8',
    attempt: 1,
    startedAt: h.clock.now(),
    host: 'mac',
    stdout: '/logs/8.out.log',
    stderr: '/logs/8.err.log',
  })
  h.gh.issue(8).labels.push('running')
  await tick(h.deps)
  const m = h.gh.marker(8)
  assert.equal(m?.attempt, 2)
  assert.equal(m?.stage, 'queued')
  assert.match(String(m?.lastFailure), /without a published PR/)
  assert.match(String(m?.lastFailure), /the last stderr line/)
  assert.equal(m?.history.at(-1)?.outcome, 'failed')
  assert.equal(m?.history.at(-1)?.log, '/logs/8.out.log')
  assert.deepEqual(h.gh.issue(8).labels, ['q:task'])
  assert.equal(h.deps.store.workers().length, 0, 'the slot is free')
})

test('lesson #4349: over the wall-clock cap → kill the process group, requeue', async () => {
  const h = harness({ issues: [task(9)] })
  await tick(h.deps)
  const w = /** @type {any} */ (h.deps.store.worker(SLUG, 9))
  h.clock.advance(59 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.procs.killed, [], 'under the cap, untouched')
  h.clock.advance(2 * MIN)
  h.deps.config.phases.task.cap = 0
  await tick(h.deps)
  assert.deepEqual(h.procs.killed, [w.pid])
  const m = h.gh.marker(9)
  assert.equal(m?.attempt, 2)
  assert.equal(m?.history.at(-1)?.outcome, 'killed')
  assert.match(String(m?.lastFailure), /60 min wall-clock cap/)
  assert.deepEqual(h.gh.issue(9).labels, ['q:task'])
})

test('attempts spent → q:human + why:budget, and nothing restarts it', async () => {
  const h = harness({ issues: [task(10, ['running'])], config: { phases: { task: { maxAttempts: 2 } } } })
  h.gh.issue(10).comment = {
    id: 3,
    body: renderBack({ v: 1, phase: 'task', stage: 'running', attempt: 2, host: 'mac', history: [] }),
  }
  h.deps.store.addWorker({
    repo: SLUG,
    issue: 10,
    phase: 'task',
    pid: 998,
    worktree: '/wt/10',
    branch: 'agent/issue-10',
    attempt: 2,
    startedAt: h.clock.now(),
    host: 'mac',
    stdout: '/logs/10.out.log',
    stderr: '/logs/10.err.log',
  })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(10).labels.sort(), ['q:human', 'why:budget'])
  assert.equal(h.gh.marker(10)?.stage, 'human')
  assert.equal(h.gh.marker(10)?.host, null)
  assert.match(String(h.gh.marker(10)?.lastFailure), /2 attempts spent/)
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 0)
})

test('lesson #4565: one loop decides and spawns — a requeued task restarts in the same tick', async () => {
  const h = harness({ issues: [task(29)] })
  await tick(h.deps)
  h.procs.live.clear()
  await tick(h.deps)
  assert.deepEqual(
    h.spawner.started.map((s) => [s.issue, s.attempt]),
    [
      [29, 1],
      [29, 2],
    ],
  )
  assert.match(h.spawner.started[1].prompt, /attempt 2 of 3/)
  assert.match(h.spawner.started[1].prompt, /without a published PR/)
  assert.deepEqual(h.gh.issue(29).labels.sort(), ['q:task', 'running'])
})

/** @param {any} m */
function renderBack(m) {
  return `<!-- cambium:state ${JSON.stringify(m)} -->`
}

test('lesson #4303: cambium never merges — a green PR waits for the queue; merged → close, delete branch', async () => {
  const h = harness({ issues: [task(11)] })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.addPr({ number: 110, closes: [11], checks: 'SUCCESS' })
  await tick(h.deps)
  await tick(h.deps)
  assert.equal(h.gh.issue(11).state, 'OPEN', 'green and armed: waiting on the merge queue')
  Object.assign(h.gh.pr(110), { state: 'MERGED' })
  await tick(h.deps)
  assert.equal(h.gh.issue(11).state, 'CLOSED')
  assert.equal(h.gh.marker(11)?.stage, 'done')
  assert.ok(h.gh.calls.some((c) => c.op === 'deleteBranch' && c.args[1] === 'agent/issue-11'))
  const ops = new Set(h.gh.calls.map((c) => c.op))
  assert.deepEqual([...ops].sort(), ['close', 'deleteBranch', 'label', 'read', 'writeState'])
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'deleteBranch').length, 1)
})

test('watch: red CI → requeue with the failing log summary, the next worker resumes the PR', async () => {
  const h = harness({ issues: [task(12)] })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.addPr({ number: 120, closes: [12], checks: 'PENDING', headSha: 'deadbeef00' })
  await tick(h.deps)
  Object.assign(h.gh.pr(120), {
    checks: 'FAILURE',
    failing: [{ name: 'verify', url: 'https://ci/run/1', summary: 'cambium:test failed\n3 tests red' }],
  })
  await tick(h.deps)
  const m = h.gh.marker(12)
  assert.equal(m?.attempt, 2)
  assert.equal(m?.failedSha, 'deadbeef00')
  assert.match(String(m?.lastFailure), /CI red on PR #120 at deadbee/)
  assert.match(String(m?.lastFailure), /verify \(https:\/\/ci\/run\/1\)/)
  assert.match(String(m?.lastFailure), /3 tests red/)
  const second = /** @type {any} */ (h.spawner.started.at(-1))
  assert.equal(second.issue, 12)
  assert.equal(second.attempt, 2)
  assert.match(second.prompt, /A PR already exists: #120/)
  assert.match(second.prompt, /graft advance agent\/issue-12/)
  assert.match(second.prompt, /3 tests red/)

  // The worker exits without pushing: head is still the red commit → a failed attempt, not "submitted".
  h.procs.live.clear()
  await tick(h.deps)
  assert.equal(h.gh.marker(12)?.attempt, 3)
  assert.match(String(h.gh.marker(12)?.lastFailure), /without pushing a fix/)
})

test('watch: the same red commit is not requeued twice', async () => {
  const h = harness({
    issues: [{ number: 13, labels: [] }],
    prs: [{ number: 130, closes: [13], checks: 'FAILURE', headSha: 'abc' }],
    config: { phases: { task: { cap: 0 } } },
  })
  h.gh.issue(13).comment = {
    id: 1,
    body: renderBack({ v: 1, phase: 'task', stage: 'submitted', attempt: 2, pr: 130, failedSha: 'abc', history: [] }),
  }
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op !== 'read').length, 0)
})

test('watch: dequeued from the merge queue → requeue', async () => {
  const h = harness({ issues: [task(14)], config: { phases: { task: { cap: 1 } } } })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.addPr({ number: 140, closes: [14], checks: 'SUCCESS' })
  await tick(h.deps)
  Object.assign(h.gh.pr(140), { inMergeQueue: true, autoMerge: false })
  await tick(h.deps)
  assert.equal(h.gh.marker(14)?.queued, true)
  Object.assign(h.gh.pr(140), { inMergeQueue: false })
  h.deps.config.phases.task.cap = 0
  await tick(h.deps)
  assert.equal(h.gh.marker(14)?.attempt, 2)
  assert.match(String(h.gh.marker(14)?.lastFailure), /left the merge queue/)
  assert.deepEqual(h.gh.issue(14).labels, ['q:task'])
})

test('watch: not merged within mergeQueueMinutes → q:human', async () => {
  const h = harness({ issues: [task(15)] })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.addPr({ number: 150, closes: [15], checks: 'SUCCESS', inMergeQueue: true })
  await tick(h.deps)
  h.clock.advance(121 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(15).labels.sort(), ['q:human', 'why:budget'])
  assert.match(String(h.gh.marker(15)?.lastFailure), /not merged within 120 min/)
})

test('restart re-adopts live pids: a fresh tick over the same store starts nothing and moves nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-'))
  const db = join(dir, 'c.db')
  const h = harness({ issues: [task(16), task(17)], store: openStore(db), config: { phases: { task: { cap: 1 } } } })
  await tick(h.deps)
  h.deps.store.close()
  h.deps.store = openStore(db)
  const writesBefore = h.gh.calls.filter((c) => c.op !== 'read').length
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 1)
  assert.equal(h.gh.calls.filter((c) => c.op !== 'read').length, writesBefore)
  assert.equal(h.deps.store.workers()[0].issue, 16)
})

test('lesson #4416: losing SQLite costs a requeue — `running` with no tracked worker on this host is swept', async () => {
  const h = harness({ issues: [task(18)], config: { phases: { task: { cap: 0 } } } })
  h.gh.issue(18).labels.push('running')
  h.gh.issue(18).comment = {
    id: 5,
    body: renderBack({ v: 1, phase: 'task', stage: 'running', attempt: 1, host: 'mac', history: [] }),
  }
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(18).labels, ['q:task'])
  assert.equal(h.gh.marker(18)?.attempt, 2)
  assert.equal(h.gh.marker(18)?.history.at(-1)?.outcome, 'lost')
})

test("sweep leaves another host's lease alone", async () => {
  const h = harness({ issues: [task(19)], config: { phases: { task: { cap: 0 } } } })
  h.gh.issue(19).labels.push('running')
  h.gh.issue(19).comment = {
    id: 5,
    body: renderBack({ v: 1, phase: 'task', stage: 'running', attempt: 1, host: 'mini', history: [] }),
  }
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op !== 'read').length, 0)
})

test('lesson #4416: thousands of queued issues are just a sort — the cap still holds', async () => {
  const h = harness({
    issues: Array.from({ length: 2000 }, (_, i) => task(i + 1)),
    config: { phases: { task: { cap: 3 } } },
  })
  const state = await tick(h.deps)
  assert.equal(h.spawner.started.length, 3)
  assert.equal(state.counts.task, 2000)
  assert.ok(state.steps.every((s) => s.ok))
})

test('a failed spawn requeues (attempt + 1) instead of holding the lease', async () => {
  const h = harness({ issues: [task(20)] })
  h.spawner.fail = new Error('spawn claude ENOENT')
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(20).labels, ['q:task'])
  assert.equal(h.gh.marker(20)?.attempt, 2)
  assert.match(String(h.gh.marker(20)?.lastFailure), /ENOENT/)
  assert.equal(h.deps.store.workers().length, 0)
})

test('a failing step is logged and the tick moves on to the heartbeat', async () => {
  const h = harness({ issues: [task(21)] })
  h.gh.faults.readError = new Error('graft graphql exited 1: rate limited')
  const state = await tick(h.deps)
  const read = state.steps.find((s) => s.name === 'read')
  assert.equal(read?.ok, false)
  assert.match(String(read?.error), /no repository could be read/)
  assert.ok(state.steps.find((s) => s.name === 'schedule'))
  assert.equal(h.beats.length, 1)
  assert.equal(h.beats[0].repos[0].ok, false)
  assert.match(String(h.beats[0].repos[0].error), /rate limited/)
  assert.ok(h.events.some((e) => e.level === 'error' && /rate limited/.test(e.msg)))
})

test('one failing write does not stop the other items in the step', async () => {
  const h = harness({ issues: [task(22), task(23)] })
  let n = 0
  const label = h.deps.github.label
  h.deps.github.label = async (...args) => {
    if (n++ === 0) throw new Error('label 502')
    return label(...args)
  }
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 1)
  assert.ok(h.events.some((e) => /label 502/.test(e.msg) && e.issue === 22))
})

test('each step is bounded: a hung read times out and the tick still finishes', async () => {
  const h = harness({ issues: [task(24)], config: { stepTimeoutSeconds: 0.05 } })
  h.gh.faults.hang = true
  const state = await tick(h.deps)
  assert.match(String(state.steps[0].error), /exceeded/)
  assert.equal(h.beats.length, 1)
})

test('pause: read and heartbeat only; drain: reconcile but start nothing', async () => {
  const h = harness({ issues: [task(25), task(26)], config: { phases: { task: { cap: 1 } } } })
  h.deps.store.setMode('paused')
  const paused = await tick(h.deps)
  assert.deepEqual(
    paused.steps.map((s) => s.name),
    ['read'],
  )
  assert.equal(paused.mode, 'paused')
  assert.equal(h.beats.length, 1)
  assert.equal(h.gh.calls.filter((c) => c.op !== 'read').length, 0)

  h.deps.store.setMode('running')
  await tick(h.deps)
  h.deps.store.setMode('draining')
  const w = /** @type {any} */ (h.deps.store.worker(SLUG, 25))
  h.procs.live.delete(w.pid)
  h.gh.addPr({ number: 250, closes: [25] })
  const drained = await tick(h.deps)
  assert.equal(h.gh.marker(25)?.stage, 'submitted', 'reconcile still runs')
  assert.equal(h.spawner.started.length, 1, 'nothing new while draining')
  assert.ok(!drained.steps.some((s) => s.name === 'schedule'))
})

test('a worker is gone and its issue was closed meanwhile → dropped quietly', async () => {
  const h = harness({ issues: [task(27)] })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.issue(27).state = 'CLOSED'
  const writes = h.gh.calls.filter((c) => c.op !== 'read').length
  await tick(h.deps)
  assert.equal(h.deps.store.workers().length, 0)
  assert.equal(h.gh.calls.filter((c) => c.op !== 'read').length, writes)
})

test('read failure: a dead worker waits for a readable snapshot instead of guessing', async () => {
  const h = harness({ issues: [task(28)] })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.faults.readError = new Error('down')
  await tick(h.deps)
  assert.equal(h.deps.store.workers().length, 1)
  h.gh.faults.readError = null
  h.gh.addPr({ number: 280, closes: [28] })
  await tick(h.deps)
  assert.equal(h.gh.marker(28)?.stage, 'submitted')
})

test('release: the daily seam runs once at its time; dispatch: the stub is reached only with a cap', async () => {
  const h = harness({
    issues: [{ number: 30, labels: ['q:intake'] }],
    config: { release: { enabled: true, time: '00:00' }, phases: { dispatch: { cap: 1 } } },
  })
  /** @type {number[]} */
  const releases = []
  h.deps.release = async ({ now }) => {
    releases.push(now)
    return { done: false, note: 'stub' }
  }
  await tick(h.deps)
  await tick(h.deps)
  assert.equal(releases.length, 1)
  h.clock.advance(24 * 60 * MIN)
  await tick(h.deps)
  assert.equal(releases.length, 2)
  assert.ok(h.events.some((e) => /dispatch phase is not built/.test(e.msg)))
  assert.deepEqual(h.gh.issue(30).labels, ['q:intake'], 'intake is untouched')
})

test('heartbeat: the documented shape', async () => {
  const h = harness({ issues: [task(31), { number: 32, labels: ['q:human', 'why:budget'] }] })
  h.deps.tickNumber = 4
  h.deps.daemonStartedAt = h.clock.now() - 1000
  h.deps.pid = 42
  const s = await tick(h.deps)
  assert.deepEqual(Object.keys(s).sort(), [
    'caps',
    'counts',
    'daemon',
    'events',
    'host',
    'mode',
    'pid',
    'repos',
    'steps',
    'tick',
    'version',
    'workers',
  ])
  assert.equal(s.version, 1)
  assert.equal(s.pid, 42)
  assert.equal(s.tick.n, 4)
  assert.equal(s.daemon.tickSeconds, 30)
  assert.deepEqual(s.counts, { intake: 0, task: 1, human: 1, promote: 0, running: 1, review: 0, workers: 1 })
  assert.deepEqual(Object.keys(s.workers[0]).sort(), [
    'alive',
    'attempt',
    'branch',
    'elapsedMs',
    'issue',
    'killedReason',
    'logs',
    'phase',
    'pid',
    'repo',
    'startedAt',
    'wallClockMs',
    'worktree',
  ])
  assert.deepEqual(s.repos[0].counts, { intake: 0, task: 1, human: 1, promote: 0, running: 1, review: 0 })
  assert.equal(Date.parse(s.tick.nextAt) - Date.parse(s.tick.finishedAt), 30_000)
})
