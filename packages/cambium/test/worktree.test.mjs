// @ts-check
/** The worktree convention, the spawner's create/teardown, and the prepare step. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.mjs'
import { branchName, readConvention, resolveConvention, slugify, topicOf } from '../src/convention.mjs'
import { hydrate, installState, PREPARE_FAILED, prepare } from '../src/prepare.mjs'
import { childrenOf, cwdHolders, GRAFT_CLEAN, nxDaemonOf, processSpawner, workerArgs } from '../src/workers.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'cambium-'))

// ---- convention

test('convention: defaults when the repo says nothing', () => {
  const repo = tmp()
  const c = readConvention(repo)
  assert.deepEqual(c, {
    root: join(repo, '.claude/worktrees'),
    branch: 'agent/{issue}-{slug}',
    install: 'pnpm install --frozen-lockfile',
    hydrate: { dirs: [], files: [] },
    prepare: [],
  })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x' }))
  assert.deepEqual(readConvention(repo), c)
})

test('convention: the "cambium" key overrides field by field; hydrate:false and install:false switch off', () => {
  const repo = tmp()
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({
      cambium: {
        worktree: { branch: 'bot/{slug}-{issue}' },
        hydrate: { dirs: ['packages/fixtures/data'], files: ['apps/mobile/.env'] },
        prepare: ['pnpm build'],
      },
    }),
  )
  const c = readConvention(repo)
  assert.equal(c.root, join(repo, '.claude/worktrees'))
  assert.equal(c.branch, 'bot/{slug}-{issue}')
  assert.equal(c.install, 'pnpm install --frozen-lockfile')
  assert.deepEqual(c.hydrate, { dirs: ['packages/fixtures/data'], files: ['apps/mobile/.env'] })
  assert.deepEqual(c.prepare, ['pnpm build'])
  const off = resolveConvention({ hydrate: false, install: false, worktree: { root: '/abs/wt' } }, repo)
  assert.deepEqual(off.hydrate, { dirs: [], files: [] })
  assert.equal(off.install, null)
  assert.equal(off.root, '/abs/wt')
})

test('convention: unknown keys and wrong types are clear errors', () => {
  const bad = (/** @type {unknown} */ raw, /** @type {RegExp} */ re) =>
    assert.throws(() => resolveConvention(raw, '/r'), re)
  bad('x', /"cambium": must be an object/)
  bad({ worktrees: {} }, /unknown key worktrees/)
  bad({ worktree: { root: '.wt', dir: 'x' } }, /unknown key worktree\.dir/)
  bad({ worktree: { branch: 'agent/{slug}' } }, /containing \{issue\}/)
  bad({ worktree: { branch: 'agent/{issue}-{title}' } }, /unknown placeholder \{title\}/)
  bad({ worktree: { branch: 'agent/{issue} x' } }, /not a valid branch name/)
  bad({ worktree: { root: '' } }, /worktree\.root/)
  bad({ install: 3 }, /install must be/)
  bad({ hydrate: true }, /hydrate must be an object or false/)
  bad({ hydrate: { dirs: 'data' } }, /hydrate\.dirs must be an array/)
  bad({ hydrate: { dirs: ['../outside'] } }, /hydrate\.dirs\[0\] must be a relative path/)
  bad({ hydrate: { files: ['/etc/passwd'] } }, /hydrate\.files\[0\]/)
  bad({ prepare: 'pnpm build' }, /prepare must be an array/)
  const repo = tmp()
  writeFileSync(join(repo, 'package.json'), '{ nope')
  assert.throws(() => readConvention(repo), /package\.json/)
})

test('branch names: slug from the title, kebab, bounded; topic is the branch less its prefix', () => {
  assert.equal(slugify('Fix: the  Tick — when GitHub is down!'), 'fix-the-tick-when-github-is-down')
  assert.equal(slugify('🙂'), 'task')
  const long = slugify('a very long issue title that keeps going well past forty characters')
  assert.ok(long.length <= 40 && !long.endsWith('-'), long)
  assert.equal(long, 'a-very-long-issue-title-that-keeps-going')
  assert.equal(branchName('agent/{issue}-{slug}', 12, 'Add the thing'), 'agent/12-add-the-thing')
  assert.equal(topicOf('agent/12-add-the-thing'), '12-add-the-thing')
  assert.equal(topicOf('bot/x/12'), 'x-12')
  assert.equal(topicOf('12-plain'), '12-plain')
})

