// @ts-check
/** The release-prepare and release-promote graphs, driven by the tick's Release step on `engine: "graph"`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveConfig } from '../src/config.mjs'
import { graftGitHub, normalize } from '../src/github.mjs'
import { toMermaid, validateGraph } from '../src/graph/index.mjs'
import { lastRunKey, releasePrepare, releasePromote } from '../src/graphs/release.mjs'
import { newMarker, parseMarker, renderMarker } from '../src/marker.mjs'
import { tick } from '../src/tick.mjs'
import { runIssue } from '../src/graph-engine.mjs'
import { createTelemetry } from '../src/tracing.mjs'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace'
import { harness, SLUG, T0 } from './fakes.mjs'

const HOUR = 60 * 60 * 1000
const RELEASE = { enabled: true, time: '00:00', from: 'develop', to: 'main' }

/**
 * @typedef {{ number: number, state?: 'OPEN' | 'MERGED' | 'CLOSED', createdAt?: string, head?: string,
 *   base?: string, headSha?: string | null, labels?: string[], approved?: boolean,
 *   comment?: { id: number, body: string } | null, closedWith?: string }} FakePromo
 */

/**
 * The harness on `engine: "graph"` with one repo whose release is on, and a GitHub that also knows the promotion
 * state: `aheadBy`, the merged PRs, and promotion PRs (whose state comment goes through the real marker code).
 * @param {{ aheadBy?: number | null, merged?: { number: number, title: string }[], prs?: FakePromo[],
 *   release?: Partial<typeof RELEASE> }} [seed]
 */
function promoHarness({ aheadBy = 0, merged = [], prs = [], release = {} } = {}) {
  const h = harness({
    config: { engine: 'graph', repos: [{ slug: SLUG, path: '/repo', release: { ...RELEASE, ...release } }] },
  })
  const state = {
    aheadBy,
    merged,
    /** @type {Required<FakePromo>[]} */
    prs: prs.map((p) => ({
      state: 'OPEN',
      createdAt: new Date(T0 - HOUR).toISOString(),
      head: 'develop',
      base: 'main',
      headSha: 'sha-promo',
      labels: [],
      approved: false,
      comment: null,
      closedWith: '',
      ...p,
    })),
  }
  let nextPr = 500
  let nextComment = 9000
  const { calls } = h.gh
  const base = h.gh.github
  const find = (/** @type {number} */ n) => state.prs.find((p) => p.number === n)
  h.deps.github = {
    ...base,
    async read(slug) {
      const snap = await base.read(slug)
      return {
        ...snap,
        release: {
          from: 'develop',
          to: 'main',
          aheadBy: state.aheadBy,
          merged: state.merged.map((m) => ({ ...m })),
          prs: state.prs.map((p) => ({
            number: p.number,
            url: `https://github.com/${SLUG}/pull/${p.number}`,
            title: 'Promote',
            state: p.state,
            createdAt: p.createdAt,
            head: p.head,
            base: p.base,
            headSha: p.headSha,
            labels: [...p.labels],
            approved: p.approved,
            autoMerge: false,
            stateComment: p.comment
              ? { id: p.comment.id, marker: /** @type {any} */ (parseMarker(p.comment.body)) }
              : null,
          })),
        },
      }
    },
    async label(slug, n, change) {
      const p = find(n)
      if (!p) return base.label(slug, n, change)
      calls.push({ op: 'label', args: [slug, n, change] })
      p.labels = [...p.labels.filter((l) => !change.remove.includes(l)), ...change.add]
    },
    async writeState(slug, n, id, body) {
      const p = find(n)
      if (!p) return base.writeState(slug, n, id, body)
      calls.push({ op: 'writeState', args: [slug, n, id, body] })
      if (id && p.comment?.id !== id) throw new Error(`no comment ${id}`)
      p.comment = { id: id ?? nextComment++, body }
      return p.comment.id
    },
    async openPull(slug, pr) {
      calls.push({ op: 'openPull', args: [slug, pr] })
      const number = nextPr++
      state.prs.push({
        number,
        state: 'OPEN',
        createdAt: new Date(h.clock.now()).toISOString(),
        head: pr.head,
        base: pr.base,
        headSha: 'sha-new',
        labels: [],
        approved: false,
        comment: null,
        closedWith: '',
      })
      return { number, url: `https://github.com/${slug}/pull/${number}` }
    },
    async editPull(slug, n, change) {
      calls.push({ op: 'editPull', args: [slug, n, change] })
    },
    async closePull(slug, n, comment) {
      calls.push({ op: 'closePull', args: [slug, n, comment] })
      const p = /** @type {Required<FakePromo>} */ (find(n))
      p.state = 'CLOSED'
      p.closedWith = comment
    },
    async mergePull(slug, n) {
      calls.push({ op: 'mergePull', args: [slug, n] })
      if (refuse) throw new Error(refuse)
    },
  }
  /** @type {string | null} */
  let refuse = null
  return {
    ...h,
    state,
    pr: (/** @type {number} */ n) => /** @type {Required<FakePromo>} */ (find(n)),
    marker: (/** @type {number} */ n) => parseMarker(find(n)?.comment?.body),
    ops: () => calls.filter((c) => c.op !== 'read').map((c) => c.op),
    refuseMerges: (/** @type {string | null} */ why) => {
      refuse = why
    },
  }
}

