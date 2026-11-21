// @ts-check
/** Per-issue cost accounting: worker `result` events → the marker (per phase, overall), the ledger, the heartbeat. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.mjs'
import { addCost, costDays, costOf, overBudget, recordCost, runCost } from '../src/cost.mjs'
import { setMarker } from '../src/issue-state.mjs'
import { newMarker, parseMarker, renderMarker } from '../src/marker.mjs'
import { openStore } from '../src/store.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG } from './fakes.mjs'

const STREAM = readFileSync(new URL('./fixtures/worker-stream.jsonl', import.meta.url), 'utf8')
const KILLED = readFileSync(new URL('./fixtures/worker-killed.jsonl', import.meta.url), 'utf8')

/** A one-line stream-json log ending in a `result` event. @param {number} usd @param {number} [tokens] */
const resultLog = (usd, tokens = 100) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    total_cost_usd: usd,
    usage: {
      input_tokens: tokens,
      output_tokens: 2 * tokens,
      cache_read_input_tokens: 3 * tokens,
      cache_creation_input_tokens: 4 * tokens,
    },
  })

test('runCost reads cost and tokens from the result event of a real worker log', () => {
  assert.deepEqual(runCost(STREAM), {
    usd: 2.5628464000000006,
    input: 100,
    output: 32432,
    cacheRead: 4646592,
    cacheCreation: 123061,
    runs: 1,
  })
})

test('runCost: a killed worker (no result event), an empty or garbled log → null, never a throw', () => {
  assert.equal(runCost(KILLED), null)
  assert.equal(runCost(''), null)
  assert.equal(runCost('not json\n{"type":"result"}\n'), null, 'a result without a cost')
})

test('addCost builds up per-phase and overall totals over several runs; the same log is never counted twice', () => {
  let cost = addCost(
    undefined,
    'triage',
    { usd: 0.5, input: 1, output: 2, cacheRead: 3, cacheCreation: 4, runs: 1 },
    'a',
  )
  cost = addCost(cost, 'task', { usd: 2.25, input: 10, output: 20, cacheRead: 30, cacheCreation: 40, runs: 1 }, 'b')
  cost = addCost(cost, 'task', { usd: 1.25, input: 10, output: 20, cacheRead: 30, cacheCreation: 40, runs: 1 }, 'c')
  cost = addCost(cost, 'rescue', { usd: 0.1, input: 0, output: 1, cacheRead: 0, cacheCreation: 0, runs: 1 }, 'd')
  const again = addCost(cost, 'rescue', { usd: 0.1, input: 0, output: 1, cacheRead: 0, cacheCreation: 0, runs: 1 }, 'd')
  assert.deepEqual(again, cost, 'log d was the last one counted')
  assert.deepEqual(cost.triage, { usd: 0.5, input: 1, output: 2, cacheRead: 3, cacheCreation: 4, runs: 1 })
  assert.deepEqual(cost.task, { usd: 3.5, input: 20, output: 40, cacheRead: 60, cacheCreation: 80, runs: 2 })
  assert.deepEqual(cost.total, { usd: 4.1, input: 21, output: 43, cacheRead: 63, cacheCreation: 84, runs: 4 })
  assert.equal(cost.lastLog, 'd')
})

test('a marker with cost fields round-trips through GitHub and adds on; one from before cost starts at zero', () => {
  const run = /** @type {import('../src/cost.mjs').Tally} */ (runCost(resultLog(1.5)))
  const body = renderMarker(newMarker({ cost: addCost(null, 'task', run, '/l/a1.out.log') }))
  assert.match(body, /cost \$1\.50/, 'the human-readable line shows the total')
  const parsed = /** @type {any} */ (parseMarker(body))
  assert.equal(parsed.cost.task.usd, 1.5)
  const more = addCost(parsed.cost, 'task', run, '/l/a2.out.log')
  assert.equal(more.task.usd, 3)
  assert.equal(more.task.runs, 2)

  const old = parseMarker(`<!-- cambium:state ${JSON.stringify({ v: 2, graph: 'task', node: 'start-worker' })} -->`)
  assert.equal(old?.cost, undefined)
  assert.deepEqual(costOf(old).total, { usd: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, runs: 0 })
  const v1 = parseMarker(`<!-- cambium:state ${JSON.stringify({ v: 1, stage: 'running', phase: 'task' })} -->`)
  assert.equal(costOf(v1).task.runs, 0)
  assert.equal(addCost(v1?.cost, 'triage', run, 'x').total.usd, 1.5)
})