// ---- spawner: create and teardown

/**
 * A spawner over a fake `exec`: `git worktree add` makes the directory (with
 * an AGENTS.md), `graft status` ends with `status`. The worktree seams land in `calls` as `['sys', …]`;
 * `holders` is what the in-use check finds.
 *
 * @param {{ config: import('../src/config.mjs').Config, status?: string, holders?: number[] }} o
 */
function spawnerWith({ config, status = GRAFT_CLEAN, holders = [] }) {
  /** @type {string[][]} */
  const calls = []
  /** @type {import('../src/workers.mjs').WorktreeSys} */
  const sys = {
    holders: (wt) => {
      calls.push(['sys', 'holders', wt])
      return holders
    },
    stopNxDaemon: (wt) => {
      calls.push(['sys', 'stop-nx', wt])
      return null
    },
    erase: (dir) => {
      calls.push(['sys', 'erase', dir])
      rmSync(dir, { recursive: true, force: true })
    },
  }
  /** @type {any[]} */
  const spawned = []
  const spawner = processSpawner({
    config,
    sys,
    stamp: () => '2026-11-16T12-00-00-000Z',
    exec: async (cmd, args) => {
      calls.push([cmd, ...args])
      if (args.includes('add')) {
        const wt = args[args.length - 2]
        mkdirSync(wt, { recursive: true })
        writeFileSync(join(wt, '.git'), 'gitdir: x')
        writeFileSync(join(wt, 'AGENTS.md'), '# contract')
      }
      if (cmd === 'graft') return `o/r\nHEAD abc1234\n${status}\n`
      if (args.includes('symbolic-ref')) return 'agent/5-fix-it\n'
      return ''
    },
    spawnFn: /** @type {any} */ (
      (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
        spawned.push({ cmd, args, opts })
        const child = Object.assign(new EventEmitter(), { pid: 4242, unref() {} })
        setImmediate(() => child.emit('exit', 0))
        return child
      }
    ),
  })
  return { spawner, calls, spawned }
}

/** @param {import('../src/config.mjs').Config} config @param {any} [extra] */
const startSpec = (config, extra = {}) => ({
  repo: config.repos[0],
  convention: resolveConvention(undefined, config.repos[0].path),
  issue: 5,
  attempt: 1,
  branch: 'agent/5-fix-it',
  phase: 'task',
  maxTurns: 99,
  buildPrompt: (/** @type {string | null} */ agents) => `PROMPT with ${agents}`,
  ...extra,
})