/** A rendered state comment for a promotion PR. @param {number} id @param {Partial<import('../src/marker.mjs').Marker>} m */
const comment = (id, m) => ({ id, body: renderMarker(newMarker({ phase: 'release', ...m })) })

// ---- Shape

test('release graphs: valid, no wait in release-prepare, one wait in release-promote, no timeout anywhere', () => {
  assert.deepEqual(validateGraph(releasePrepare), [])
  assert.deepEqual(validateGraph(releasePromote), [])
  assert.deepEqual(
    releasePrepare.nodes.map((n) => [n.name, n.kind]),
    [
      ['cleanup', 'node'],
      ['prepare', 'node'],
    ],
  )
  assert.deepEqual(
    releasePromote.nodes.map((n) => [n.name, n.kind]),
    [
      ['merge', 'node'],
      ['merging', 'wait'],
      ['promoted', 'node'],
      ['abandoned', 'node'],
    ],
  )
  assert.equal(releasePromote.entry.queue, 'q:promote')
  assert.ok(
    ![...releasePrepare.nodes, ...releasePromote.nodes].some((n) => /timeout|stall|expire/i.test(n.name)),
    'no timeout node',
  )
})

test('README shows both release graphs exactly as toMermaid renders them', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const g of [releasePrepare, releasePromote])
    assert.ok(readme.includes(`\`\`\`mermaid\n${toMermaid(g)}\`\`\``), `regenerate the ${g.name} diagram`)
})

test('config: per-repo release defaults to the top-level one, from the base branch to main', () => {
  const c = resolveConfig({
    release: { enabled: true, time: '07:30' },
    repos: [
      { slug: 'a/b', path: '/x', baseBranch: 'develop' },
      { slug: 'c/d', path: '/y', release: { enabled: false, to: 'prod' } },
    ],
  })
  assert.deepEqual(c.repos[0].release, { enabled: true, time: '07:30', from: 'develop', to: 'main' })
  assert.deepEqual(c.repos[1].release, { enabled: false, time: '07:30', from: 'main', to: 'prod' })
  assert.throws(() => resolveConfig({ repos: [{ slug: 'a/b', path: '/x', release: { time: '7' } }] }), /HH:MM/)
})

// ---- release-prepare

