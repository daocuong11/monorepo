// @ts-check
/** Merged, not yet promoted: `q:promote` on the issue while its agent PR is on `from` but not yet in `to`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.mjs'
import { graftGitHub, normalize } from '../src/github.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG } from './fakes.mjs'

/** @param {any} m */
const renderBack = (m) => `<!-- cambium:state ${JSON.stringify(m)} -->`

/**
 * The graph engine with a develop → main repo; `release.enabled` as given. The read adds the comparison:
 * `state.merged` are the PRs on develop not yet in main.
 * @param {{ enabled?: boolean, aheadBy?: number | null, merged?: number[], from?: string }} [seed]
 */
function promoHarness({ enabled = false, aheadBy = 1, merged = [110], from = 'develop' } = {}) {
  const h = harness({
    issues: [{ number: 11, labels: [] }],
    config: {
      engine: 'graph',
      phases: { task: { cap: 0 } },
      repos: [{ slug: SLUG, path: '/repo', baseBranch: from, release: { enabled, time: '00:00', from, to: 'main' } }],
    },
  })
  h.gh.issue(11).comment = {
    id: 7,
    body: renderBack({ v: 1, phase: 'task', stage: 'submitted', queued: true, attempt: 1, pr: 110, history: [] }),
  }
  h.gh.addPr({ number: 110, closes: [11], state: 'MERGED', branch: 'agent/11-x' })
  const state = { aheadBy, merged }
  const base = h.gh.github
  h.deps.github = {
    ...base,
    async read(slug) {
      const snap = await base.read(slug)
      if (from === 'main') return snap
      return {
        ...snap,
        release: {
          from,
          to: 'main',
          aheadBy: state.aheadBy,
          merged: state.merged.map((number) => ({ number, title: `PR ${number}` })),
          prs: [],
        },
      }
    },
  }
  return { ...h, state }
}

test('merged into develop: the issue is closed and waits in q:promote, counted as promote', async () => {
  const h = promoHarness()
  await tick(h.deps)
  assert.equal(h.gh.issue(11).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(11).labels, ['q:promote'])
  assert.equal(h.beats.at(-1)?.counts.promote, 1)
  assert.ok(h.events.some((e) => e.issue === 11 && /waiting for promotion to `main`/.test(e.msg)))
  // Idempotent: the next tick labels nothing again.
  const labels = h.gh.calls.filter((c) => c.op === 'label').length
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'label').length, labels)
})

test('promoted (no longer ahead of main): q:promote comes off, the issue stays closed', async () => {
  const h = promoHarness()
  await tick(h.deps)
  h.state.merged = []
  h.state.aheadBy = 0
  await tick(h.deps)
  assert.equal(h.gh.issue(11).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(11).labels, [])
  assert.equal(h.beats.at(-1)?.counts.promote, 0)
  assert.ok(h.events.some((e) => e.issue === 11 && e.msg === 'promoted to `main`'))
  // Not relabelled once gone.
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(11).labels, [])
})

test('more than 100 commits ahead: an issue whose PR fell out of the comparison keeps q:promote', async () => {
  const h = promoHarness()
  await tick(h.deps)
  h.state.merged = []
  h.state.aheadBy = 150
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(11).labels, ['q:promote'])
})

test('main is missing (aheadBy null): nothing labelled', async () => {
  const h = promoHarness({ aheadBy: null })
  await tick(h.deps)
  assert.equal(h.gh.issue(11).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(11).labels, [])
})

test('no promotion (from = to): merged closes the issue as before, no q:promote', async () => {
  const h = promoHarness({ from: 'main' })
  await tick(h.deps)
  assert.equal(h.gh.issue(11).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(11).labels, [])
})

test('legacy engine: no q:promote', async () => {
  const h = promoHarness()
  h.deps.config.engine = 'legacy'
  await tick(h.deps)
  assert.equal(h.gh.issue(11).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(11).labels, [])
})

test('the read asks for the comparison and the closed q:promote issues whenever from ≠ to, release on or off', async () => {
  /** @type {string[][]} */
  const argv = []
  const answer = {
    repository: {
      issues: { nodes: [] },
      awaiting: {
        nodes: [{ number: 5, title: 'T', url: 'u', state: 'CLOSED', labels: { nodes: [{ name: 'q:promote' }] } }],
      },
      toRef: { compare: { aheadBy: 0, commits: { nodes: [] } } },
    },
  }
  const config = resolveConfig({
    repos: [
      { slug: 'o/r', path: '/src/r', baseBranch: 'develop', release: { enabled: false } },
      { slug: 'o/m', path: '/src/m', baseBranch: 'main' },
    ],
  })
  const gh = graftGitHub({
    config,
    exec: async (_cmd, args) => {
      argv.push(args)
      return JSON.stringify(answer)
    },
  })
  const snap = await gh.read('o/r')
  assert.deepEqual((({ release, from, to }) => [release, from, to])(JSON.parse(argv[0][3])), [true, 'develop', 'main'])
  assert.equal(snap.issues.get(5)?.state, 'CLOSED')
  assert.deepEqual(snap.issues.get(5)?.labels, ['q:promote'])
  await gh.read('o/m')
  assert.equal(JSON.parse(argv[1][3]).release, false)
  assert.equal(normalize({ repository: { awaiting: answer.repository.awaiting } }).issues.get(5)?.number, 5)
})
