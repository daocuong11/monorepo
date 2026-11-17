// @ts-check
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TOOLS, defaultSpawn, toolCommand } from '../src/tools.mjs'
import { run, tempDir } from './helpers.mjs'

const BIN = fileURLToPath(new URL('../bin/oakgreen.mjs', import.meta.url))

/** A fake installed package whose bin writes its args to a file and exits with `code`. */
function fakePackage(/** @type {string} */ tool, /** @type {number} */ code) {
  const root = tempDir({
    'package.json': JSON.stringify({
      name: TOOLS[/** @type {keyof typeof TOOLS} */ (tool)],
      bin: { [tool]: 'bin/x.mjs' },
    }),
    'bin/x.mjs': `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.OUT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))
process.exit(${code})
`,
  })
  return { root, resolve: (/** @type {string} */ id) => join(root, id.split('/').at(-1) ?? '') }
}

test('every stack tool resolves to its workspace bin, run with this node', () => {
  for (const tool of /** @type {(keyof typeof TOOLS)[]} */ (Object.keys(TOOLS))) {
    const c = toolCommand(tool)
    assert.equal(c.cmd, process.execPath, tool)
    assert.match(c.args[0], new RegExp(`${tool}[/\\\\]bin[/\\\\]${tool}\\.mjs$`), tool)
  }
})

test('an unresolvable package falls back to PATH', () => {
  const missing = () => {
    throw Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' })
  }
  assert.deepEqual(toolCommand('canopy', { resolve: missing }), { cmd: 'canopy', args: [] })
})

test('oakgreen <tool> passes args through and returns the exit code', async () => {
  const seen = []
  const r = await run(['mycelium', 'poll', 'discord', '--dry-run'], {
    cwd: '/work',
    spawn: async (cmd, args, opts) => {
      seen.push({ cmd, args, opts })
      return 3
    },
  })
  assert.equal(r.code, 3)
  assert.equal(seen[0].cmd, process.execPath)
  assert.deepEqual(seen[0].args.slice(1), ['poll', 'discord', '--dry-run'])
  assert.equal(seen[0].opts.cwd, '/work')
})

test('the real spawner inherits stdio and propagates the child exit code', async () => {
  const pkg = fakePackage('cambium', 7)
  const out = join(tempDir(), 'out.json')
  process.env.OUT = out
  try {
    const r = await run(['cambium', 'status', '--json'], { resolve: pkg.resolve, spawn: defaultSpawn, cwd: pkg.root })
    assert.equal(r.code, 7)
  } finally {
    delete process.env.OUT
  }
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).args, ['status', '--json'])
})

test('a tool on neither path exits 127 with an install hint', async () => {
  const missing = () => {
    throw new Error('nope')
  }
  const r = await run(['canopy'], {
    resolve: missing,
    spawn: async () => {
      throw Object.assign(new Error('spawn canopy ENOENT'), { code: 'ENOENT' })
    },
  })
  assert.equal(r.code, 127)
  assert.match(r.err, /npm install -g @oakgreencc\/canopy/)
})

test('the bin runs a workspace tool end to end', () => {
  const r = spawnSync(process.execPath, [BIN, 'deadwood', '--help'], { encoding: 'utf8' })
  const direct = spawnSync(process.execPath, [toolCommand('deadwood').args[0], '--help'], { encoding: 'utf8' })
  assert.equal(r.status, direct.status)
  assert.equal(r.stdout, direct.stdout)
})

test('usage, version and unknown commands', async () => {
  assert.equal((await run([], {})).code, 1)
  assert.match((await run(['--help'], {})).out, /oakgreen doctor/)
  assert.match((await run(['--version'], {})).out, /^\d+\.\d+\.\d+\n$/)
  const bad = await run(['bogus'], {})
  assert.equal(bad.code, 2)
  assert.match(bad.err, /unknown command 'bogus'/)
  assert.equal((await run(['doctor', '--nope'], {})).code, 2)
})