test('prepare opens the promotion PR listing the merged PRs, labels it q:promote, writes the marker, exits', async () => {
  const h = promoHarness({
    aheadBy: 3,
    merged: [
      { number: 11, title: 'feat: a' },
      { number: 12, title: 'fix: b' },
    ],
  })
  await tick(h.deps)
  const open = h.gh.calls.find((c) => c.op === 'openPull')
  assert.ok(open, 'a PR was opened')
  const [, spec] = open.args
  assert.equal(spec.head, 'develop')
  assert.equal(spec.base, 'main')
  assert.equal(spec.title, 'Promote develop → main')
  assert.match(spec.body, /3 commits ahead/)
  assert.match(spec.body, /- #11 feat: a\n- #12 fix: b/)
  assert.deepEqual(h.pr(500).labels, ['q:promote'])
  const m = h.marker(500)
  assert.equal(m?.graph, 'release-prepare')
  assert.equal(m?.node, 'prepare')
  assert.equal(m?.status, 'done')
  assert.equal(m?.pr, 500)
  assert.equal(m?.history.at(-1)?.outcome, 'opened')
  assert.equal(h.deps.store.get(lastRunKey(SLUG)), String(T0))

  // Once a day: the next tick neither opens nor refreshes anything.
  const before = h.ops().length
  await tick(h.deps)
  assert.equal(h.ops().length, before)
})

test('traced: prepare is a root its PR takes into the marker; the promote turns continue that trace', async () => {
  const h = promoHarness({ aheadBy: 1, merged: [{ number: 11, title: 'feat: a' }] })
  const exporter = new InMemorySpanExporter()
  h.deps.telemetry = await createTelemetry({ env: {}, exporter, now: () => h.clock.now() })
  await tick(h.deps)
  const tp = h.marker(500)?.traceparent
  assert.ok(tp, 'the promotion PR carries the prepare trace')
  h.pr(500).approved = true
  h.clock.advance(HOUR)
  await tick(h.deps)
  assert.equal(h.marker(500)?.node, 'merging')
  assert.equal(h.marker(500)?.traceparent, tp)
  await h.deps.telemetry.flush()
  const spans = exporter.getFinishedSpans()
  const trace = tp.split('-')[1]
  assert.ok(spans.every((s) => s.spanContext().traceId === trace))
  assert.deepEqual(
    spans
      .filter((s) => s.name === 'cambium.node')
      .map((s) => [s.attributes['cambium.graph'], s.attributes['cambium.node']]),
    [
      ['release-prepare', 'cleanup'],
      ['release-prepare', 'prepare'],
      ['release-promote', 'merge'],
    ],
  )
  assert.equal(spans.find((s) => s.attributes['cambium.node'] === 'merge')?.attributes['cambium.issue.number'], 500)
})

test('prepare refreshes a fresh open promotion PR instead of opening another', async () => {
  const h = promoHarness({ aheadBy: 1, merged: [{ number: 13, title: 'c' }], prs: [{ number: 40 }] })
  await tick(h.deps)
  assert.deepEqual(h.ops(), ['editPull', 'writeState', 'label'])
  assert.match(h.gh.calls.find((c) => c.op === 'editPull')?.args[2].body, /1 commit ahead\.[\s\S]*- #13 c/)
  assert.deepEqual(h.pr(40).labels, ['q:promote'])
  assert.equal(h.marker(40)?.history.at(-1)?.outcome, 'updated')
})

test('nothing ahead: no PR, no write, a log line', async () => {
  const h = promoHarness({ aheadBy: 0 })
  await tick(h.deps)
  assert.deepEqual(h.ops(), [])
  assert.ok(h.events.some((e) => e.msg === 'release: `develop` is not ahead of `main`; nothing to promote'))
})

test('cleanup closes an unmerged promotion PR older than 24 h, with a comment, then prepares a fresh one', async () => {
  const h = promoHarness({
    aheadBy: 2,
    prs: [
      {
        number: 41,
        createdAt: new Date(T0 - 25 * HOUR).toISOString(),
        labels: ['q:promote'],
        comment: comment(7001, { graph: 'release-prepare', node: 'prepare', status: 'done', pr: 41 }),
      },
      // Not a promotion PR (another head, no marker): left alone however old.
      { number: 42, head: 'feature', createdAt: new Date(T0 - 99 * HOUR).toISOString() },
    ],
  })
  await tick(h.deps)
  assert.equal(h.pr(41).state, 'CLOSED')
  assert.match(h.pr(41).closedWith, /^Closed by cambium: not merged within 24 h \(opened 25 h ago\)/)
  assert.deepEqual(h.pr(41).labels, [], 'q:promote is taken off')
  assert.equal(h.marker(41)?.history.at(-1)?.outcome, 'stale-closed')
  assert.equal(h.marker(41)?.status, 'done')
  assert.equal(h.pr(42).state, 'OPEN')
  assert.deepEqual(h.ops(), ['writeState', 'label', 'closePull', 'openPull', 'writeState', 'label'])
  assert.deepEqual(h.pr(500).labels, ['q:promote'])
})

test('cleanup is the only 24 h rule: a 23 h old PR stays open', async () => {
  const h = promoHarness({ aheadBy: 0, prs: [{ number: 43, createdAt: new Date(T0 - 23 * HOUR).toISOString() }] })
  await tick(h.deps)
  assert.equal(h.pr(43).state, 'OPEN')
  assert.deepEqual(h.ops(), [])
})

test('release off, or from === to: the graphs do nothing', async () => {
  for (const release of [{ enabled: false }, { from: 'main' }]) {
    const h = promoHarness({ aheadBy: 5, release })
    await tick(h.deps)
    assert.deepEqual(h.ops(), [])
    assert.equal(h.deps.store.get(lastRunKey(SLUG)), null)
  }
})

// ---- release-promote

test('promote: an approved q:promote PR is merged through graft, waits at merging, exits on merge', async () => {
  const h = promoHarness({
    prs: [
      {
        number: 44,
        labels: ['q:promote'],
        approved: true,
        comment: comment(7002, { graph: 'release-prepare', node: 'prepare', status: 'done', pr: 44 }),
      },
    ],
  })
  await tick(h.deps)
  assert.deepEqual(
    h.gh.calls.filter((c) => c.op === 'mergePull').map((c) => c.args),
    [[SLUG, 44]],
  )
  assert.equal(h.marker(44)?.graph, 'release-promote')
  assert.equal(h.marker(44)?.node, 'merging')
  assert.deepEqual(h.pr(44).labels, ['q:promote'])

  // Still open (checks running): hold, no second merge — and no timeout, however long it takes.
  h.clock.advance(20 * HOUR)
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'mergePull').length, 1)
  assert.equal(h.marker(44)?.node, 'merging')

  h.pr(44).state = 'MERGED'
  await tick(h.deps)
  assert.equal(h.marker(44)?.node, 'promoted')
  assert.equal(h.marker(44)?.status, 'done')
  assert.equal(h.marker(44)?.history.at(-1)?.outcome, 'merged')
  assert.deepEqual(h.pr(44).labels, [], 'q:promote is taken off')
  const before = h.ops().length
  await tick(h.deps)
  assert.equal(h.ops().length, before, 'nothing left to do')
})

