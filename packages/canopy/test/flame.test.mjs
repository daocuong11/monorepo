// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoApproved, flameFrames, flameTree } from '../src/flame.mjs'

const span = (/** @type {Partial<any>} */ o) => ({
  parentSpanId: null,
  status: 'unset',
  attrs: {},
  start: 0,
  end: 0,
  ...o,
})
const check = (/** @type {Record<string, unknown>} */ attrs) =>
  span({ spanId: 'c', name: 'claude_code.tool.blocked_on_user', attrs })

test('autoApproved: config and hook accepts are quiet; a person or a refusal is not', () => {
  assert.equal(autoApproved(check({ decision: 'accept', source: 'config' })), true)
  assert.equal(autoApproved(check({ decision: 'accept', source: 'hook' })), true)
  assert.equal(autoApproved(check({ decision: 'accept', source: 'user_temporary' })), false)
  assert.equal(autoApproved(check({ decision: 'reject', source: 'config' })), false)
  assert.equal(
    autoApproved(span({ spanId: 't', name: 'claude_code.tool', attrs: { decision: 'accept', source: 'config' } })),
    false,
  )
})

test('flameTree: same path folds, parallel children add up, a zero-length parent spans its work', () => {
  const spans = [
    span({ spanId: 'r', name: 'cambium.issue', start: 0, end: 0 }),
    span({ spanId: 'a', parentSpanId: 'r', name: 'claude_code.tool', attrs: { tool_name: 'Bash' }, start: 0, end: 30 }),
    span({
      spanId: 'b',
      parentSpanId: 'r',
      name: 'claude_code.tool',
      attrs: { tool_name: 'Bash' },
      start: 10,
      end: 30,
      status: 'error',
    }),
    span({ spanId: 'c', parentSpanId: 'r', name: 'claude_code.tool', attrs: { tool_name: 'Read' }, start: 0, end: 10 }),
    span({ spanId: 'x', parentSpanId: 'a', name: 'claude_code.tool.execution', start: 5, end: 30 }),
    span({ spanId: 'o', parentSpanId: 'gone', name: 'orphan', start: 0, end: 5 }),
  ]
  const tree = flameTree(spans)
  assert.equal(tree.ms, 65)
  const [issue, orphan] = tree.kids
  assert.equal(issue.label, 'cambium.issue')
  assert.equal(issue.ms, 60)
  assert.equal(orphan.label, 'orphan')
  assert.equal(orphan.x, 60)
  const [bash, read] = issue.kids
  assert.deepEqual([bash.label, bash.ms, bash.count, bash.errors, bash.x], ['claude_code.tool · Bash', 50, 2, 1, 0])
  assert.deepEqual([read.label, read.ms, read.x], ['claude_code.tool · Read', 10, 50])
  assert.equal(bash.kids[0].ms, 25)
})

test('flameFrames: zooms to a key, drops slivers, falls back on an unknown key', () => {
  const spans = [
    span({ spanId: 'r', name: 'root', start: 0, end: 1000 }),
    span({ spanId: 'a', parentSpanId: 'r', name: 'big', start: 0, end: 900 }),
    span({ spanId: 'b', parentSpanId: 'r', name: 'tiny', start: 900, end: 901 }),
  ]
  const tree = flameTree(spans)
  const all = flameFrames(tree, '')
  assert.deepEqual(
    all.frames.map((f) => f.label),
    ['all spans', 'root', 'big'],
  )
  const zoomed = flameFrames(tree, '/root/big')
  assert.equal(zoomed.top.label, 'big')
  assert.deepEqual(
    zoomed.frames.map((f) => [f.label, f.left, f.width, f.level]),
    [['big', 0, 1, 0]],
  )
  assert.equal(flameFrames(tree, '/nope').top, tree)
})
