// @ts-check
/** Upkeep (graph engine): the hourly reaper of untracked agent PRs and the daily re-triage of `q:human`. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { branchIssue, unreadCloses } from '../src/github.mjs'
import { reapVerdict } from '../src/upkeep.mjs'
import { newMarker, renderMarker } from '../src/marker.mjs'
import { tick } from '../src/tick.mjs'
import { resolveConfig } from '../src/config.mjs'
import { fingerprintOf, retriageDecision, TRIAGE_RUBRIC } from '../src/triage-inputs.mjs'
import { harness, SLUG } from './fakes.mjs'

const MIN = 60_000

/** @param {{ issues?: any[], prs?: any[], config?: any }} seed */
const graph = ({ issues = [], prs = [], config = {} }) =>
  harness({
    issues,
    prs,
    config: {
      engine: 'graph',
      repos: [{ slug: SLUG, path: '/repo', merge: 'green' }],
      phases: { task: { cap: 0 }, dispatch: { cap: 0 } },
      ...config,
    },
  })

const reaperComments = (/** @type {ReturnType<typeof harness>} */ h) =>
  h.gh.calls.filter((c) => c.op === 'comment' && /\*\*Reaper:\*\*/.test(c.args[2]))

test('branchIssue reads agent/<n>-slug and agent/issue-<n>', () => {
  assert.equal(branchIssue('agent/4408-shared-vehicle-link'), 4408)
  assert.equal(branchIssue('agent/issue-7'), 7)
  assert.equal(branchIssue('agent/cambium-upkeep'), null)
  assert.equal(branchIssue('feature/12-x'), null)
})

test('unreadCloses also asks for the issue an open PR names only by its branch', () => {
  const snap = /** @type {any} */ ({
    issues: new Map(),
    prs: [
      { state: 'OPEN', closes: [], branch: 'agent/4316-e2e' },
      { state: 'OPEN', closes: [9], branch: 'agent/12-x' },
      { state: 'MERGED', closes: [], branch: 'agent/13-y' },
    ],
  })
  assert.deepEqual(unreadCloses(snap).sort(), [4316, 9])
})

test('reaper: a stale, untracked green PR for a q:human issue is linked, adopted, then merged by the PR graph', async () => {
  const h = graph({
    issues: [{ number: 4408, labels: ['q:human', 'why:budget'] }],
    prs: [{ number: 4627, closes: [], branch: 'agent/4408-shared-vehicle', checks: 'SUCCESS', autoMerge: false }],
  })
  await tick(h.deps)
  assert.equal(reaperComments(h).length, 0, 'fresh: left alone')

  h.clock.advance(61 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.calls.find((c) => c.op === 'linkIssue')?.args, [SLUG, 4627, 4408])
  assert.deepEqual(h.gh.issue(4408).labels, [], 'out of q:human')
  const m = h.gh.marker(4408)
  assert.equal(m?.pr, 4627)
  assert.equal(m?.node, 'submit')
  assert.match(reaperComments(h)[0].args[2], /adopted PR #4627, which nothing was tracking \(was q:human\)/)

  await tick(h.deps)
  assert.ok(
    h.gh.calls.some((c) => c.op === 'mergePull' && c.args[1] === 4627),
    'Watch merges it',
  )
})

test('reaper: a q:task issue with an untracked PR is adopted instead of starting a duplicate Task', async () => {
  const h = graph({
    issues: [{ number: 50, labels: ['q:task'] }],
    prs: [{ number: 500, closes: [50], checks: 'FAILURE', autoMerge: false }],
  })
  h.clock.advance(61 * MIN)
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'linkIssue').length, 0, 'already says Closes')
  assert.equal(h.gh.marker(50)?.pr, 500)
  assert.ok(!h.gh.issue(50).labels.includes('q:task'))
})

