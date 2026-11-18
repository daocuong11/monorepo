// @ts-check
/** The pieces under the tick: marker, labels, config, the graft client, store, spawner, launchd. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveConfig } from '../src/config.mjs'
import { graftGitHub, normalize, SNAPSHOT_QUERY } from '../src/github.mjs'
import { byPriorityThenAge, move } from '../src/labels.mjs'
import { plist } from '../src/launchd.mjs'
import {
  effectivePosition,
  enteringDecision,
  graphVersionDecision,
  newMarker,
  parseMarker,
  renderMarker,
  withHistory,
} from '../src/marker.mjs'
import { releaseDue } from '../src/phases/release.mjs'
import { prFor, taskExit } from '../src/phases/task.mjs'
import { openStore } from '../src/store.mjs'
import { rotateLogs, tailFile } from '../src/workers.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'cambium-'))

test('marker: round-trips through the comment, even with "-->" in a failure', () => {
  const m = withHistory(newMarker({ attempt: 2, pr: 9, host: 'mac', lastFailure: 'boom --> |pipe| ```x```' }), {
    at: '2026-11-16T00:00:00.000Z',
    attempt: 1,
    outcome: 'failed',
    reason: 'a|b\nc',
  })
  const body = renderMarker(m, { maxAttempts: 3 })
  assert.equal(body.split('\n')[0].split('-->').length, 2, 'only the marker itself closes its comment')
  assert.deepEqual(parseMarker(body), m)
  assert.match(body, /attempt 2\/3 · PR #9 · host `mac`/)
  assert.match(body, /\| failed \| a\\\|b c \|/)
  assert.equal(parseMarker('no marker here'), null)
  assert.equal(parseMarker('<!-- cambium:state {not json} -->'), null)
})

test('marker v2: the writer emits v2; v1 stages read back as task-graph nodes', () => {
  const v1 = (/** @type {any} */ m) =>
    `<!-- cambium:state ${JSON.stringify({ v: 1, phase: 'task', history: [], ...m })} -->`
  const expected = {
    queued: 'start-worker',
    running: 'worker-running',
    submitted: 'ci-running',
    human: 'to-human',
    done: 'close-out',
  }
  for (const [stage, node] of Object.entries(expected)) {
    const m = parseMarker(v1({ stage, attempt: 2, start: '2026-11-16T00:00:00.000Z' }))
    assert.equal(m?.v, 2)
    assert.equal(m?.graph, 'task')
    assert.equal(m?.node, node, stage)
    assert.equal(m?.status, stage === 'done' ? 'done' : 'waiting')
    assert.equal(m?.stage, stage, 'the stage tick still sees its stage')
    assert.equal(m?.enteredAt, '2026-11-16T00:00:00.000Z')
  }
  const legacy = parseMarker(v1({ stage: 'running', attempt: 1 }))
  assert.ok(legacy)
  const body = renderMarker({ ...legacy, stage: 'submitted' })
  assert.match(body, /"v":2/)
  assert.match(body, /\*\*cambium\*\* · task · ci-running · attempt 1/)
  assert.equal(parseMarker(body)?.node, 'ci-running')

  const graphOwned = newMarker({ graph: 'release', graphVersion: 3, node: 'cut', status: 'entering' })
  assert.equal(graphOwned.stage, undefined, 'a marker placed by node carries no stage')
  assert.deepEqual(parseMarker(renderMarker(graphOwned)), graphOwned)
  assert.match(renderMarker(graphOwned), /release · cut \(entering\)/)
  assert.equal(parseMarker('<!-- cambium:state {"v":3} -->'), null, 'a newer marker is not misread')
})

