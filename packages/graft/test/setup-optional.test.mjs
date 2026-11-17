// @ts-check
/**
 * The parts of `graft setup project` after the base ruleset — each a question,
 * then done — and the policy move, which is one change or none.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  APP_BRANCHES_RULESET,
  appBranchesBody,
  branchPattern,
  ensureAppBranches,
  ensureAutoMerge,
} from '../src/setup/optional.mjs'
import { applyWrites, placePolicy } from '../src/setup/project.mjs'
import { scriptedPrompter } from '../src/setup/prompt.mjs'
import { colorOn, palette } from '../src/setup/style.mjs'

const c = palette(false)

/** A fake `gh`: GET answers from `rulesets`, writes are recorded. */
function fakeAdmin({ rulesets = [], fail = null } = {}) {
  const calls = []
  return {
    calls,
    who: 'you, through gh',
    async api(method, path, body) {
      calls.push({ method, path, body })
      if (fail) throw new Error(fail)
      return method === 'GET' ? rulesets : {}
    },
  }
}

const base = (over = {}) => {
  const lines = []
  return { lines, owner: 'o', repo: 'r', prompt: scriptedPrompter(), say: (l = '') => lines.push(l), c, ...over }
}

test('branchPattern: a prefix in any spelling becomes prefix/**; none or empty is null; refs are refused', () => {
  assert.equal(branchPattern('agent/**'), 'agent/**')
  assert.equal(branchPattern('agent/'), 'agent/**')
  assert.equal(branchPattern('bots/agent'), 'bots/agent/**')
  assert.equal(branchPattern('none'), null)
  assert.equal(branchPattern(''), null)
  assert.throws(() => branchPattern('refs/heads/agent'), /branch prefix/)
})

test('appBranchesBody: creation restricted outside the prefix; people bypass, the App never does', () => {
  const b = appBranchesBody('agent/**')
  assert.deepEqual(b.conditions.ref_name, { include: ['~ALL'], exclude: ['refs/heads/agent/**'] })
  assert.deepEqual(b.rules, [{ type: 'creation' }])
  assert.ok(b.bypass_actors.every((a) => a.actor_type === 'RepositoryRole'))
  assert.deepEqual(b.bypass_actors.map((a) => a.actor_id).sort(), [2, 4, 5])
})

test('ensureAppBranches: already there — nothing asked, nothing written', async () => {
  const admin = fakeAdmin({ rulesets: [{ id: 1, name: APP_BRANCHES_RULESET }] })
  const s = base({ admin })
  assert.equal(await ensureAppBranches(s), 'ok')
  assert.deepEqual(s.prompt.asked, [])
  assert.deepEqual(
    admin.calls.map((x) => x.method),
    ['GET'],
  )
})

test('ensureAppBranches: asked, yes — the ruleset is created', async () => {
  const admin = fakeAdmin()
  const s = base({ admin })
  assert.equal(await ensureAppBranches(s), 'created')
  assert.match(s.prompt.asked[0], /Limit the App/)
  const post = admin.calls.find((x) => x.method === 'POST')
  assert.equal(post?.path, '/repos/o/r/rulesets')
  assert.equal(post?.body.name, APP_BRANCHES_RULESET)
})

test('ensureAppBranches: a branch-creating bot here makes the default no, and says why', async () => {
  const admin = fakeAdmin()
  const s = base({ admin, bots: ['.github/dependabot.yml'] })
  assert.equal(await ensureAppBranches(s), 'skipped')
  assert.match(s.lines.join('\n'), /dependabot\.yml means a bot creates branches/)
  assert.ok(!admin.calls.some((x) => x.method === 'POST'))
})

test('ensureAppBranches: --app-branches answers without asking; gh failing leaves the link', async () => {
  const s = base({ admin: fakeAdmin(), answer: 'bots' })
  assert.equal(await ensureAppBranches(s), 'created')
  assert.deepEqual(s.prompt.asked, [])
  const broken = base({ admin: fakeAdmin({ fail: 'gh is not installed' }) })
  assert.equal(await ensureAppBranches(broken), 'manual')
  assert.match(broken.lines.join('\n'), /settings\/rules/)
})

test('ensureAutoMerge: on already — nothing asked; off — asked, then PATCHed', async () => {
  const on = base({ admin: fakeAdmin(), enabled: true, agentsMerge: true })
  assert.equal(await ensureAutoMerge(on), 'ok')
  assert.deepEqual(on.prompt.asked, [])

  const admin = fakeAdmin()
  const off = base({ admin, enabled: false, agentsMerge: true })
  assert.equal(await ensureAutoMerge(off), 'enabled')
  assert.deepEqual(admin.calls, [{ method: 'PATCH', path: '/repos/o/r', body: { allow_auto_merge: true } }])
})

test('ensureAutoMerge: agents merging nothing makes the default no; --no-auto-merge never asks', async () => {
  const admin = fakeAdmin()
  assert.equal(await ensureAutoMerge(base({ admin, enabled: false, agentsMerge: false })), 'skipped')
  const flagged = base({ admin, enabled: false, agentsMerge: true, answer: false })
  assert.equal(await ensureAutoMerge(flagged), 'skipped')
  assert.deepEqual(flagged.prompt.asked, [])
  assert.deepEqual(admin.calls, [])
})

/** A temp repo root with a package.json holding the policy. */
function repoWithPolicyInPackage() {
  const root = mkdtempSync(join(tmpdir(), 'graft-move-'))
  const pkgText = '{\n  "name": "x",\n  "graft": { "baseBranch": "main" }\n}\n'
  writeFileSync(join(root, 'package.json'), pkgText)
  const writes = placePolicy({ target: '.graft.json', policy: { baseBranch: 'main' }, graftText: null, pkgText })
  return { root, pkgText, writes }
}

test('applyWrites: a move is one question — declined, neither file changes', async () => {
  const { root, pkgText, writes } = repoWithPolicyInPackage()
  try {
    const prompt = scriptedPrompter({ 'Move the policy': false })
    const wrote = await applyWrites(prompt, writes, root, c, { title: 'move the policy to .graft.json' })
    assert.equal(wrote, false)
    assert.deepEqual(prompt.asked, ['Move the policy to .graft.json?'])
    assert.equal(existsSync(join(root, '.graft.json')), false)
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), pkgText)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyWrites: a move accepted writes both halves', async () => {
  const { root, writes } = repoWithPolicyInPackage()
  try {
    const prompt = scriptedPrompter()
    assert.equal(await applyWrites(prompt, writes, root, c, { title: 'move the policy to .graft.json' }), true)
    assert.equal(prompt.asked.length, 1)
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.graft.json'), 'utf8')), { baseBranch: 'main' })
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), { name: 'x' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('colorOn: a terminal colors; NO_COLOR, TERM=dumb and pipes do not; FORCE_COLOR wins over a pipe', () => {
  assert.equal(colorOn({ isTTY: true }, {}), true)
  assert.equal(colorOn({ isTTY: true }, { NO_COLOR: '1' }), false)
  assert.equal(colorOn({ isTTY: true }, { TERM: 'dumb' }), false)
  assert.equal(colorOn({ isTTY: false }, {}), false)
  assert.equal(colorOn({ isTTY: false }, { FORCE_COLOR: '1' }), true)
  assert.equal(colorOn({ isTTY: true }, { FORCE_COLOR: '0' }), false)
  assert.equal(palette(false).ok('x'), '✓ x')
  assert.notEqual(palette(true).ok('x'), '✓ x')
})
