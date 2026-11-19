// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { envelope, fingerprint } from '../src/envelope.mjs'
import { issueBody } from '../src/intake.mjs'
import { closeOutcome, createNotifier, intakeOf, NOTIFY_KEY } from '../src/notify.mjs'
import { runLoop } from '../src/runner.mjs'
import { discordChannel, replyTarget } from '../src/sources/discord.mjs'
import { memoryState } from '../src/state.mjs'
import { fakeFetch } from './helpers.mjs'

const GUILD = '900000000000000000'
const FORUM = '900000000000000002'
const THREAD = '900000000000000077'
const NOW = Date.parse('2026-11-19T06:00:00Z')

const forumPost = envelope({
  source: 'discord',
  externalId: THREAD,
  receivedAt: '2026-11-18T20:07:49Z',
  author: 'rider',
  title: 'Delta time before start finish',
  body: 'shows -- until the first lap',
  url: `https://discord.com/channels/${GUILD}/${THREAD}`,
  meta: { channelId: FORUM, rootId: THREAD },
})
const bodyOf = (/** @type {any} */ e) => issueBody(e, fingerprint(e))

/** @param {any[]} issues */
const fakeIssues = (issues) => {
  const calls = /** @type {string[]} */ ([])
  return {
    calls,
    github: {
      issuesSince: async (/** @type {string} */ since) => {
        calls.push(since)
        return issues
      },
    },
  }
}
const recorder = () => {
  const posts = /** @type {any[]} */ ([])
  /** @type {import('../src/notify.mjs').Channel} */
  const channel = {
    filed: async (intake, issue) => {
      posts.push({ step: 'filed', issue: issue.number, url: intake.url })
    },
    closed: async (_intake, issue, outcome) => {
      posts.push({ step: 'closed', issue: issue.number, outcome })
    },
  }
  return { posts, channel }
}

test('intakeOf reads the table mycelium wrote; other bodies are not intents', () => {
  const i = intakeOf(bodyOf(forumPost))
  assert.equal(i?.source, 'discord')
  assert.equal(i?.url, `https://discord.com/channels/${GUILD}/${THREAD}`)
  assert.equal(i?.fields['meta.rootId'], THREAD)
  assert.equal(intakeOf('## Intake\n\n| field | value |\n|---|---|\n| source | `discord` |'), null)
  assert.equal(intakeOf(null), null)
})

test('closeOutcome: reason decides; invalid or no reason never claims a fix', () => {
  assert.equal(closeOutcome({ number: 1, state: 'open' }), null)
  assert.equal(closeOutcome({ number: 1, state: 'closed', state_reason: 'completed' }), 'fixed')
  assert.equal(closeOutcome({ number: 1, state: 'closed', state_reason: 'duplicate' }), 'duplicate')
  assert.equal(
    closeOutcome({ number: 1, state: 'closed', state_reason: 'not_planned', labels: ['duplicate'] }),
    'duplicate',
  )
  assert.equal(
    closeOutcome({ number: 1, state: 'closed', state_reason: 'completed', labels: [{ name: 'invalid' }] }),
    'not-planned',
  )
  assert.equal(closeOutcome({ number: 1, state: 'closed' }), 'not-planned')
})

test('an open intent is acknowledged once; its close posts one outcome note', async () => {
  const issue = { number: 4631, state: 'open', body: bodyOf(forumPost), html_url: 'https://github.com/o/r/issues/4631' }
  const other = { number: 9, state: 'open', body: 'hand-written' }
  const { github, calls } = fakeIssues([issue, other])
  const { posts, channel } = recorder()
  const state = memoryState()
  const n = createNotifier({ github, channels: { discord: channel }, state, backfillMs: 24 * 3_600_000 })

  assert.match(await n.run(NOW), /^notify: 1 acked, 0 closed, 0 failed/)
  assert.equal(calls[0], '2026-11-18T06:00:00.000Z', 'first pass reads back the backfill window')
  assert.match(await n.run(NOW + 60_000), /0 acked, 0 closed/)
  assert.equal(calls[1], '2026-11-19T05:59:00.000Z', 'later passes read from the last pass, less the skew')

  Object.assign(issue, { state: 'closed', state_reason: 'completed' })
  await n.run(NOW + 120_000)
  await n.run(NOW + 180_000)
  assert.deepEqual(posts, [
    { step: 'filed', issue: 4631, url: `https://discord.com/channels/${GUILD}/${THREAD}` },
    { step: 'closed', issue: 4631, outcome: 'fixed' },
  ])
  assert.deepEqual(state.get(NOTIFY_KEY).done, { 4631: 'closed' })
})

test('closed before it was ever acknowledged: only the outcome note', async () => {
  const issue = { number: 5, state: 'closed', state_reason: 'duplicate', body: bodyOf(forumPost) }
  const { posts, channel } = recorder()
  const n = createNotifier({
    github: fakeIssues([issue]).github,
    channels: { discord: channel },
    state: memoryState(),
    backfillMs: 0,
  })
  await n.run(NOW)
  assert.deepEqual(posts, [{ step: 'closed', issue: 5, outcome: 'duplicate' }])
})

