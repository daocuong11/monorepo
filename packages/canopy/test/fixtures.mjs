// @ts-check

export const T0 = Date.parse('2026-11-16T12:00:00.000Z')
export const iso = (/** @type {number} */ ms) => new Date(ms).toISOString()

export function heartbeat(overrides = {}) {
  return {
    version: 1,
    host: 'mac',
    pid: 81234,
    mode: 'running',
    daemon: { startedAt: iso(T0 - 3_600_000), tickSeconds: 30 },
    tick: { n: 42, startedAt: iso(T0 - 1000), finishedAt: iso(T0), durationMs: 812, nextAt: iso(T0 + 30_000) },
    steps: [
      { name: 'read', ok: true, ms: 640, error: null },
      { name: 'reconcile', ok: false, ms: 20_000, error: 'timed out' },
    ],
    counts: { intake: 0, task: 3, human: 1, promote: 0, running: 2, review: 1, workers: 2 },
    caps: { task: 2, dispatch: 0 },
    repos: [
      {
        slug: 'oakgreencc/monorepo',
        ok: true,
        error: null,
        counts: { intake: 0, task: 3, human: 1, promote: 0, running: 2, review: 1 },
      },
    ],
    workers: [
      {
        repo: 'oakgreencc/monorepo',
        issue: 12,
        phase: 'task',
        pid: 90210,
        alive: true,
        attempt: 2,
        branch: 'agent/issue-12',
        worktree: '/tmp/wt/issue-12-a2',
        startedAt: iso(T0 - 1_260_000),
        elapsedMs: 1_260_000,
        wallClockMs: 3_600_000,
        killedReason: null,
        logs: { stdout: '/tmp/logs/a2.out.log', stderr: '/tmp/logs/a2.err.log' },
      },
    ],
    events: [{ at: iso(T0), level: 'info', msg: 'started task worker', repo: 'oakgreencc/monorepo', issue: 12 }],
    ...overrides,
  }
}

const issue = (/** @type {number} */ number, /** @type {string[]} */ labels) => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/oakgreencc/monorepo/issues/${number}`,
  createdAt: iso(T0 - number * 1000),
  updatedAt: iso(T0),
  labels: { nodes: labels.map((name) => ({ name })) },
})

/** A `graft graphql` answer as the queues query returns it. */
export function graphqlAnswer() {
  return {
    repository: {
      issues: {
        nodes: [
          issue(1, ['q:intake']),
          issue(2, ['q:task', 'priority:high']),
          issue(3, ['q:task', 'running']),
          issue(4, ['q:human', 'why:budget']),
          issue(5, ['q:promote']),
          issue(6, ['bug']),
        ],
      },
      pullRequests: {
        nodes: [
          {
            number: 20,
            title: 'feat: thing',
            url: 'https://github.com/oakgreencc/monorepo/pull/20',
            headRefName: 'agent/issue-3',
            isDraft: false,
            isInMergeQueue: true,
            updatedAt: iso(T0),
            autoMergeRequest: { enabledAt: iso(T0) },
            closingIssuesReferences: { nodes: [{ number: 3 }] },
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
          },
          {
            number: 21,
            title: 'human branch',
            url: 'https://github.com/oakgreencc/monorepo/pull/21',
            headRefName: 'jl/fix',
            commits: { nodes: [] },
          },
          {
            number: 22,
            title: 'no checks yet',
            url: 'https://github.com/oakgreencc/monorepo/pull/22',
            headRefName: 'agent/issue-9',
            isDraft: true,
            commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
          },
        ],
      },
    },
  }
}