test('promote: not approved, nothing happens', async () => {
  const h = promoHarness({ prs: [{ number: 45, labels: ['q:promote'] }] })
  await tick(h.deps)
  assert.deepEqual(h.ops(), [])
})

test('promote: closed unmerged while merging exits at abandoned and takes q:promote off', async () => {
  const h = promoHarness({
    prs: [
      {
        number: 46,
        state: 'CLOSED',
        labels: ['q:promote'],
        comment: comment(7003, { graph: 'release-promote', node: 'merging', pr: 46 }),
      },
    ],
  })
  await tick(h.deps)
  assert.equal(h.marker(46)?.node, 'abandoned')
  assert.equal(h.marker(46)?.status, 'done')
  assert.equal(h.marker(46)?.history.at(-1)?.outcome, 'closed-unmerged')
  assert.deepEqual(h.pr(46).labels, [])
  assert.deepEqual(h.ops(), ['writeState', 'label'])
})

test('promote: a refused merge is recorded and not retried on the same head', async () => {
  const h = promoHarness({ prs: [{ number: 47, labels: ['q:promote'], approved: true }] })
  h.refuseMerges('graft pr merge exited 1: refusing to merge o/r#47')
  await tick(h.deps)
  assert.equal(h.marker(47)?.node, 'merge')
  assert.equal(h.marker(47)?.failedSha, 'sha-promo')
  assert.match(String(h.marker(47)?.lastFailure), /refusing to merge/)
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'mergePull').length, 1)
  h.refuseMerges(null)
  h.pr(47).headSha = 'sha-pushed'
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'mergePull').length, 2)
  assert.equal(h.marker(47)?.node, 'merging')
})