test('marker v2: history keeps 20 entries with nodes, well under the 65,536-char comment limit', () => {
  let m = newMarker({ stage: 'running', traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` })
  for (let i = 0; i < 25; i++)
    m = withHistory(m, {
      at: new Date(Date.UTC(2026, 10, 16, 0, i)).toISOString(),
      attempt: i + 1,
      outcome: 'failed',
      reason: `ci failed: ${'x'.repeat(300)}`,
      pr: 1000 + i,
      log: `/Users/someone/.cambium/logs/o-r-${i}.out.log`,
      spanId: 'c'.repeat(16),
    })
  assert.equal(m.history.length, 20)
  assert.equal(m.history[0].attempt, 6)
  assert.equal(m.history[0].node, 'worker-running')
  const body = renderMarker(m, { maxAttempts: 3 })
  assert.ok(body.length < 65_536 / 2, `${body.length} chars`)
  assert.deepEqual(parseMarker(body), m)
})

test('marker v2: the queue label beats the marker and restarts at the owning graph’s entry', () => {
  const queues = {
    'q:task': { graph: 'task', entryNode: 'start-worker' },
    'q:human': { graph: 'task', entryNode: 'start-worker', nodes: ['to-human'] },
    'q:release': { graph: 'release', entryNode: 'cut' },
  }
  const running = newMarker({ stage: 'running' })
  assert.deepEqual(effectivePosition(['q:task', 'running'], running, queues), {
    graph: 'task',
    node: 'worker-running',
    reset: false,
  })
  assert.deepEqual(effectivePosition(['q:release'], running, queues), { graph: 'release', node: 'cut', reset: true })
  assert.deepEqual(effectivePosition(['q:human'], running, queues), {
    graph: 'task',
    node: 'start-worker',
    reset: true,
  })
  assert.deepEqual(effectivePosition(['q:human'], newMarker({ stage: 'human' }), queues), {
    graph: 'task',
    node: 'to-human',
    reset: false,
  })
  assert.deepEqual(effectivePosition(['q:task'], newMarker({ stage: 'done' }), queues), {
    graph: 'task',
    node: 'start-worker',
    reset: true,
  })
  assert.deepEqual(effectivePosition(['q:release', 'bug'], null, queues), {
    graph: 'release',
    node: 'cut',
    reset: false,
  })
  assert.deepEqual(effectivePosition(['bug'], running, queues), { graph: 'task', node: 'worker-running', reset: false })
  assert.equal(effectivePosition(['bug'], null, queues), null)
})

test('marker v2: an old graph version keeps running while its node exists, else restarts with a note', () => {
  const m = newMarker({ graph: 'task', graphVersion: 1, node: 'ci-running', attempt: 2 })
  const at = '2026-11-17T00:00:00.000Z'
  const same = { version: 1, nodes: ['start-worker'], entryNode: 'start-worker', at }
  assert.deepEqual(graphVersionDecision(m, same), { action: 'keep' })
  const kept = { version: 2, nodes: ['start-worker', 'ci-running'], entryNode: 'start-worker', at }
  assert.deepEqual(graphVersionDecision(m, kept), { action: 'keep' })
  const gone = graphVersionDecision(m, { version: 2, nodes: new Set(['start-worker']), entryNode: 'start-worker', at })
  assert.equal(gone.action, 'restart')
  if (gone.action !== 'restart') return
  assert.equal(gone.node, 'start-worker')
  assert.deepEqual(
    { ...gone.note, reason: undefined },
    { at, attempt: 2, node: 'ci-running', outcome: 'graph-changed', reason: undefined },
  )
  assert.match(String(gone.note.reason), /task v1 → v2: node ci-running no longer exists; restarting at start-worker/)
})

test('marker v2: entering with no tracked process recovers; anything else resumes', () => {
  const entering = newMarker({ node: 'start-worker', status: 'entering', enteredAt: '2026-11-17T00:00:00.000Z' })
  assert.equal(entering.status, 'entering')
  assert.equal(enteringDecision(entering, false), 'recover')
  assert.equal(enteringDecision(entering, true), 'resume')
  assert.equal(enteringDecision(newMarker({ node: 'ci-running' }), false), 'resume')
})

test('labels: exactly one q:*, running only while leased, why:* only in the Human Queue', () => {
  assert.deepEqual(move(['q:task', 'running', 'bug'], Q_HUMAN, { extra: ['why:budget'] }), {
    add: ['q:human', 'why:budget'],
    remove: ['q:task', 'running'],
  })
  assert.deepEqual(move(['q:human', 'why:budget'], 'q:task'), { add: ['q:task'], remove: ['q:human', 'why:budget'] })
  assert.deepEqual(move(['q:task'], 'q:task', { running: true }), { add: ['running'], remove: [] })
  assert.deepEqual(move(['q:task', 'running'], null), { add: [], remove: ['q:task', 'running'] })
  const sort = byPriorityThenAge(['priority:high', 'priority:low'])
  const items = [
    { n: 1, labels: [], createdAt: '2026-01-01' },
    { n: 2, labels: ['priority:low'], createdAt: '2026-01-02' },
    { n: 3, labels: ['priority:high'], createdAt: '2026-01-03' },
    { n: 4, labels: ['priority:high'], createdAt: '2026-01-02' },
  ]
  assert.deepEqual(
    items.sort(sort).map((i) => i.n),
    [4, 3, 2, 1],
  )
})
const Q_HUMAN = 'q:human'

test('config: defaults, ~ paths, validation', () => {
  const c = resolveConfig({ repos: [{ slug: 'o/r', path: '~/src/r' }], paths: { home: '~/x' } })
  assert.equal(c.tickSeconds, 30)
  assert.equal(c.phases.task.maxAttempts, 3)
  assert.equal(c.phases.task.wallClockMinutes, 60)
  assert.equal(c.repos[0].baseBranch, 'main')
  assert.ok(!c.repos[0].path.startsWith('~'))
  assert.ok(c.paths.db.endsWith('/x/cambium.db'))
  assert.throws(() => resolveConfig({ repos: [{ slug: 'nope', path: '/r' }] }), /owner\/name/)
  assert.throws(() => resolveConfig({ repos: [{ slug: 'o/r' }] }), /needs "path"/)
  assert.throws(() => resolveConfig({ release: { time: '6am' } }), /HH:MM/)
})

const graphqlAnswer = {
  repository: {
    issues: {
      nodes: [
        {
          number: 5,
          title: 'T',
          url: 'u5',
          state: 'OPEN',
          createdAt: '2026-11-01T00:00:00Z',
          body: 'b',
          labels: { nodes: [{ name: 'q:task' }] },
          comments: {
            nodes: [
              { databaseId: 1, body: '<!-- cambium:state {"attempt":9} -->', author: { login: 'impostor' } },
              { databaseId: 2, body: '<!-- cambium:state {"attempt":2} -->', author: { login: 'clock-bot' } },
            ],
          },
        },
      ],
    },
    open: {
      nodes: [
        {
          number: 50,
          url: 'p50',
          headRefName: 'agent/issue-5',
          state: 'OPEN',
          headRefOid: 'abc',
          isInMergeQueue: false,
          headRef: { id: 'x' },
          autoMergeRequest: { enabledAt: 'now' },
          closingIssuesReferences: {
            nodes: [{ number: 6, state: 'OPEN', labels: { nodes: [] }, comments: { nodes: [] } }],
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: 'FAILURE',
                    contexts: {
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          name: 'verify',
                          conclusion: 'FAILURE',
                          detailsUrl: 'd',
                          title: 'red',
                        },
                        { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
                        {
                          __typename: 'StatusContext',
                          context: 'ext',
                          state: 'ERROR',
                          targetUrl: 't',
                          description: 'x',
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
        { number: 51, headRefName: 'human/feature', state: 'OPEN' },
      ],
    },
    merged: { nodes: [] },
  },
}

test('normalize: issues, agent PRs only, failing checks, markers from the bot only', () => {
  const snap = normalize(graphqlAnswer, { botLogin: 'clock-bot' })
  assert.equal(snap.prs.length, 1)
  const [pr] = snap.prs
  assert.equal(pr.checks, 'FAILURE')
  assert.equal(pr.autoMerge, true)
  assert.equal(pr.branchExists, true)
  assert.deepEqual(pr.closes, [6])
  assert.deepEqual(
    pr.failing.map((f) => f.name),
    ['verify', 'ext'],
  )
  assert.equal(snap.issues.get(5)?.stateComment?.id, 2)
  assert.equal(snap.issues.get(5)?.stateComment?.marker.attempt, 2)
  assert.ok(snap.issues.has(6), 'issues a PR closes are in the snapshot too')
  assert.equal(normalize({ data: graphqlAnswer }).issues.get(5)?.stateComment?.id, 1)
  assert.throws(() => normalize({}), /no repository/)
})

test('graft client: every call is one graft invocation, as the Clock App, in the repo', async () => {
  /** @type {{ cmd: string, args: string[], opts: any }[]} */
  const calls = []
  const answers = [JSON.stringify(graphqlAnswer), '', JSON.stringify({ id: 77 }), '', '', '', '', '']
  const config = resolveConfig({ repos: [{ slug: 'o/r', path: '/src/r' }], graft: { app: 'clock-app' } })
  const gh = graftGitHub({
    config,
    exec: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      return /** @type {string} */ (answers.shift())
    },
  })
  const snap = await gh.read('o/r')
  assert.equal(snap.prs.length, 1)
  await gh.label('o/r', 5, { add: ['running'], remove: ['q:human', 'why:budget'] })
  await gh.label('o/r', 5, { add: [], remove: [] })
  assert.equal(await gh.writeState('o/r', 5, null, 'BODY'), 77)
  assert.equal(await gh.writeState('o/r', 5, 77, 'BODY2'), 77)
  await gh.close('o/r', 5, 'bye')
  await gh.close('o/r', 6, 'dup', { reason: 'duplicate' })
  await gh.comment('o/r', 5, 'hello')
  await gh.deleteBranch('o/r', 'agent/issue-5')
  const argv = calls.map((c) => c.args)
  assert.equal(argv[0][0], 'graphql')
  assert.equal(argv[0][1], SNAPSHOT_QUERY)
  assert.deepEqual(JSON.parse(argv[0][3]), {
    owner: 'o',
    name: 'r',
    labels: ['q:intake', 'q:task', 'q:human', 'q:promote'],
    release: false,
    from: '',
    to: '',
  })
  assert.deepEqual(argv.slice(1), [
    ['issue', 'label', '5', '--add', 'running', '--remove', 'q:human,why:budget', '--repo', 'o/r'],
    ['issue', 'comment', '5', '--body-file', '-', '--repo', 'o/r'],
    ['api', 'PATCH', '/repos/o/r/issues/comments/77', '--body', '{"body":"BODY2"}', '--repo', 'o/r'],
    ['issue', 'close', '5', '--body-file', '-', '--repo', 'o/r'],
    ['issue', 'close', '6', '--body-file', '-', '--reason', 'duplicate', '--repo', 'o/r'],
    ['issue', 'comment', '5', '--body-file', '-', '--repo', 'o/r'],
    ['api', 'DELETE', '/repos/o/r/git/refs/heads/agent/issue-5', '--repo', 'o/r'],
  ])
  assert.ok(calls.every((c) => c.cmd === 'graft' && c.opts.cwd === '/src/r' && c.opts.env.GRAFT_APP === 'clock-app'))
  assert.equal(calls[2].opts.input, 'BODY')
  assert.ok(!/mergePullRequest|enablePullRequestAuto/.test(SNAPSHOT_QUERY), 'read only')
})

test('task exit check and PR matching', () => {
  const pr = (/** @type {any} */ p) => ({ branch: 'agent/x', closes: [], state: 'OPEN', headSha: 'a', ...p })
  const snap = /** @type {any} */ ({
    prs: [pr({ number: 1, state: 'CLOSED', closes: [5] }), pr({ number: 2, branch: 'agent/issue-5' })],
  })
  assert.equal(prFor(snap, { issue: 5, branch: 'agent/issue-5' })?.number, 2)
  assert.equal(prFor(snap, { issue: 6 }), null)
  assert.deepEqual(taskExit(null), { ok: false, reason: 'worker exited without a published PR' })
  assert.deepEqual(taskExit(pr({ number: 3 })), { ok: true })
  assert.deepEqual(taskExit(pr({ number: 3, state: 'MERGED' })), { ok: true })
  assert.match(
    String(/** @type {any} */ (taskExit(pr({ number: 3, state: 'CLOSED' }))).reason),
    /closed without merging/,
  )
  assert.match(
    String(/** @type {any} */ (taskExit(pr({ number: 3 }), { failedSha: 'a' })).reason),
    /without pushing a fix/,
  )
})

test('store: workers and mode survive a reopen', () => {
  const db = join(tmp(), 'nested', 'c.db')
  const s = openStore(db)
  assert.equal(s.mode(), 'running')
  s.addWorker({
    repo: 'o/r',
    issue: 1,
    phase: 'task',
    pid: 10,
    worktree: '/w',
    branch: 'agent/issue-1',
    attempt: 2,
    startedAt: 123,
    host: 'mac',
    stdout: 'o',
    stderr: 'e',
  })
  s.markKilled('o/r', 1, 'cap')
  s.setMode('draining')
  assert.throws(() => s.setMode(/** @type {any} */ ('nope')))
  s.close()
  const again = openStore(db)
  assert.equal(again.mode(), 'draining')
  assert.deepEqual(again.worker('o/r', 1), {
    repo: 'o/r',
    issue: 1,
    phase: 'task',
    pid: 10,
    worktree: '/w',
    branch: 'agent/issue-1',
    attempt: 2,
    startedAt: 123,
    host: 'mac',
    stdout: 'o',
    stderr: 'e',
    killedReason: 'cap',
    traceparent: null,
  })
  again.removeWorker('o/r', 1)
  assert.deepEqual(again.workers(), [])
})

test('store: a database from before traceparent gains the column; a worker keeps its traceparent', () => {
  const db = join(tmp(), 'old.db')
  const old = new DatabaseSync(db)
  old.exec(`CREATE TABLE workers (
    repo TEXT NOT NULL, issue INTEGER NOT NULL, phase TEXT NOT NULL, pid INTEGER NOT NULL,
    worktree TEXT NOT NULL, branch TEXT NOT NULL, attempt INTEGER NOT NULL, started_at INTEGER NOT NULL,
    host TEXT NOT NULL, stdout TEXT NOT NULL, stderr TEXT NOT NULL, killed_reason TEXT,
    PRIMARY KEY (repo, issue));
    INSERT INTO workers VALUES ('o/r', 1, 'task', 10, '/w', 'b', 1, 1, 'mac', 'o', 'e', NULL);`)
  old.close()
  const s = openStore(db)
  assert.equal(s.worker('o/r', 1)?.traceparent, null)
  const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
  s.addWorker({ .../** @type {any} */ (s.worker('o/r', 1)), issue: 2, traceparent: tp })
  assert.equal(s.worker('o/r', 2)?.traceparent, tp)
  s.close()
  assert.equal(openStore(db).worker('o/r', 2)?.traceparent, tp, 'reopening runs the migration check again')
})

test('logs: rotation keeps the newest runs per issue; tail reads the end', () => {
  const dir = tmp()
  for (const stamp of ['2026-01-01', '2026-01-03', '2026-01-02'])
    for (const ext of ['out.log', 'err.log', 'prompt.md']) writeFileSync(join(dir, `a1-${stamp}.${ext}`), stamp)
  assert.deepEqual(rotateLogs(dir, 2), ['a1-2026-01-01'])
  assert.equal(readdirSync(dir).length, 6)
  assert.deepEqual(rotateLogs(join(dir, 'missing'), 2), [])
  const f = join(dir, 'x.log')
  writeFileSync(f, Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'))
  assert.equal(tailFile(f, 2), 'line 48\nline 49')
  assert.equal(tailFile(join(dir, 'nope')), '')
})

test('release schedule: once a day at or after its time', () => {
  const at = (/** @type {string} */ s) => new Date(s).getTime()
  assert.equal(releaseDue(at('2026-11-16T05:59:00'), null, '06:00'), false)
  assert.equal(releaseDue(at('2026-11-16T06:01:00'), null, '06:00'), true)
  assert.equal(releaseDue(at('2026-11-16T09:00:00'), at('2026-11-16T06:01:00'), '06:00'), false)
  assert.equal(releaseDue(at('2026-11-17T06:00:00'), at('2026-11-16T06:01:00'), '06:00'), true)
})

test('launchd plist: KeepAlive, RunAtLoad, start --config, escaped', () => {
  const text = plist({
    node: '/usr/local/bin/node',
    bin: '/x/bin/cambium.mjs',
    configPath: '/h/.cambium/config & co.json',
    logsDir: '/h/.cambium/logs',
    home: '/h',
    path: '/usr/bin',
  })
  assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(
    text,
    /<string>start<\/string>\s*<string>--config<\/string>\s*<string>\/h\/.cambium\/config &amp; co.json<\/string>/,
  )
  assert.match(text, /cambium.launchd.err.log/)
  assert.ok(!existsSync('/h'))
})