test('setMarker keeps the cost when a write starts a fresh marker', async () => {
  const config = resolveConfig({})
  /** @type {string[]} */
  const bodies = []
  const github = /** @type {any} */ ({
    writeState: async (
      /** @type {any} */ _s,
      /** @type {any} */ _n,
      /** @type {any} */ id,
      /** @type {string} */ body,
    ) => {
      bodies.push(body)
      return id ?? 1
    },
  })
  const cost = addCost(null, 'triage', { usd: 0.4, input: 1, output: 1, cacheRead: 1, cacheCreation: 1, runs: 1 }, 'a')
  const issue = /** @type {any} */ ({ number: 3, stateComment: { id: 1, marker: newMarker({ cost }) } })
  await setMarker({ config, github }, SLUG, issue, newMarker({ phase: 'task' }))
  assert.equal(parseMarker(bodies[0])?.cost?.triage.usd, 0.4)
})

/** Deps enough for {@link recordCost}, with a log at `/l/run.out.log`. @param {string} log */
function costDeps(log) {
  /** @type {any[]} */
  const writes = []
  /** @type {any[]} */
  const warns = []
  const store = openStore(':memory:')
  return {
    writes,
    warns,
    store,
    deps: {
      config: resolveConfig({}),
      github: /** @type {any} */ ({
        writeState: async (/** @type {any[]} */ ...args) => {
          writes.push(args)
          return 1
        },
      }),
      spawner: { readLog: () => log },
      store,
      log: (/** @type {any} */ level, /** @type {string} */ msg) => (level === 'warn' ? warns.push(msg) : null),
    },
  }
}

const NOW = Date.parse('2026-11-20T09:00:00Z')
const worker = { repo: SLUG, issue: 5, phase: 'task', stdout: '/l/run.out.log' }

test('recordCost: a killed worker changes nothing and throws nothing', async () => {
  const k = costDeps(KILLED)
  const issue = /** @type {any} */ ({ number: 5, stateComment: { id: 1, marker: newMarker() } })
  assert.equal(await recordCost(k.deps, issue, worker, NOW), null)
  assert.equal(k.writes.length, 0)
  assert.deepEqual(k.store.costs('2026-01-01'), [])
  assert.deepEqual(k.warns, [])
  assert.equal(issue.stateComment.marker.cost, undefined)
  const unreadable = costDeps('')
  unreadable.deps.spawner.readLog = () => {
    throw new Error('EACCES')
  }
  assert.equal(await recordCost(unreadable.deps, issue, worker, NOW), null, 'a failing read is logged, not thrown')
  assert.equal(unreadable.warns.length, 1)
})

test('recordCost: adds the run to the marker and the day ledger once, per phase (dispatch counts as triage)', async () => {
  const k = costDeps(resultLog(2))
  const issue = /** @type {any} */ ({ number: 5, stateComment: { id: 1, marker: newMarker() } })
  const cost = await recordCost(k.deps, issue, worker, NOW)
  assert.equal(cost?.task.usd, 2)
  assert.equal(issue.stateComment.marker.cost.task.usd, 2)
  assert.equal(k.writes.length, 1)
  assert.equal(await recordCost(k.deps, issue, worker, NOW), null, 'the same run again')
  assert.equal(k.writes.length, 1)
  await recordCost(k.deps, issue, { ...worker, phase: 'dispatch', stdout: '/l/triage.out.log' }, NOW)
  await recordCost(k.deps, issue, { ...worker, phase: 'release', stdout: '/l/x.out.log' }, NOW)
  assert.equal(issue.stateComment.marker.cost.triage.usd, 2)
  assert.equal(issue.stateComment.marker.cost.total.usd, 4)
  assert.deepEqual(costDays(k.store.costs('2026-11-01')), [
    { day: '2026-11-20', triage: 2, task: 2, rescue: 0, total: 4 },
  ])
})