test('reaper leaves alone: a tracked PR and a PR touched recently; and runs hourly', async () => {
  const h = graph({
    issues: [
      { number: 50, labels: [] },
      { number: 52, labels: ['q:human', 'why:budget'] },
    ],
    prs: [
      { number: 500, closes: [50], checks: 'PENDING' },
      { number: 502, closes: [52], checks: 'PENDING' },
    ],
  })
  h.gh.issue(50).comment = { id: 7, body: renderMarker(newMarker({ node: 'submit', status: 'done', pr: 500 })) }
  h.clock.advance(61 * MIN)
  // #502 was updated a minute ago.
  Object.assign(/** @type {any} */ (h.gh.pulls.find((p) => p.number === 502)), {
    updatedAt: new Date(h.clock.now() - MIN).toISOString(),
  })
  await tick(h.deps)
  assert.equal(reaperComments(h).length, 0)
  assert.equal(h.gh.calls.filter((c) => c.op === 'closePull').length, 0)

  // Stale now, but the reaper ran under an hour ago.
  h.clock.advance(40 * MIN)
  await tick(h.deps)
  assert.equal(reaperComments(h).length, 0)
  h.clock.advance(21 * MIN)
  await tick(h.deps)
  assert.deepEqual(
    reaperComments(h).map((c) => c.args[1]),
    [52],
  )
})

test('reaper closes a PR whose issue is closed, and an issue-less one only after orphanDays', async () => {
  const h = graph({
    issues: [{ number: 60, labels: [], state: 'CLOSED' }],
    prs: [
      { number: 600, closes: [60], checks: 'SUCCESS' },
      { number: 601, closes: [], branch: 'agent/cambium-chore', checks: 'SUCCESS' },
    ],
  })
  h.clock.advance(61 * MIN)
  await tick(h.deps)
  const closed = () => h.gh.calls.filter((c) => c.op === 'closePull').map((c) => c.args[1])
  assert.deepEqual(closed(), [600])
  assert.match(h.gh.calls.find((c) => c.op === 'closePull')?.args[2], /Issue #60 is closed[\s\S]*reaper/)

  h.clock.advance(3 * 24 * 60 * MIN)
  await tick(h.deps)
  assert.deepEqual(closed(), [600, 601])
  assert.match(h.gh.calls.filter((c) => c.op === 'closePull')[1].args[2], /Abandoned: no issue names this PR/)
})

test('re-triage: daily, q:human back to q:intake without its why; not why:approve', async () => {
  const h = graph({
    issues: [
      { number: 70, labels: ['q:human', 'why:triage'] },
      { number: 71, labels: ['q:human', 'why:budget', 'priority:high'] },
      { number: 72, labels: ['q:human', 'why:approve'] },
    ],
    config: { retriage: { enabled: true, time: '00:00' }, reaper: { everyMinutes: 0 } },
  })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(70).labels, ['q:intake'])
  assert.deepEqual(h.gh.issue(71).labels.sort(), ['priority:high', 'q:intake'])
  assert.deepEqual(h.gh.issue(72).labels.sort(), ['q:human', 'why:approve'])

  // Once a day: a human sent back later the same day stays.
  h.gh.issue(70).labels = ['q:human', 'why:triage']
  h.clock.advance(60 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(70).labels.sort(), ['q:human', 'why:triage'])
  h.clock.advance(24 * 60 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(70).labels, ['q:intake'])
})

test('re-triage is off by default', async () => {
  const h = graph({ issues: [{ number: 70, labels: ['q:human', 'why:triage'] }] })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(70).labels.sort(), ['q:human', 'why:triage'])
})

test('reapVerdict: an issue with a live worker is left to it', () => {
  const issue = /** @type {any} */ ({ number: 5, state: 'OPEN', labels: ['q:task', 'running'], stateComment: null })
  const snap = /** @type {any} */ ({ issues: new Map([[5, issue]]), prs: [] })
  const pr = /** @type {any} */ ({
    number: 9,
    state: 'OPEN',
    closes: [5],
    branch: 'agent/5-x',
    createdAt: '2026-01-01T00:00:00Z',
  })
  const o = { now: Date.parse('2026-01-02T00:00:00Z'), staleMinutes: 30, orphanDays: 3 }
  assert.deepEqual(reapVerdict(pr, snap, { ...o, busy: () => true }), { act: 'leave', why: '#5 has a worker' })
  assert.deepEqual(reapVerdict(pr, snap, { ...o, busy: () => false }), { act: 'adopt', issue, link: false })
})

// ---- Re-triage skips an issue whose triage inputs are unchanged (triage-inputs.mjs)

const DAY = 24 * 60 * MIN
const RETRIAGE = {
  retriage: { enabled: true, time: '00:00' },
  reaper: { everyMinutes: 0 },
}

