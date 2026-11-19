// @ts-check
/** Worktree garbage collection over real git repositories; `graft status` and `ps` are faked. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.mjs'
import { exec as realExec } from '../src/github.mjs'
import {
  collectGarbage,
  describe,
  gcRunner,
  inside,
  lastActivity,
  lockHolds,
  parseWorktrees,
  sessionLock,
} from '../src/gc.mjs'
import { GRAFT_CLEAN, processSpawner } from '../src/workers.mjs'
import { harness } from './fakes.mjs'
import { tick } from '../src/tick.mjs'

const DAY = 24 * 60 * 60_000
const T0 = Date.now()

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/** A clone of a bare origin with one commit on main. */
function repoWithOrigin() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cambium-gc-')))
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'repo')
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  spawnSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(repo, '.gitignore'), '.claude/\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  git(repo, ['remote', 'add', 'origin', origin])
  git(repo, ['push', '-q', 'origin', 'main'])
  git(repo, ['fetch', '-q', 'origin'])
  return { dir, repo }
}

/** @param {string} repo @param {string} name */
function addWorktree(repo, name) {
  const wt = join(repo, '.claude/worktrees', name)
  git(repo, ['worktree', 'add', '-q', '-b', `worktree-${name}`, wt, 'origin/main'])
  return wt
}

/** Every mtime lastActivity reads, set to `at`. @param {string} wt @param {number} at */
function touch(wt, at) {
  const gd = readFileSync(join(wt, '.git'), 'utf8').replace('gitdir: ', '').trim()
  const s = at / 1000
  for (const p of [wt, join(gd, 'HEAD'), join(gd, 'index'), join(gd, 'logs/HEAD'), join(wt, 'a.txt')])
    if (existsSync(p)) utimesSync(p, s, s)
}

/**
 * @param {string} repo @param {string} home
 * @param {{ clean: Set<string>, alive?: Set<number>, lstart?: string, workers?: string[], now?: number }} o
 */
function gcDeps(repo, home, o) {
  const config = resolveConfig({ repos: [{ slug: 'o/r', path: repo }], paths: { home } })
  /** @type {import('../src/github.mjs').Exec} */
  const exec = async (cmd, args, opts) => {
    if (cmd === 'graft') {
      const wt = args[args.indexOf('-C') + 1]
      return `o/r\n${o.clean.has(wt) ? GRAFT_CLEAN : '1 uncommitted path'}\n`
    }
    if (cmd === 'ps') return `${o.lstart ?? ''}\n`
    return realExec(cmd, args, opts)
  }
  return {
    config,
    store: { workers: () => (o.workers ?? []).map((worktree) => /** @type {any} */ ({ repo: 'o/r', worktree })) },
    spawner: processSpawner({
      config,
      exec,
      // No lsof over the host's processes, no signals: nothing works in these temp worktrees.
      sys: {
        holders: () => [],
        stopNxDaemon: () => null,
        erase: (dir) => rmSync(dir, { recursive: true, force: true }),
      },
    }),
    procs: { alive: (/** @type {number} */ pid) => o.alive?.has(pid) ?? false },
    now: () => o.now ?? T0 + 30 * DAY,
    exec,
    stamp: () => 'STAMP',
  }
}

test('parseWorktrees: paths, branches, detached heads, locks with and without reasons, prunable', () => {
  const out = [
    'worktree /r\nHEAD aaa\nbranch refs/heads/main\n',
    'worktree /r/.claude/worktrees/x y\nHEAD bbb\nbranch refs/heads/worktree-x\nlocked claude session x (pid 7 start Wed Nov 18 05:33:58 2026)\n',
    'worktree /r/.claude/worktrees/d\nHEAD ccc\ndetached\nlocked\nprunable gitdir file points to non-existent location\n',
  ].join('\n')
  assert.deepEqual(parseWorktrees(out), [
    { path: '/r', head: 'aaa', branch: 'main', locked: null, prunable: false },
    {
      path: '/r/.claude/worktrees/x y',
      head: 'bbb',
      branch: 'worktree-x',
      locked: 'claude session x (pid 7 start Wed Nov 18 05:33:58 2026)',
      prunable: false,
    },
    { path: '/r/.claude/worktrees/d', head: 'ccc', branch: null, locked: '', prunable: true },
  ])
})

