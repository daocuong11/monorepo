// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { graftClient } from '../src/github.mjs'

const recorder = (/** @type {(args: string[]) => any} */ answer) => {
  /** @type {{ cmd: string, args: string[] }[]} */
  const calls = []
  const exec = async (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    calls.push({ cmd, args })
    return JSON.stringify(answer(args))
  }
  return { exec, calls }
}

test('graft client: open intents are one paginated graft api read, PRs dropped', async () => {
  const r = recorder(() => [{ number: 1, body: 'a' }, { number: 2, body: null, pull_request: {} }, { number: 3 }])
  const gh = graftClient({ repo: 'o/r', exec: r.exec })
  assert.deepEqual(await gh.openIntents(), [
    { number: 1, body: 'a' },
    { number: 3, body: '' },
  ])
  assert.deepEqual(r.calls, [
    {
      cmd: 'graft',
      args: [
        'api',
        'GET',
        '/repos/o/r/issues?state=open&labels=q%3Aintake&per_page=100',
        '--repo',
        'o/r',
        '--paginate',
      ],
    },
  ])
})

test('graft client: create and comment are graft api POSTs with JSON bodies', async () => {
  const r = recorder((args) => (args[2].endsWith('/comments') ? { html_url: 'c' } : { number: 5, html_url: 'i' }))
  const gh = graftClient({ repo: 'o/r', exec: r.exec })
  assert.deepEqual(await gh.createIssue({ title: 't', body: 'b', labels: ['q:intake'] }), { number: 5, html_url: 'i' })
  assert.deepEqual(await gh.comment(5, 'hi'), { html_url: 'c' })
  assert.deepEqual(
    r.calls.map((c) => c.args),
    [
      ['api', 'POST', '/repos/o/r/issues', '--repo', 'o/r', '--body', '{"title":"t","body":"b","labels":["q:intake"]}'],
      ['api', 'POST', '/repos/o/r/issues/5/comments', '--repo', 'o/r', '--body', '{"body":"hi"}'],
    ],
  )
})

test('graft client: a malformed repo is refused before any call', () => {
  assert.throws(() => graftClient({ repo: 'nope', exec: async () => '' }), /owner\/name/)
})