/**
 * A `q:human` issue at the dispatch graph's `to-human` whose marker carries the fingerprint of the issue as `seed`
 * reads it (or `fingerprint` as given).
 * @param {{ number?: number, labels?: string[], comments?: any[], blockedBy?: any[], body?: string }} seed
 * @param {{ prs?: any[], rubric?: number, at?: number, fingerprint?: any, others?: any[] }} [o]
 */
async function triagedHuman(
  seed,
  { prs = [], rubric, at = Date.parse('2026-11-16T12:00:00Z'), fingerprint, others = [] } = {},
) {
  const number = seed.number ?? 70
  const issue = { number, labels: ['q:human', 'why:triage'], ...seed }
  const h = graph({ issues: [issue, ...others], prs, config: RETRIAGE })
  const snap = await h.gh.github.read(SLUG)
  const read = /** @type {any} */ (snap.issues.get(number))
  const fp =
    fingerprint === undefined
      ? {
          hash: fingerprintOf(read, snap, { rubric }),
          at: new Date(at).toISOString(),
        }
      : fingerprint
  h.gh.issue(number).comment = {
    id: 1,
    body: renderMarker(
      newMarker({
        graph: 'dispatch',
        phase: 'dispatch',
        node: 'to-human',
        lastFailure: 'Which one?',
        fingerprint: fp,
      }),
    ),
  }
  return h
}

const retriageLog = (/** @type {ReturnType<typeof harness>} */ h) =>
  h.events.filter((e) => /^re-triage:/.test(e.msg)).at(-1)?.msg ?? ''

test('re-triage: an unchanged q:human issue stays, no label moves, no worker; the log counts it skipped', async () => {
  const h = await triagedHuman({
    comments: [
      {
        id: 5,
        author: 'alice',
        bot: false,
        createdAt: '2026-11-15T00:00:00Z',
        body: 'Hm.',
      },
    ],
  })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(70).labels.sort(), ['q:human', 'why:triage'])
  assert.equal(h.gh.calls.filter((c) => c.op === 'label').length, 0)
  assert.equal(h.spawner.started.length, 0)
  assert.match(retriageLog(h), /^re-triage: 0 of 1 changed; 0 back to q:intake, 1 unchanged skipped/)
})

test('re-triage: an edited body, a human comment, a label or a closed blocker each re-triage', async () => {
  const at = '2026-11-15T00:00:00Z'
  /** @type {[string, (h: ReturnType<typeof harness>) => void, any?, any?][]} */
  const cases = [
    [
      'body',
      (h) => {
        h.gh.issue(70).body = 'Edited: use the second tick.'
      },
    ],
    [
      'comment',
      (h) =>
        void h.gh.issue(70).comments.push({
          id: 9,
          author: 'alice',
          bot: false,
          createdAt: at,
          body: 'The second.',
        }),
    ],
    ['label', (h) => void h.gh.issue(70).labels.push('area:ui')],
    [
      'blocker',
      (h) => {
        h.gh.issue(80).state = 'CLOSED'
      },
      { blockedBy: [{ number: 80, state: 'OPEN', closedAt: null }] },
      { others: [{ number: 80, labels: ['q:task'] }] },
    ],
  ]
  for (const [what, change, seed = {}, o = {}] of cases) {
    const h = await triagedHuman(seed, o)
    change(h)
    await tick(h.deps)
    assert.deepEqual(
      h.gh.issue(70).labels.filter((l) => l.startsWith('q:')),
      ['q:intake'],
      what,
    )
    assert.match(retriageLog(h), /^re-triage: 1 of 1 changed/, what)
  }
})

test('re-triage: a bot or cambium comment and a cambium label move do not count as a change', async () => {
  const h = await triagedHuman({})
  h.gh.issue(70).comments.push({
    id: 11,
    author: 'ci[bot]',
    bot: true,
    createdAt: '2026-11-15T00:00:00Z',
    body: 'ping',
  })
  h.gh.issue(70).labels.push('wait:deferred')
  await tick(h.deps)
  assert.ok(h.gh.issue(70).labels.includes('q:human'))
})

test('re-triage: a new triage rubric version re-triages every q:human issue', async () => {
  const h = await triagedHuman({}, { rubric: TRIAGE_RUBRIC - 1 })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(70).labels, ['q:intake'])
})

