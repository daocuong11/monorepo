// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unknownVerbs, verbsNamedIn } from '../src/verb-drift.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('reads fenced code and inline spans, never prose', () => {
  const md = [
    'graft publishes for you',
    '```sh',
    'graft publish x "m" --all  # then graft bogus',
    '```',
    'Run `graft pr merge 7`.',
  ].join('\n')
  assert.deepEqual(verbsNamedIn(md), [
    { line: 3, verb: 'publish', action: null },
    { line: 5, verb: 'pr', action: 'merge' },
  ])
})

test('a double-quoted string inside code is text, not an invocation; help is a builtin', () => {
  assert.deepEqual(unknownVerbs('`graft --version || echo "NO — graft is not on PATH"` `graft help`'), [])
})

test('a noun with a placeholder after it is the noun; flags and placeholders name nothing', () => {
  assert.deepEqual(verbsNamedIn('`graft issue <action>` `graft --version` `graft <verb>`'), [
    { line: 1, verb: 'issue', action: null },
  ])
})

test('an unknown verb, and a known noun with an action it lacks, are drift', () => {
  const md =
    '`graft frobnicate` `graft pr squash 3` `graft issue label 4 --add bug` `graft hook guard-protected` `graft hook nope`'
  assert.deepEqual(unknownVerbs(md), [
    { line: 1, verb: 'frobnicate' },
    { line: 1, verb: 'pr squash' },
    { line: 1, verb: 'hook nope' },
  ])
})

test('the shipped docs name only verbs graft runs', () => {
  const files = [
    'README.md',
    ...['docs', 'skills'].flatMap((d) =>
      readdirSync(join(ROOT, d), { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.md'))
        .map((f) => join(d, f)),
    ),
  ]
  const drift = files.flatMap((f) =>
    unknownVerbs(readFileSync(join(ROOT, f), 'utf8')).map(
      ({ line, verb }) => `${relative(ROOT, join(ROOT, f))}:${line} graft ${verb}`,
    ),
  )
  assert.deepEqual(drift, [])
})
