// @ts-check
/**
 * The prompter without a terminal behaves as if `--yes` were given: defaults
 * are taken, confirmations take theirs, and only a question with no default
 * refuses — naming the flag that answers it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPrompter } from '../src/setup/prompt.mjs'

test('no terminal: a question with a default takes it, no --yes needed', async () => {
  const p = createPrompter({ interactive: false })
  assert.equal(await p.ask('App name', { default: 'acme-agents', flag: '--name' }), 'acme-agents')
})

test('no terminal: a confirmation takes its default — yes to a write, no to an opt-in', async () => {
  const p = createPrompter({ interactive: false })
  assert.equal(await p.confirm('write .graft.json?', { default: true }), true)
  assert.equal(await p.confirm('allow auto-merge?', { default: false }), false)
})

test('questions carry no color codes when the output is not a terminal', async () => {
  const { PassThrough } = await import('node:stream')
  const input = new PassThrough()
  const output = new PassThrough()
  let shown = ''
  output.on('data', (d) => {
    shown += d
  })
  const p = createPrompter({ interactive: true, input, output, env: {} })
  const answer = p.ask('Base branch', { default: 'main' })
  input.write('\n')
  assert.equal(await answer, 'main')
  p.close()
  assert.equal(shown, '? Base branch [main]: ')
})

test('no terminal: a question without a default refuses, naming its flag', async () => {
  const p = createPrompter({ interactive: false })
  await assert.rejects(p.ask('Owner', { flag: '--owner or --org' }), /no terminal to ask on\. Pass --owner or --org\./)
})