test('sessionLock and inside', () => {
  assert.deepEqual(sessionLock('claude session a-b (pid 12 start Tue Nov 17 03:04:06 2026)'), {
    pid: 12,
    start: 'Tue Nov 17 03:04:06 2026',
  })
  assert.equal(sessionLock('holding this one'), null)
  assert.ok(inside('/r/wt', '/r/wt/a'))
  assert.ok(!inside('/r/wt', '/r/wt'))
  assert.ok(!inside('/r/wt', '/r/other'))
})

test('lockHolds: no lock, a human lock, a live session, a dead pid, a reused pid, an unreadable start', async () => {
  const reason = 'claude session s (pid 7 start Wed Nov 18 05:33:58 2026)'
  /** @param {boolean} alive @param {string} lstart */
  const deps = (alive, lstart) =>
    /** @type {any} */ ({ procs: { alive: () => alive }, exec: async () => `${lstart}    \n` })
  assert.equal(await lockHolds(deps(true, ''), null), false)
  assert.equal(await lockHolds(deps(false, ''), ''), true)
  assert.equal(await lockHolds(deps(false, ''), 'keep me'), true)
  assert.equal(await lockHolds(deps(true, 'Wed Nov 18  5:33:58 2026'), reason), true)
  assert.equal(await lockHolds(deps(false, 'Wed Nov 18 05:33:58 2026'), reason), false)
  assert.equal(await lockHolds(deps(true, 'Thu Nov 19 01:00:00 2026'), reason), false)
  assert.equal(await lockHolds(deps(true, 'garbage'), reason), true)
})

test('lastActivity: the newest of the worktree, its git files and its dirty paths', async () => {
  const { repo } = repoWithOrigin()
  const wt = addWorktree(repo, 'act')
  touch(wt, T0 - 10 * DAY)
  const run = (/** @type {string[]} */ a) => realExec('git', ['-C', wt, ...a])
  const quiet = await lastActivity(run, wt)
  assert.ok(quiet < T0 - DAY, 'only old mtimes')
  writeFileSync(join(wt, 'new.txt'), 'n')
  utimesSync(wt, (T0 - 10 * DAY) / 1000, (T0 - 10 * DAY) / 1000)
  assert.ok((await lastActivity(run, wt)) > T0 - DAY, 'the untracked file counts')
})

test('collectGarbage: removes complete, archives stale, keeps recent work, skips workers, locks and the active', async () => {
  const { dir, repo } = repoWithOrigin()
  const home = join(dir, 'home')
  const now = T0 + 30 * DAY
  const done = addWorktree(repo, 'done')
  const stale = addWorktree(repo, 'stale')
  writeFileSync(join(stale, 'a.txt'), 'changed\n')
  writeFileSync(join(stale, 'scratch.md'), 'notes\n')
  writeFileSync(join(stale, 'b.txt'), 'b\n')
  git(stale, ['add', 'b.txt'])
  git(stale, ['commit', '-q', '-m', 'local only'])
  writeFileSync(join(stale, 'a.txt'), 'changed\n')
  const recent = addWorktree(repo, 'recent')
  writeFileSync(join(recent, 'a.txt'), 'wip\n')
  const active = addWorktree(repo, 'active')
  const worker = addWorktree(repo, 'worker')
  const human = addWorktree(repo, 'human')
  git(repo, ['worktree', 'lock', '--reason', 'keep me', human])
  const live = addWorktree(repo, 'live')
  git(repo, ['worktree', 'lock', '--reason', 'claude session live (pid 11 start Wed Nov 18 05:33:58 2026)', live])
  const dead = addWorktree(repo, 'dead')
  git(repo, ['worktree', 'lock', '--reason', 'claude session dead (pid 12 start Wed Nov 18 05:33:58 2026)', dead])
  const gone = addWorktree(repo, 'gone')
  rmSync(gone, { recursive: true, force: true })
  for (const wt of [done, stale, worker, human, live, dead]) touch(wt, T0)
  touch(recent, now - 5 * DAY)
  touch(active, now - 60_000)

  const clean = new Set([done, active, worker, human, live, dead])
  const deps = gcDeps(repo, home, {
    clean,
    alive: new Set([11]),
    lstart: 'Wed Nov 18 05:33:58 2026',
    workers: [worker],
    now,
  })

  const dry = await collectGarbage(deps, { dryRun: true })
  const byName = (/** @type {import('../src/gc.mjs').Outcome[]} */ out) =>
    Object.fromEntries(out.map((o) => [o.worktree.split('/').at(-1), o.action]))
  const expected = {
    done: 'removed',
    stale: 'archived',
    recent: 'kept',
    active: 'skipped',
    worker: 'skipped',
    human: 'skipped',
    live: 'skipped',
    dead: 'removed',
    gone: 'pruned',
  }
  assert.deepEqual(byName(dry), expected)
  for (const wt of [done, stale, dead]) assert.ok(existsSync(wt), `dry run left ${wt}`)

  const out = await collectGarbage(deps)
  assert.deepEqual(byName(out), expected)
  for (const wt of [done, stale, dead]) assert.ok(!existsSync(wt), `${wt} removed`)
  for (const wt of [recent, active, worker, human, live]) assert.ok(existsSync(wt), `${wt} kept`)
  const listed = git(repo, ['worktree', 'list', '--porcelain'])
  assert.ok(!listed.includes('/gone'), 'pruned')
  const branches = git(repo, ['branch', '--format=%(refname:short)'])
  for (const b of ['worktree-done', 'worktree-stale', 'worktree-dead']) assert.ok(!branches.includes(b), `${b} deleted`)

  const archived = /** @type {string} */ (out.find((o) => o.action === 'archived')?.archive)
  assert.equal(archived, join(home, 'gc', 'o__r', 'stale-STAMP'))
  assert.match(readFileSync(join(archived, 'changes.patch'), 'utf8'), /\+changed/)
  assert.equal(readFileSync(join(archived, 'untracked', 'scratch.md'), 'utf8'), 'notes\n')
  const info = JSON.parse(readFileSync(join(archived, 'worktree.json'), 'utf8'))
  assert.equal(info.branch, 'worktree-stale')
  assert.equal(info.commits, 1)
  assert.match(info.reason, /^stale: idle (29|30)d; 1 uncommitted path$/)
  git(repo, ['fetch', '-q', join(archived, 'commits.bundle'), 'HEAD:restored'])
  assert.equal(git(repo, ['show', 'restored:b.txt']), 'b\n')

  assert.match(describe(out.find((o) => o.action === 'archived') ?? out[0]), /^archived .*stale.*\n {9}archive /)
  assert.deepEqual(await collectGarbage(deps, { repo: 'x/y' }), [])
})