test('a source with no channel is left alone; a failed post holds the cursor and is retried', async () => {
  const asc = envelope({ source: 'asc', externalId: 'r1', receivedAt: '2026-11-18T00:00:00Z', meta: { appId: '1' } })
  const issues = [
    { number: 1, state: 'open', body: bodyOf(asc) },
    { number: 2, state: 'open', body: bodyOf(forumPost) },
  ]
  const { github, calls } = fakeIssues(issues)
  let fail = true
  const posted = /** @type {number[]} */ ([])
  const channel = {
    filed: async (/** @type {any} */ _i, /** @type {any} */ issue) => {
      if (fail) throw new Error('discord POST: 403 Missing Permissions')
      posted.push(issue.number)
    },
    closed: async () => {},
  }
  const state = memoryState()
  const n = createNotifier({ github, channels: { discord: channel }, state, backfillMs: 3_600_000 })
  assert.match(await n.run(NOW), /0 acked, 0 closed, 1 failed \(1 intake issues updated\); #2: discord POST: 403/)
  assert.deepEqual(state.get(NOTIFY_KEY), { since: '2026-11-19T05:00:00.000Z', done: {} })
  fail = false
  await n.run(NOW + 60_000)
  assert.equal(calls[1], calls[0], 'the cursor did not move past the failure')
  assert.deepEqual(posted, [2])
})

test('dry run prints the plan and posts nothing', async () => {
  const printed = /** @type {any[]} */ ([])
  const { posts, channel } = recorder()
  const state = memoryState()
  const n = createNotifier({
    github: fakeIssues([{ number: 7, state: 'open', body: bodyOf(forumPost) }]).github,
    channels: { discord: channel },
    state,
    backfillMs: 0,
    dryRun: true,
    print: (r) => printed.push(r),
  })
  await n.run(NOW)
  assert.equal(posts.length, 0)
  assert.equal(state.get(NOTIFY_KEY), null)
  assert.deepEqual(printed, [{ notify: 'discord', issue: 7, step: 'acked', outcome: null, url: forumPost.url }])
})

test('discord channel: a forum post answers in its thread, a channel message as a reply; nobody is pinged', async () => {
  assert.deepEqual(replyTarget(`https://discord.com/channels/${GUILD}/${THREAD}`), { channelId: THREAD, replyTo: null })
  assert.deepEqual(replyTarget(`https://discord.com/channels/${GUILD}/1/2`), { channelId: '1', replyTo: '2' })
  assert.equal(replyTarget('https://example.com/x'), null)

  const { fetch, calls } = fakeFetch(() => ({ id: '1' }))
  const ch = discordChannel({ fetch, config: { token: 't', channels: [], guild: GUILD } })
  const issue = { number: 4631, state: 'open', html_url: 'https://github.com/o/r/issues/4631' }
  await ch.filed(/** @type {any} */ ({ url: `https://discord.com/channels/${GUILD}/${THREAD}` }), issue)
  await ch.closed(/** @type {any} */ ({ url: `https://discord.com/channels/${GUILD}/1/2` }), issue, 'not-planned')
  assert.equal(calls[0].url, `https://discord.com/api/v10/channels/${THREAD}/messages`)
  assert.equal(calls[0].init.method, 'POST')
  const first = JSON.parse(calls[0].init.body)
  assert.equal(
    first.content,
    "Filed as #4631 https://github.com/o/r/issues/4631. You'll get one more message here when it closes.",
  )
  assert.deepEqual(first.allowed_mentions, { parse: [] })
  assert.equal(first.message_reference, undefined)
  const second = JSON.parse(calls[1].init.body)
  assert.equal(calls[1].url, 'https://discord.com/api/v10/channels/1/messages')
  assert.match(second.content, /^\*\*Closed without a fix\.\*\*/)
  assert.deepEqual(second.message_reference, { message_id: '2', fail_if_not_exists: false })
  await assert.rejects(ch.filed(/** @type {any} */ ({ url: null }), issue), /no reply target/)
})

test('runLoop runs jobs after the sources and reports their line', async () => {
  const lines = /** @type {string[]} */ ([])
  const ac = new AbortController()
  const job = {
    name: 'notify',
    intervalMs: 60_000,
    run: async () => {
      ac.abort()
      return 'notify: 1 acked, 0 closed, 0 failed (1 intake issues updated)'
    },
  }
  await runLoop([], {
    intake: /** @type {any} */ ({ reset() {} }),
    state: memoryState(),
    backfillMs: 0,
    sleep: async () => {},
    signal: ac.signal,
    report: (l) => lines.push(l),
    jobs: [job],
  })
  assert.deepEqual(lines, ['notify: 1 acked, 0 closed, 0 failed (1 intake issues updated)'])
})
