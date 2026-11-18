// @ts-check
/** The pieces under the tick: marker, labels, config, the graft client, store, spawner, launchd. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.mjs'
import { graftGitHub, normalize, SNAPSHOT_QUERY } from '../src/github.mjs'
import { byPriorityThenAge, move } from '../src/labels.mjs'
import { plist } from '../src/launchd.mjs'
import { newMarker, parseMarker, renderMarker, withHistory } from '../src/marker.mjs'
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
  const answers = [JSON.stringify(graphqlAnswer), '', JSON.stringify({ id: 77 }), '', '', '']
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
  await gh.deleteBranch('o/r', 'agent/issue-5')
  const argv = calls.map((c) => c.args)
  assert.equal(argv[0][0], 'graphql')
  assert.equal(argv[0][1], SNAPSHOT_QUERY)
  assert.deepEqual(JSON.parse(argv[0][3]), {
    owner: 'o',
    name: 'r',
    labels: ['q:intake', 'q:task', 'q:human', 'q:promote'],
  })
  assert.deepEqual(argv.slice(1), [
    ['issue', 'label', '5', '--add', 'running', '--remove', 'q:human,why:budget', '--repo', 'o/r'],
    ['issue', 'comment', '5', '--body-file', '-', '--repo', 'o/r'],
    ['api', 'PATCH', '/repos/o/r/issues/comments/77', '--body', '{"body":"BODY2"}', '--repo', 'o/r'],
    ['issue', 'close', '5', '--body-file', '-', '--repo', 'o/r'],
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
  })
  again.removeWorker('o/r', 1)
  assert.deepEqual(again.workers(), [])
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