test('re-triage: an issue unchanged for retriage.maxSkipDays is re-triaged anyway', async () => {
  const h = await triagedHuman({}, { at: Date.parse('2026-11-16T12:00:00Z') - 14 * DAY + 1 })
  await tick(h.deps)
  assert.ok(h.gh.issue(70).labels.includes('q:human'), 'one ms short of 14 days: skipped')
  h.clock.advance(DAY)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(70).labels, ['q:intake'])
  assert.match(retriageLog(h), /re-triage: 1 of 1 changed/)
})

test('retriage.maxSkipDays: default 14; must be a number ≥ 0', () => {
  assert.equal(resolveConfig({}).retriage.maxSkipDays, 14)
  assert.equal(resolveConfig({ retriage: { maxSkipDays: 0 } }).retriage.maxSkipDays, 0)
  assert.throws(() => resolveConfig({ retriage: { maxSkipDays: -1 } }), /maxSkipDays/)
  assert.throws(() => resolveConfig({ retriage: { maxSkipDays: '7' } }), /maxSkipDays/)
})

test('re-triage: a marker without a fingerprint is re-triaged once and gains one; then it is skipped', async () => {
  const h = graph({
    issues: [{ number: 70, labels: ['q:human', 'why:triage'] }],
    config: { ...RETRIAGE, phases: { task: { cap: 0 }, dispatch: { cap: 1 } } },
  })
  await tick(h.deps)
  // Re-triage moved it (upkeep runs after Schedule); the next tick starts triage.
  assert.deepEqual(h.gh.issue(70).labels, ['q:intake'])
  await tick(h.deps)
  const w = h.deps.store.worker(SLUG, 70)
  assert.ok(w)
  h.spawner.logs.set(
    w.stdout,
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '```json\n{"verdict":"needs-human","reason":"Which one?"}\n```',
    }),
  )
  h.procs.live.delete(w.pid)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(70).labels.sort(), ['q:human', 'why:triage'])
  const m = h.gh.marker(70)
  assert.match(m?.fingerprint?.hash ?? '', /^[0-9a-f]{16}$/)
  h.clock.advance(DAY)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(70).labels.sort(), ['q:human', 'why:triage'])
  assert.equal(h.deps.store.worker(SLUG, 70), null)
  assert.match(retriageLog(h), /0 of 1 changed/)
})

test('fingerprint: cambium labels do not count; the title does', () => {
  const issue = /** @type {any} */ ({
    number: 1,
    title: 't',
    body: 'b',
    labels: ['q:human', 'x'],
    blockedBy: [],
    comments: [],
  })
  const snap = /** @type {any} */ ({ issues: new Map([[1, issue]]), prs: [] })
  const a = fingerprintOf(issue, snap)
  assert.equal(fingerprintOf({ ...issue, labels: ['q:intake', 'running', 'x'] }, snap), a)
  assert.notEqual(fingerprintOf({ ...issue, title: 'u' }, snap), a)
})

test('retriageDecision: a linked PR merged since the verdict is a change', () => {
  const issue = /** @type {any} */ ({
    number: 70,
    title: 't',
    body: 'b',
    labels: ['q:human'],
    blockedBy: [],
    comments: [],
  })
  const pr = /** @type {any} */ ({
    number: 700,
    closes: [],
    branch: 'agent/70-x',
    state: 'OPEN',
  })
  const snap = /** @type {any} */ ({
    issues: new Map([[70, issue]]),
    prs: [pr],
  })
  const now = Date.parse('2026-11-16T12:00:00Z')
  issue.stateComment = {
    id: 1,
    marker: {
      fingerprint: {
        hash: fingerprintOf(issue, snap),
        at: new Date(now).toISOString(),
      },
    },
  }
  const o = { now, maxSkipDays: 14 }
  assert.deepEqual(retriageDecision(issue, snap, o), {
    retriage: false,
    why: 'unchanged',
  })
  pr.state = 'MERGED'
  assert.deepEqual(retriageDecision(issue, snap, o), {
    retriage: true,
    why: 'changed',
  })
  issue.stateComment = null
  assert.deepEqual(retriageDecision(issue, snap, o), {
    retriage: true,
    why: 'no fingerprint',
  })
})