test('lesson #4382: a worker is a plain detached child — own worktree, own process group, logs on disk, no tmux', async () => {
  const home = tmp()
  const repoPath = tmp()
  const config = resolveConfig({
    repos: [{ slug: 'o/r', path: repoPath, baseBranch: 'trunk' }],
    paths: { home },
    logs: { keepPerIssue: 2 },
    graft: { app: 'clock-app' },
    worker: { args: ['--model', 'opus'], graftApp: 'worker-app' },
  })
  const { spawner, calls, spawned } = spawnerWith({ config })
  const started = await spawner.start(startSpec(config))
  assert.equal(started.pid, 4242)
  assert.equal(await started.exited, 0)
  const wt = join(repoPath, '.claude', 'worktrees', '5-fix-it')
  assert.equal(started.worktree, wt)
  assert.equal(started.reused, null)
  assert.deepEqual(calls, [
    ['git', '-C', repoPath, 'fetch', 'origin', 'trunk'],
    ['git', '-C', repoPath, 'symbolic-ref', '--short', '-q', 'HEAD'],
    ['git', '-C', repoPath, 'worktree', 'add', '--no-track', '-B', 'agent/5-fix-it', wt, 'origin/trunk'],
  ])
  const [{ cmd, args, opts }] = spawned
  assert.equal(cmd, process.execPath, 'the prepare step runs first, then becomes the worker')
  assert.match(args[0], /src\/prepare\.mjs$/)
  assert.deepEqual(args.slice(1), ['--', 'claude', ...workerArgs(config, 99)])
  assert.ok(args.join(' ').includes('Bash(graft issue label:*)'))
  assert.deepEqual(args.slice(-2), ['--model', 'opus'])
  assert.equal(opts.detached, true)
  assert.equal(opts.cwd, wt)
  assert.equal(opts.env.GRAFT_APP, 'worker-app')
  assert.equal(opts.env.CAMBIUM_ISSUE, '5')
  assert.equal(opts.env.CAMBIUM_BRANCH, 'agent/5-fix-it')
  assert.deepEqual(JSON.parse(opts.env.CAMBIUM_PREPARE), {
    worktree: wt,
    source: repoPath,
    install: 'pnpm install --frozen-lockfile',
    hydrate: { dirs: [], files: [] },
    prepare: [],
  })
  assert.ok(!JSON.stringify(spawned).includes('tmux'))
  assert.equal(readFileSync(started.prompt, 'utf8'), 'PROMPT with # contract')
  assert.ok(started.stdout.startsWith(join(home, 'logs', 'o__r', 'issue-5', 'a1-')))

  // Teardown: removed, with its local branch, only once graft status says GitHub has it all and nothing
  // works in it. Its nx daemon is stopped first; the tree is moved to the trash and erased in the background.
  const t = await spawner.cleanup({ repo: config.repos[0], worktree: wt, branch: 'agent/5-fix-it' })
  assert.deepEqual(t, { removed: true, reason: null })
  const trashed = join(home, 'trash', '5-fix-it-2026-11-16T12-00-00-000Z')
  assert.deepEqual(calls.slice(3), [
    ['graft', 'status', 'agent/5-fix-it', '-C', wt, '--repo', 'o/r'],
    ['sys', 'holders', wt],
    ['git', '-C', wt, 'symbolic-ref', '--short', '-q', 'HEAD'],
    ['sys', 'stop-nx', wt],
    ['git', '-C', repoPath, 'worktree', 'prune'],
    ['sys', 'erase', trashed],
    ['git', '-C', repoPath, 'branch', '-D', 'agent/5-fix-it'],
  ])
  assert.ok(!existsSync(wt), 'gone from the worktree root at once')
})

test('teardown keeps a worktree something still works in, and leaves its nx daemon alone', async () => {
  const repoPath = tmp()
  const config = resolveConfig({
    repos: [{ slug: 'o/r', path: repoPath }],
    paths: { home: tmp() },
    worker: { fetch: false },
  })
  const { spawner, calls } = spawnerWith({ config, holders: [321, 654] })
  const { worktree } = await spawner.start(startSpec(config))
  const t = await spawner.cleanup({ repo: config.repos[0], worktree, branch: 'agent/5-fix-it' })
  assert.deepEqual(t, { removed: false, reason: 'in use by pid 321, 654' })
  assert.ok(existsSync(worktree))
  assert.ok(!calls.some((c) => c.includes('stop-nx') || c.includes('prune')))
})

test('a trash left by an earlier daemon is erased when the next one starts', () => {
  const home = tmp()
  mkdirSync(join(home, 'trash', 'old-wt-stamp'), { recursive: true })
  const config = resolveConfig({ repos: [{ slug: 'o/r', path: tmp() }], paths: { home } })
  const { calls } = spawnerWith({ config })
  assert.deepEqual(calls, [['sys', 'erase', join(home, 'trash', 'old-wt-stamp')]])
})

test('nxDaemonOf: the pid file’s daemon only when its command runs from this worktree', () => {
  const file = JSON.stringify({ processId: 77, socketPath: '/tmp/.nx/x/d.sock' })
  const at = (/** @type {string} */ cmd) => nxDaemonOf('/r/wt', { read: () => file, command: () => cmd })
  assert.equal(at('node /r/wt/node_modules/nx/dist/src/daemon/server/start.js'), 77)
  assert.equal(at('node /r/wt-other/node_modules/nx/dist/src/daemon/server/start.js'), null, 'a sibling worktree')
  assert.equal(at(''), null, 'gone, or the pid was reused')
  assert.equal(
    nxDaemonOf('/r/wt', {
      read: () => {
        throw new Error('ENOENT')
      },
      command: () => 'x',
    }),
    null,
  )
  assert.equal(nxDaemonOf('/r/wt', { read: () => '{"processId":"x"}', command: () => '/r/wt/' }), null)
})

