// @ts-check
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LABEL_GUIDE_PATH, labelGuide, withPointer } from '../src/label-guide.mjs'
import { QUEUE_LABELS } from '../src/stack.mjs'
import { ALL_LABELS, fakeExec, fakeGithub, run, tempDir } from './helpers.mjs'

const cambiumSrc = join(dirname(fileURLToPath(import.meta.url)), '../../cambium/src')
const git = (/** @type {string} */ url) => fakeExec({ git: () => ({ stdout: `${url}\n` }) })

test('the queue labels cover every label cambium writes', () => {
  const labels = readFileSync(join(cambiumSrc, 'labels.mjs'), 'utf8')
  const health = readFileSync(join(cambiumSrc, 'base-health.mjs'), 'utf8')
  const written = [
    ...[...labels.matchAll(/'((?:q|why|wait):[a-z-]+)'/g)].map((m) => m[1]),
    /RUNNING = '([a-z-]+)'/.exec(labels)?.[1],
    /REPAIR_LABEL = '([a-z-]+)'/.exec(health)?.[1],
  ]
  const ours = QUEUE_LABELS.map((l) => l.name)
  assert.deepEqual(
    [...new Set(written)].filter((l) => !ours.includes(/** @type {string} */ (l))),
    [],
  )
})

test('the guide names every queue label and the configured priorities', () => {
  const md = labelGuide({ priorityLabels: ['p:hi', 'p:lo'] })
  for (const l of QUEUE_LABELS) assert.ok(md.includes(`\`${l.name}\``), l.name)
  assert.match(md, /Priority, at most one: `p:hi`, `p:lo`\./)
  assert.match(md, /\| `ready-for-agent` \| `q:intake`/)
})

test('the pointer joins an existing Agent skills block, else ends the file, once', () => {
  const fresh = withPointer('# Repo\n\nRules.')
  assert.match(fresh ?? '', /Rules\.\n\n## Agent skills\n\n### Triage labels\n\n.*q:intake/)
  assert.equal(withPointer(fresh ?? ''), null)

  const block = withPointer('# R\n\n## Agent skills\n\n### Issue tracker\n\nGitHub.\n') ?? ''
  assert.match(block, /## Agent skills\n\n### Triage labels\n\n.*\n\n### Issue tracker/)
  assert.equal(block.match(/## Agent skills/g)?.length, 1)
})

test('setup from the repo writes the guide and the pointer, then leaves both alone', async () => {
  const home = tempDir()
  const cwd = tempDir({ '.git/HEAD': '', 'AGENTS.md': '# Working here\n' })
  const gh = fakeGithub({ 'o/r': ALL_LABELS.slice() })
  const ports = { home, cwd, env: {}, exec: git('git@github.com:o/r.git').exec, github: gh.client }

  const dry = await run(['setup', '--dry-run'], ports)
  assert.match(dry.out, /would write label guide docs\/agents\/triage-labels\.md/)
  assert.match(dry.out, /would add a Triage labels pointer to AGENTS\.md/)
  assert.equal(existsSync(join(cwd, LABEL_GUIDE_PATH)), false)

  const first = await run(['setup'], ports)
  assert.equal(first.code, 0, first.out)
  assert.match(readFileSync(join(cwd, LABEL_GUIDE_PATH), 'utf8'), /Add `q:intake` and no other label/)
  assert.match(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), /### Triage labels/)
  assert.match(first.out, /Commit docs\/agents\/triage-labels\.md and AGENTS\.md/)

  const agents = readFileSync(join(cwd, 'AGENTS.md'), 'utf8')
  const second = await run(['setup'], ports)
  assert.match(second.out, /= label guide .* exists/)
  assert.match(second.out, /= AGENTS\.md points at the label guide/)
  assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), agents)
})

test('setup keeps a guide from another vocabulary and says to replace it', async () => {
  const cwd = tempDir({ '.git/HEAD': '', 'CLAUDE.md': '', [LABEL_GUIDE_PATH]: '| ready-for-agent |' })
  const gh = fakeGithub({ 'o/r': ALL_LABELS.slice() })
  const r = await run(['setup'], {
    home: tempDir(),
    cwd,
    env: {},
    exec: git('https://github.com/o/r').exec,
    github: gh.client,
  })
  assert.match(r.out, /exists but does not name q:intake; left as is/)
  assert.match(r.out, /Replace docs\/agents\/triage-labels\.md/)
  assert.equal(readFileSync(join(cwd, LABEL_GUIDE_PATH), 'utf8'), '| ready-for-agent |')
})

test('setup outside a clone of the repo writes no guide and says where to run it', async () => {
  const cwd = tempDir({ '.git/HEAD': '' })
  const gh = fakeGithub({ 'o/r': ALL_LABELS.slice() })
  const r = await run(['setup', '--repo', 'o/r'], {
    home: tempDir(),
    cwd,
    env: {},
    exec: git('https://github.com/x/y').exec,
    github: gh.client,
  })
  assert.equal(existsSync(join(cwd, LABEL_GUIDE_PATH)), false)
  assert.match(r.out, /Run oakgreen setup from a clone of o\/r/)
})