test('overBudget: task spend over the threshold with no merged PR; 0 switches it off', () => {
  const cost = addCost(null, 'task', { usd: 12, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, runs: 1 }, 'a')
  assert.equal(overBudget(cost, 10, false), true)
  assert.equal(overBudget(cost, 10, true), false, 'merged')
  assert.equal(overBudget(cost, 20, false), false)
  assert.equal(overBudget(cost, 0, false), false)
  const triageOnly = addCost(null, 'triage', { ...cost.task, usd: 50 }, 'b')
  assert.equal(overBudget(triageOnly, 10, false), false, 'only task spend counts')
})

test('config: costFlagUsd defaults to 10 and must be a number ≥ 0', () => {
  assert.equal(resolveConfig({}).costFlagUsd, 10)
  assert.equal(resolveConfig({ costFlagUsd: 0 }).costFlagUsd, 0)
  assert.throws(() => resolveConfig({ costFlagUsd: -1 }), /costFlagUsd/)
  assert.throws(() => resolveConfig({ costFlagUsd: '10' }), /costFlagUsd/)
})

for (const engine of /** @type {const} */ (['legacy', 'graph'])) {
  test(`[${engine}] a task worker's cost lands on the marker, survives a restart, and shows in the heartbeat`, async () => {
    const h = harness({ issues: [{ number: 7, labels: ['q:task'] }], config: { engine, costFlagUsd: 5 } })
    await tick(h.deps)
    const w1 = /** @type {any} */ (h.deps.store.worker(SLUG, 7))
    h.spawner.logs.set(w1.stdout, resultLog(3.5))
    h.procs.live.delete(w1.pid)
    await tick(h.deps) // no PR: a failed attempt, requeued
    assert.equal(h.gh.marker(7)?.cost?.task.usd, 3.5)
    assert.equal(h.gh.marker(7)?.attempt, 2)

    // A restart: a new store (SQLite gone), the marker still on GitHub.
    h.deps.store = openStore(':memory:')
    await tick(h.deps)
    const w2 = /** @type {any} */ (h.deps.store.worker(SLUG, 7))
    h.spawner.logs.set(w2.stdout, resultLog(2.5))
    h.procs.live.delete(w2.pid)
    const beat = await tick(h.deps)
    const m = h.gh.marker(7)
    assert.equal(m?.cost?.task.usd, 6)
    assert.equal(m?.cost?.task.runs, 2)
    assert.equal(m?.cost?.total.usd, 6)

    const [row] = beat.repos[0].cost.issues
    assert.equal(row.number, 7)
    assert.equal(row.cost.task.usd, 6)
    assert.equal(row.flagged, true, 'task spend $6 > costFlagUsd $5, no merged PR')
    assert.deepEqual(
      beat.repos[0].cost.days.map((d) => [d.task, d.total]),
      [[2.5, 2.5]],
      'the ledger was lost with the store; only the run since counts',
    )
  })

  test(`[${engine}] a killed task worker records no cost`, async () => {
    const h = harness({ issues: [{ number: 8, labels: ['q:task'] }], config: { engine } })
    await tick(h.deps)
    const w = /** @type {any} */ (h.deps.store.worker(SLUG, 8))
    h.spawner.logs.set(w.stdout, KILLED)
    h.procs.live.delete(w.pid)
    const beat = await tick(h.deps)
    assert.equal(h.gh.marker(8)?.cost ?? null, null)
    assert.deepEqual(beat.repos[0].cost, { issues: [], days: [] })
  })
}
