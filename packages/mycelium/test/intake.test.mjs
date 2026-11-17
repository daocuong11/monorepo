// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { envelope, fingerprint } from '../src/envelope.mjs'
import { createIntake, fence, fingerprintOf, issueBody, issueTitle, LABEL, marker } from '../src/intake.mjs'
import { fakeGithub } from './helpers.mjs'

const review = (/** @type {string} */ id, over = {}) =>
  envelope({
    source: 'asc',
    externalId: id,
    receivedAt: '2026-11-01T12:00:00Z',
    author: 'someone',
    title: 'Crash',
    body: 'It crashes.',
    meta: { appId: '1', rating: 1 },
    ...over,
  })

test('new fingerprint: one issue, fixed template, q:intake label', async () => {
  const gh = fakeGithub()
  const intake = createIntake(gh.client)
  const e = review('R1')
  const a = await intake.plan(e)
  assert.equal(a.action, 'create')
  if (a.action !== 'create') return
  assert.deepEqual(a.labels, [LABEL])
  assert.equal(a.title, '[asc] Crash')
  assert.ok(a.body.startsWith(`${marker(fingerprint(e))}\n## Intake\n`))
  assert.match(a.body, /\| source \| `asc` \|/)
  assert.match(a.body, new RegExp(`\\| fingerprint \\| \`${fingerprint(e)}\` \\|`))
  assert.match(a.body, /\| meta\.rating \| `1` \|/)
  assert.match(a.body, /## Report\n\n```text\nCrash\n\nIt crashes\.\n```/)
  assert.deepEqual(await intake.apply(a), { issue: 100, url: 'https://github.com/o/r/issues/100' })
  assert.equal(gh.byFingerprint(fingerprint(e)).length, 1)
})

test('open intent with the fingerprint: a comment, no new issue', async () => {
  const e = review('R1')
  const gh = fakeGithub([{ number: 7, body: issueBody(e, fingerprint(e)) }])
  const intake = createIntake(gh.client)
  const a = await intake.plan(review('R1', { body: 'Edited: still crashes.' }))
  assert.equal(a.action, 'comment')
  if (a.action !== 'comment') return
  assert.equal(a.issue, 7)
  assert.match(a.body, /Edited: still crashes\./)
  await intake.apply(a)
  assert.equal(gh.state.issues.length, 1)
  assert.deepEqual(
    gh.state.comments.map((c) => c.number),
    [7],
  )
})

test('two envelopes, one fingerprint, one pass: create then comment; intents read once', async () => {
  const gh = fakeGithub()
  const intake = createIntake(gh.client)
  for (const e of [review('R1'), review('R1', { body: 'again' })]) await intake.apply(await intake.plan(e))
  assert.equal(gh.state.issues.length, 1)
  assert.equal(gh.state.comments.length, 1)
  assert.equal(gh.state.reads, 1)
})

test('a marker anywhere but the first line is not an identity', async () => {
  const e = review('R1')
  const fp = fingerprint(e)
  assert.equal(fingerprintOf(`text\n${marker(fp)}`), null)
  assert.equal(fingerprintOf(`${marker(fp)}\nrest`), fp)
  const spoof = review('R2', { body: marker(fp) })
  const gh = fakeGithub([{ number: 9, body: issueBody(spoof, fingerprint(spoof)) }])
  assert.equal((await createIntake(gh.client).plan(e)).action, 'create')
})

test('dry run assume: a planned create makes the next plan a comment, nothing written', async () => {
  const gh = fakeGithub()
  const intake = createIntake(gh.client)
  const a = await intake.plan(review('R1'))
  await intake.assume(a.fingerprint)
  const b = await intake.plan(review('R1'))
  assert.equal(b.action, 'comment')
  assert.equal(gh.state.issues.length, 0)
})

test('untrusted text renders inert: fenced past its own backticks, cells cannot break the table', () => {
  assert.equal(fence('a ```` b'), '`````text\na ```` b\n`````')
  const e = review('R1', { author: '@octocat | x\n`y`', title: 'T'.repeat(300) })
  const body = issueBody(e, fingerprint(e))
  assert.match(body, /\| author \| `@octocat x 'y'` \|/)
  assert.equal(issueTitle(e).length, 120)
  assert.equal(issueTitle(review('R1', { title: '', body: 'line one\nline two' })), '[asc] line one line two')
})