test("run release-prepare: prepares now, whatever the clock, and counts as the day's run", async () => {
  const h = promoHarness({ aheadBy: 1, merged: [{ number: 11, title: 'feat: a' }], release: { time: '23:59' } })
  /** @type {string[]} */
  const out = []
  const r = await runIssue(h.deps, { graph: 'release-prepare', slug: SLUG, out: (l) => out.push(l) })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(h.pr(500).labels, ['q:promote'])
  assert.equal(h.marker(500)?.node, 'prepare')
  assert.equal(h.deps.store.get(lastRunKey(SLUG)), String(T0))
  assert.deepEqual(out, [`${SLUG} release-prepare: prepare → end`])
})

test('run release-promote: merges the approved q:promote PR, reports one not ready, refuses a non-promotion PR', async () => {
  const h = promoHarness({
    prs: [
      { number: 44, labels: ['q:promote'], approved: true },
      { number: 45, labels: ['q:promote'] },
    ],
  })
  /** @type {string[]} */
  const out = []
  const r = await runIssue(h.deps, { graph: 'release-promote', slug: SLUG, out: (l) => out.push(l) })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(
    h.gh.calls.filter((c) => c.op === 'mergePull').map((c) => c.args),
    [[SLUG, 44]],
  )
  assert.equal(h.marker(44)?.node, 'merging')
  assert.deepEqual(out, ['PR #44: merging', 'PR #45: not ready (not approved, open)'])

  h.pr(44).state = 'MERGED'
  out.length = 0
  assert.deepEqual(
    await runIssue(h.deps, { graph: 'release-promote', slug: SLUG, number: 44, out: (l) => out.push(l) }),
    {
      ok: true,
    },
  )
  assert.equal(h.marker(44)?.node, 'promoted')
  assert.equal(out.length, 1)
  assert.match(out[0], /^PR #44: promoted/)

  const bad = await runIssue(h.deps, { graph: 'release-promote', slug: SLUG, number: 9, out: () => {} })
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /#9 is not a promotion PR/)
})

test('legacy engine keeps the release stub: no promotion PR is touched', async () => {
  const h = promoHarness({ aheadBy: 4, prs: [{ number: 48, labels: ['q:promote'], approved: true }] })
  h.deps.config.engine = 'legacy'
  await tick(h.deps)
  assert.deepEqual(h.ops(), [])
})

// ---- The GitHub seam

test('normalize: the promotion part of the answer', () => {
  const marker = renderMarker(newMarker({ graph: 'release-promote', node: 'merging', phase: 'release', pr: 7 }))
  const promo = (/** @type {any} */ p) => ({
    url: 'u',
    title: 'Promote',
    state: 'OPEN',
    createdAt: '2026-11-16T00:00:00Z',
    headRefName: 'develop',
    baseRefName: 'main',
    headRefOid: 'abc',
    reviewDecision: null,
    autoMergeRequest: null,
    latestReviews: { nodes: [] },
    labels: { nodes: [{ name: 'q:promote' }] },
    comments: { nodes: [] },
    ...p,
  })
  const snap = normalize(
    {
      repository: {
        issues: { nodes: [] },
        open: { nodes: [] },
        merged: { nodes: [] },
        promoteRef: {
          nodes: [
            promo({
              number: 7,
              reviewDecision: 'APPROVED',
              comments: { nodes: [{ databaseId: 70, body: marker, author: { login: 'bot' } }] },
            }),
          ],
        },
        promoteLabelled: {
          nodes: [
            promo({ number: 7 }),
            promo({ number: 8, latestReviews: { nodes: [{ state: 'APPROVED' }] } }),
            promo({ number: 9, latestReviews: { nodes: [{ state: 'APPROVED' }, { state: 'CHANGES_REQUESTED' }] } }),
          ],
        },
        toRef: {
          compare: {
            aheadBy: 4,
            commits: {
              nodes: [
                {
                  associatedPullRequests: {
                    nodes: [{ number: 11, title: 'a', baseRefName: 'develop', state: 'MERGED' }],
                  },
                },
                {
                  associatedPullRequests: {
                    nodes: [{ number: 11, title: 'a', baseRefName: 'develop', state: 'MERGED' }],
                  },
                },
                {
                  associatedPullRequests: { nodes: [{ number: 5, title: 'x', baseRefName: 'main', state: 'MERGED' }] },
                },
                {
                  associatedPullRequests: {
                    nodes: [{ number: 12, title: 'b', baseRefName: 'develop', state: 'MERGED' }],
                  },
                },
              ],
            },
          },
        },
      },
    },
    { release: { from: 'develop', to: 'main' } },
  )
  const r = snap.release
  assert.ok(r)
  assert.equal(r.aheadBy, 4)
  assert.deepEqual(r.merged, [
    { number: 11, title: 'a' },
    { number: 12, title: 'b' },
  ])
  assert.deepEqual(
    r.prs.map((p) => [p.number, p.approved]),
    [
      [7, true],
      [8, true],
      [9, false],
    ],
  )
  assert.equal(r.prs[0].stateComment?.marker.node, 'merging')
  assert.equal(r.prs[0].stateComment?.id, 70)
  assert.equal(
    normalize({ repository: { toRef: null } }, { release: { from: 'develop', to: 'main' } }).release?.aheadBy,
    null,
  )
  assert.equal(normalize({ repository: {} }).release, undefined, 'no release asked, none read')
})

test('graft client: the promotion writes, and the read asks for the repo release', async () => {
  /** @type {string[][]} */
  const argv = []
  /** @type {(string | undefined)[]} */
  const inputs = []
  const answers = [
    JSON.stringify({ repository: { toRef: { compare: { aheadBy: 0, commits: { nodes: [] } } } } }),
    JSON.stringify({ number: 90, html_url: 'h90' }),
    '',
    '',
    '',
    '',
  ]
  const config = resolveConfig({
    repos: [{ slug: 'o/r', path: '/src/r', baseBranch: 'develop', release: { enabled: true } }],
  })
  const gh = graftGitHub({
    config,
    exec: async (_cmd, args, opts) => {
      argv.push(args)
      inputs.push(opts?.input)
      return /** @type {string} */ (answers.shift())
    },
  })
  const snap = await gh.read('o/r')
  assert.equal(snap.release?.aheadBy, 0)
  const vars = JSON.parse(argv[0][3])
  assert.deepEqual([vars.release, vars.from, vars.to], [true, 'develop', 'main'])
  assert.deepEqual(await gh.openPull('o/r', { head: 'develop', base: 'main', title: 'T', body: 'B' }), {
    number: 90,
    url: 'h90',
  })
  await gh.editPull('o/r', 90, { title: 'T2', body: 'B2' })
  await gh.closePull('o/r', 90, 'stale')
  await gh.mergePull('o/r', 90)
  assert.deepEqual(argv.slice(1), [
    [
      'api',
      'POST',
      '/repos/o/r/pulls',
      '--body',
      '{"head":"develop","base":"main","title":"T","body":"B"}',
      '--repo',
      'o/r',
    ],
    ['api', 'PATCH', '/repos/o/r/pulls/90', '--body', '{"title":"T2","body":"B2"}', '--repo', 'o/r'],
    ['issue', 'comment', '90', '--body-file', '-', '--repo', 'o/r'],
    ['api', 'PATCH', '/repos/o/r/pulls/90', '--body', '{"state":"closed"}', '--repo', 'o/r'],
    ['pr', 'merge', '90', '--auto', '--repo', 'o/r'],
  ])
  assert.equal(inputs[3], 'stale')
})