test('cwdHolders: pids whose cwd is in the worktree, less the excepted ones', () => {
  const out = [
    'p10',
    'fcwd',
    'n/r/wt',
    'p11',
    'fcwd',
    'n/r/wt/apps/mobile',
    'p12',
    'fcwd',
    'n/r/wt-2',
    'p13',
    'n/private/r/wt',
    'p14',
    'n/r/wt',
  ].join('\n')
  assert.deepEqual(cwdHolders(out, ['/r/wt', '/private/r/wt'], new Set([14])), [10, 11, 13])
})

test('childrenOf: direct children only', () => {
  assert.deepEqual(childrenOf(1, ' 2 1\n 3 2\n 4 1\n 1 1\n'), [2, 4])
})

test('the central checkout is fast-forwarded to the fetched base before a worktree is cut, and its convention re-read', async () => {
  const sh = (/** @type {string} */ cwd, /** @type {string[]} */ args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  const commit = (/** @type {string} */ cwd, /** @type {any} */ pkg) => {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg))
    sh(cwd, ['add', '-A'])
    sh(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'])
  }
  const origin = tmp()
  sh(origin, ['init', '-q', '-b', 'trunk'])
  commit(origin, { cambium: { prepare: ['old'] } })
  const central = join(tmp(), 'central')
  sh(origin, ['clone', '-q', origin, central])
  commit(origin, { cambium: { prepare: ['new'] } })

  const config = resolveConfig({ repos: [{ slug: 'o/r', path: central, baseBranch: 'trunk' }], paths: { home: tmp() } })
  /** @type {any[]} */
  const spawned = []
  const spawner = processSpawner({
    config,
    exec: async (cmd, args) => {
      if (args.includes('worktree')) return ''
      const r = spawnSync(cmd, args, { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(r.stderr)
      return r.stdout
    },
    spawnFn: /** @type {any} */ (
      (/** @type {string} */ c, /** @type {string[]} */ a, /** @type {any} */ opts) => {
        spawned.push(opts)
        return Object.assign(new EventEmitter(), { pid: 1, unref() {} })
      }
    ),
  })
  await spawner.start(startSpec(config, { convention: readConvention(central) }))
  assert.equal(sh(central, ['rev-parse', 'HEAD']), sh(origin, ['rev-parse', 'HEAD']))
  assert.deepEqual(JSON.parse(spawned[0].env.CAMBIUM_PREPARE).prepare, ['new'])

  // Off the base branch, or with tracked changes, it is left exactly where it is.
  commit(origin, { cambium: { prepare: ['newer'] } })
  writeFileSync(join(central, 'package.json'), '{"dirty":true}')
  await spawner.start(startSpec(config, { convention: readConvention(central), issue: 6, branch: 'agent/6-x' }))
  assert.notEqual(sh(central, ['rev-parse', 'HEAD']), sh(origin, ['rev-parse', 'HEAD']))
})

test('a read-only (triage) worker: a detached checkout, no install, no Edit/Write; removed outright', async () => {
  const repoPath = tmp()
  const config = resolveConfig({
    repos: [{ slug: 'o/r', path: repoPath }],
    paths: { home: tmp() },
    worker: { fetch: false },
  })
  const { spawner, calls, spawned } = spawnerWith({ config, status: 'local only: would be kept' })
  const started = await spawner.start(
    startSpec(config, { branch: 'cambium/triage-5', phase: 'dispatch', readOnly: true }),
  )
  const wt = join(repoPath, '.claude', 'worktrees', 'triage-5')
  assert.equal(started.worktree, wt)
  assert.deepEqual(calls, [
    ['git', '-C', repoPath, 'worktree', 'prune'],
    ['git', '-C', repoPath, 'worktree', 'add', '--detach', wt, 'origin/main'],
  ])
  const [{ args, opts }] = spawned
  assert.deepEqual(args.slice(1), ['--', 'claude', ...workerArgs(config, 99, { readOnly: true })])
  const tools = args[args.indexOf('--allowedTools') + 1]
  const denied = args[args.indexOf('--disallowedTools') + 1]
  assert.equal(tools, 'Read,Glob,Grep,Bash')
  for (const d of ['Edit', 'Write', 'Bash(graft publish:*)', 'Bash(git push:*)', 'Bash(graft issue label:*)'])
    assert.ok(denied.split(',').includes(d), `denies ${d}`)
  assert.equal(opts.env.CAMBIUM_BRANCH, undefined, 'there is no branch')
  assert.deepEqual(JSON.parse(opts.env.CAMBIUM_PREPARE), {
    worktree: wt,
    source: repoPath,
    install: null,
    hydrate: { dirs: [], files: [] },
    prepare: [],
  })
  // Teardown ignores graft status: nothing in a read-only checkout is kept.
  const t = await spawner.cleanup({ repo: config.repos[0], worktree: wt, branch: 'cambium/triage-5', readOnly: true })
  assert.deepEqual(t, { removed: true, reason: null })
  const trashed = join(config.paths.home, 'trash', 'triage-5-2026-11-16T12-00-00-000Z')
  assert.deepEqual(calls.slice(2), [
    ['sys', 'stop-nx', wt],
    ['git', '-C', repoPath, 'worktree', 'prune'],
    ['sys', 'erase', trashed],
  ])
  // A leftover from an earlier attempt is removed before the new checkout.
  calls.length = 0
  mkdirSync(wt, { recursive: true })
  await spawner.start(startSpec(config, { branch: 'cambium/triage-5', phase: 'dispatch', readOnly: true, attempt: 2 }))
  assert.deepEqual(calls, [
    ['sys', 'stop-nx', wt],
    ['git', '-C', repoPath, 'worktree', 'prune'],
    ['sys', 'erase', trashed],
    ['git', '-C', repoPath, 'worktree', 'add', '--detach', wt, 'origin/main'],
  ])
})

test('teardown keeps a worktree with local-only work; the retry continues in it', async () => {
  const repoPath = tmp()
  const config = resolveConfig({
    repos: [{ slug: 'o/r', path: repoPath }],
    paths: { home: tmp() },
    worker: { fetch: false },
  })
  const verdict = 'local only (not on GitHub): 2 uncommitted paths'
  const { spawner, calls } = spawnerWith({ config, status: verdict })
  const first = await spawner.start(startSpec(config))
  const t = await spawner.cleanup({ repo: config.repos[0], worktree: first.worktree, branch: 'agent/5-fix-it' })
  assert.deepEqual(t, { removed: false, reason: verdict })
  assert.ok(existsSync(first.worktree))
  assert.ok(!calls.some((c) => c.includes('remove')))

  const second = await spawner.start(startSpec(config, { attempt: 2 }))
  assert.equal(second.worktree, first.worktree, 'the same topic every attempt')
  assert.equal(second.reused, verdict)
  assert.equal(calls.filter((c) => c.includes('add')).length, 1, 'not re-created')
})

test('a clean leftover worktree is replaced fresh; a stray directory is cleared', async () => {
  const repoPath = tmp()
  const config = resolveConfig({
    repos: [{ slug: 'o/r', path: repoPath }],
    paths: { home: tmp() },
    worker: { fetch: false },
  })
  const { spawner, calls } = spawnerWith({ config })
  const first = await spawner.start(startSpec(config))
  const second = await spawner.start(startSpec(config, { attempt: 2 }))
  assert.equal(second.reused, null)
  const verbs = (/** @type {string[][]} */ cs) =>
    cs.map((c) =>
      c[0] === 'graft' ? 'status' : c[0] === 'sys' ? c[1] : c[3] === 'worktree' ? `worktree ${c[4]}` : c[3],
    )
  assert.deepEqual(verbs(calls), [
    'worktree add',
    'status',
    'holders',
    'symbolic-ref',
    'stop-nx',
    'worktree prune',
    'erase',
    'branch',
    'worktree add',
  ])

  calls.length = 0
  writeFileSync(join(first.worktree, '.git'), '')
  const stray = join(repoPath, '.claude', 'worktrees', '6-stray')
  mkdirSync(stray, { recursive: true })
  await spawner.start(startSpec(config, { issue: 6, branch: 'agent/6-stray' }))
  assert.deepEqual(verbs(calls), ['worktree add'], 'no .git: not a worktree, nothing to ask graft')
})

test('teardown keeps the worktree when graft status itself fails', async () => {
  const repoPath = tmp()
  const config = resolveConfig({ repos: [{ slug: 'o/r', path: repoPath }], paths: { home: tmp() } })
  const wt = join(repoPath, 'wt')
  mkdirSync(wt)
  const spawner = processSpawner({
    config,
    exec: async (cmd) => {
      if (cmd === 'graft') throw new Error('graft status exited 1: no credentials')
      return ''
    },
  })
  const t = await spawner.cleanup({ repo: config.repos[0], worktree: wt, branch: 'b' })
  assert.equal(t.removed, false)
  assert.match(String(t.reason), /graft status failed: .*no credentials/)
  assert.ok(existsSync(wt))
})

test('a worker that cannot start is an error, not a phantom pid', async () => {
  const config = resolveConfig({
    repos: [{ slug: 'o/r', path: tmp() }],
    paths: { home: tmp() },
    worker: { fetch: false },
  })
  const bare = processSpawner({
    config,
    exec: async (_cmd, args) => {
      if (args.includes('add')) mkdirSync(args[args.length - 2], { recursive: true })
      return ''
    },
    spawnFn: /** @type {any} */ (() => Object.assign(new EventEmitter(), { pid: undefined, unref() {} })),
  })
  await assert.rejects(bare.start(startSpec(config)), /could not start the worker/)
})

test('worker env: config worker.env, then the start spec env (TRACEPARENT) wins', async () => {
  const config = resolveConfig({
    repos: [{ slug: 'o/r', path: tmp() }],
    paths: { home: tmp() },
    worker: { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', TRACEPARENT: 'from-config' } },
  })
  const { spawner, spawned } = spawnerWith({ config })
  const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
  await spawner.start(startSpec(config, { env: { TRACEPARENT: tp } }))
  assert.equal(spawned[0].opts.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1')
  assert.equal(spawned[0].opts.env.TRACEPARENT, tp)
  assert.throws(() => resolveConfig({ worker: { env: { N: 1 } } }), /worker\.env must be an object of string values/)
  assert.throws(() => resolveConfig({ worker: { env: ['x'] } }), /worker\.env/)
})

// ---- prepare

test('the entry point: prepare, then become the worker; a failure exits 78 with the marker line', () => {
  const main = fileURLToPath(new URL('../src/prepare.mjs', import.meta.url))
  const wt = tmp()
  const run = (/** @type {string[]} */ prep) =>
    spawnSync(process.execPath, [main, '--', process.execPath, '-e', 'console.log(process.cwd()); process.exit(5)'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAMBIUM_PREPARE: JSON.stringify({
          worktree: wt,
          source: tmp(),
          install: null,
          hydrate: { dirs: [], files: [] },
          prepare: prep,
        }),
      },
    })
  const ok = run(['echo prepared >&2'])
  assert.equal(ok.status, 5, "the worker's exit code")
  assert.equal(realpathSync(ok.stdout.trim()), realpathSync(wt))
  assert.match(ok.stderr, /prepared/)
  const bad = run(['echo boom >&2; exit 3'])
  assert.equal(bad.status, PREPARE_FAILED)
  assert.equal(bad.stdout, '', 'the worker never ran')
  assert.match(bad.stderr, /boom\n[\s\S]*cambium: prepare failed: prepare `echo boom >&2; exit 3` exited 3/)
})

test('install-fresh: install when node_modules is missing or behind the lockfile, not when it matches', () => {
  const wt = tmp()
  assert.equal(installState(wt), 'none')
  writeFileSync(join(wt, 'package.json'), '{}')
  writeFileSync(join(wt, 'pnpm-lock.yaml'), 'lock: 1')
  assert.equal(installState(wt), 'stale')
  mkdirSync(join(wt, 'node_modules', '.pnpm'), { recursive: true })
  writeFileSync(join(wt, 'node_modules', '.pnpm', 'lock.yaml'), 'lock: 0')
  assert.equal(installState(wt), 'stale')
  writeFileSync(join(wt, 'node_modules', '.pnpm', 'lock.yaml'), 'lock: 1')
  assert.equal(installState(wt), 'fresh')
})

test('hydrate: clones dirs and files from the checkout; present left alone, missing reported', () => {
  const src = tmp()
  const dst = tmp()
  mkdirSync(join(src, 'data', 'set'), { recursive: true })
  writeFileSync(join(src, 'data', 'set', 'a.bin'), 'A')
  mkdirSync(join(src, 'apps', 'm'), { recursive: true })
  writeFileSync(join(src, 'apps', 'm', '.env'), 'KEY=1')
  mkdirSync(join(dst, 'apps', 'm'), { recursive: true })
  /** @type {string[]} */
  const said = []
  const done = hydrate(
    src,
    dst,
    { dirs: ['data/set', 'gone'], files: ['apps/m/.env', 'nope/.env'] },
    { say: (l) => said.push(l) },
  )
  assert.deepEqual(done, ['data/set', 'apps/m/.env'])
  assert.equal(readFileSync(join(dst, 'data', 'set', 'a.bin'), 'utf8'), 'A')
  assert.equal(readFileSync(join(dst, 'apps', 'm', '.env'), 'utf8'), 'KEY=1')
  assert.ok(said.some((l) => /gone missing/.test(l)))
  assert.ok(said.some((l) => /nope\/\.env missing/.test(l)))

  writeFileSync(join(dst, 'apps', 'm', '.env'), 'MINE')
  assert.deepEqual(hydrate(src, dst, { dirs: ['data/set'], files: ['apps/m/.env'] }, { say: () => {} }), [])
  assert.equal(readFileSync(join(dst, 'apps', 'm', '.env'), 'utf8'), 'MINE', "the worktree's own edit survives")
})

test('hydrate: a failed clone falls back to a byte copy; a failed copy leaves nothing and throws', () => {
  const src = tmp()
  mkdirSync(join(src, 'data'))
  writeFileSync(join(src, 'data', 'x'), 'x')
  /** @type {boolean[]} */
  const tries = []
  const dst = tmp()
  hydrate(
    src,
    dst,
    { dirs: ['data'], files: [] },
    {
      say: () => {},
      copy: (_from, to, { clone }) => {
        tries.push(clone)
        if (clone) {
          mkdirSync(to)
          writeFileSync(join(to, 'half'), '')
          return 1
        }
        mkdirSync(to)
        writeFileSync(join(to, 'x'), 'x')
        return 0
      },
    },
  )
  assert.deepEqual(tries, [true, false])
  assert.ok(!existsSync(join(dst, 'data', 'half')), 'the half clone was discarded first')

  const dst2 = tmp()
  assert.throws(
    () =>
      hydrate(
        src,
        dst2,
        { dirs: ['data'], files: [] },
        {
          say: () => {},
          copy: (_from, to) => {
            mkdirSync(to, { recursive: true })
            writeFileSync(join(to, 'partial'), '')
            return 1
          },
        },
      ),
    /could not copy data/,
  )
  assert.ok(!existsSync(join(dst2, 'data')))
})

test('prepare: install-fresh, then hydrate, then the repo commands; the first failure stops it', () => {
  const src = tmp()
  const wt = tmp()
  writeFileSync(join(wt, 'package.json'), '{}')
  writeFileSync(join(src, '.env'), 'E')
  /** @type {string[]} */
  const ran = []
  const spec = {
    worktree: wt,
    source: src,
    install: 'pnpm install --frozen-lockfile',
    hydrate: { dirs: [], files: ['.env'] },
    prepare: ['pnpm build', 'pnpm gen'],
  }
  prepare(spec, {
    say: () => {},
    run: (cmd, cwd) => {
      assert.equal(cwd, wt)
      ran.push(`${cmd}${existsSync(join(wt, '.env')) ? ' (hydrated)' : ''}`)
      return 0
    },
  })
  assert.deepEqual(ran, ['pnpm install --frozen-lockfile', 'pnpm build (hydrated)', 'pnpm gen (hydrated)'])

  ran.length = 0
  assert.throws(
    () =>
      prepare(
        { ...spec, worktree: tmp() },
        {
          say: () => {},
          run: (cmd) => {
            ran.push(cmd)
            return cmd === 'pnpm build' ? 2 : 0
          },
        },
      ),
    /prepare `pnpm build` exited 2/,
  )
  assert.deepEqual(ran, ['pnpm build'], 'no package.json: install skipped; the failure stops the rest')
  assert.throws(
    () => prepare({ ...spec, worktree: wt, install: 'false-install' }, { say: () => {}, run: () => 1 }),
    /install `false-install` exited 1/,
  )
})