test('gcRunner: one run at a time; what changed is logged', async () => {
  const { dir, repo } = repoWithOrigin()
  const done = addWorktree(repo, 'done')
  touch(done, T0)
  /** @type {string[]} */
  const logged = []
  const run = gcRunner(gcDeps(repo, join(dir, 'home'), { clean: new Set([done]) }), (_l, msg) => logged.push(msg))
  const first = run()
  assert.equal(await run(), null)
  assert.equal((await first)?.[0]?.action, 'removed')
  assert.match(logged[0], /^gc: removed .*done/)
  const broken = gcRunner(/** @type {any} */ ({ config: { repos: [{}] } }), (_l, msg) => logged.push(msg))
  assert.deepEqual(await broken(), [])
  assert.match(logged.at(-1) ?? '', /^gc: /)
})

test('tick: the gc step starts a sweep every gc.everyMinutes, not while paused, never when 0', async () => {
  const h = harness()
  let runs = 0
  h.deps.gc = async () => {
    runs++
  }
  await tick(h.deps)
  await tick(h.deps)
  assert.equal(runs, 1)
  h.clock.advance(61 * 60_000)
  await tick(h.deps)
  assert.equal(runs, 2)
  assert.ok(h.beats.at(-1)?.steps.some((s) => s.name === 'gc' && s.ok))
  h.clock.advance(61 * 60_000)
  h.deps.store.setMode('paused')
  await tick(h.deps)
  assert.equal(runs, 2)
  h.deps.store.setMode('running')
  h.config.gc.everyMinutes = 0
  h.clock.advance(61 * 60_000)
  await tick(h.deps)
  assert.equal(runs, 2)
})

test('config: gc defaults and validation', () => {
  assert.deepEqual(resolveConfig({}).gc, { everyMinutes: 60, graceMinutes: 60, staleDays: 14 })
  assert.equal(resolveConfig({ gc: { staleDays: 3 } }).gc.staleDays, 3)
  assert.throws(() => resolveConfig({ gc: { everyMinutes: -1 } }), /gc\.everyMinutes/)
  assert.throws(() => resolveConfig({ gc: { staleDays: '7' } }), /gc\.staleDays/)
})

test('exec: a child that exits without reading its stdin is judged by its exit code, not EPIPE', async () => {
  const input = 'x'.repeat(4 * 1024 * 1024)
  assert.equal(await realExec('true', [], { input }), '')
  await assert.rejects(realExec('false', [], { input }), /false undefined exited 1/)
})
