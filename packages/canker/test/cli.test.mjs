// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../src/cli.mjs'

const BIN = fileURLToPath(new URL('../bin/canker.mjs', import.meta.url))

// complexity 6, so CRAP 42 when uncovered and 6 when fully covered
const BRANCHY = `export function branchy(a) {
  if (a === 1) return 'one'
  if (a === 2) return 'two'
  if (a === 3) return 'three'
  if (a === 4) return 'four'
  if (a === 5) return 'five'
  return 'many'
}
`
const SIMPLE = 'export const simple = (x) => x + 1\n'

/** @param {Record<string, string>} files */
function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'canker-'))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

/** lcov for src/b.mjs (BRANCHY) and src/s.mjs (SIMPLE); `hit` decides whether branchy's body ran */
const lcov = (hit) =>
  `SF:src/b.mjs\n${[1, 2, 3, 4, 5, 6, 7, 8].map((l) => `DA:${l},${hit ? 1 : 0}`).join('\n')}\nend_of_record\n` +
  'SF:src/s.mjs\nDA:1,1\nend_of_record\n'

function run(root, ...argv) {
  let out = ''
  let err = ''
  const code = main({ argv, cwd: root, stdout: (s) => (out += s), stderr: (s) => (err += s) })
  return { code, out, err }
}

test('green: exit 0 and a one-line summary', () => {
  const root = project({ 'src/b.mjs': BRANCHY, 'src/s.mjs': SIMPLE, 'coverage/lcov.info': lcov(true) })
  const r = run(root)
  assert.equal(r.code, 0)
  assert.match(r.out, /^canker: 2 functions, none over CRAP 30\n$/)
})

test('red: exit 1 with a table of offenders (file:line, name, complexity, coverage, CRAP)', () => {
  const root = project({ 'src/b.mjs': BRANCHY, 'src/s.mjs': SIMPLE, 'coverage/lcov.info': lcov(false) })
  const r = run(root)
  assert.equal(r.code, 1)
  const lines = r.out.split('\n')
  assert.match(lines[0], /^location\s+function\s+complexity\s+coverage\s+crap\s+baseline$/)
  assert.match(lines[2], /^src\/b\.mjs:1\s+branchy\s+6\s+0\.0%\s+42\.00\s+new$/)
  assert.match(r.out, /canker: 1 of 2 functions over CRAP 30/)
})

test('--json: the same verdict for machines', () => {
  const root = project({ 'src/b.mjs': BRANCHY, 'coverage/lcov.info': lcov(false) })
  const r = run(root, '--json')
  assert.equal(r.code, 1)
  const json = JSON.parse(r.out)
  assert.equal(json.ok, false)
  assert.equal(json.maxCrap, 30)
  assert.deepEqual(json.offenders, [
    {
      file: 'src/b.mjs',
      line: 1,
      name: 'branchy',
      complexity: 6,
      coverage: 0,
      crap: 42,
      baseline: null,
      status: 'new',
    },
  ])
})

test('config: canker key in package.json, or canker.json (which wins)', () => {
  const root = project({
    'src/b.mjs': BRANCHY,
    'coverage/lcov.info': lcov(false),
    'package.json': JSON.stringify({ canker: { maxCrap: 50 } }),
  })
  assert.equal(run(root).code, 0)
  writeFileSync(join(root, 'canker.json'), JSON.stringify({ maxCrap: 20 }))
  assert.equal(run(root).code, 1)
  writeFileSync(join(root, 'canker.json'), JSON.stringify({ exclude: ['src/b.mjs'] }))
  assert.equal(run(root).code, 0)
  writeFileSync(join(root, 'canker.json'), JSON.stringify({ maxCrap: 'high' }))
  const bad = run(root)
  assert.equal(bad.code, 2)
  assert.match(bad.err, /maxCrap must be a positive number/)
})

test('config: coverage path(s) and Istanbul coverage-final.json joined by absolute path', () => {
  const root = project({ 'src/b.mjs': BRANCHY, 'canker.json': JSON.stringify({ coverage: 'out/cov.json' }) })
  const statementMap = Object.fromEntries(
    [2, 3, 4, 5, 6, 7].map((l, i) => [i, { start: { line: l, column: 2 }, end: { line: l, column: 20 } }]),
  )
  const s = Object.fromEntries(Object.keys(statementMap).map((k) => [k, 1]))
  const file = join(root, 'src/b.mjs')
  mkdirSync(join(root, 'out'))
  writeFileSync(
    join(root, 'out/cov.json'),
    JSON.stringify({ [file]: { path: file, statementMap, s, fnMap: {}, f: {} } }),
  )
  const r = run(root, '--json')
  assert.equal(r.code, 0)
  assert.equal(JSON.parse(r.out).functions, 1)
})

test('no coverage file: exit 2 with a hint', () => {
  const r = run(project({ 'src/s.mjs': SIMPLE }))
  assert.equal(r.code, 2)
  assert.match(r.err, /run the tests with coverage first/)
})

test('bad flag and a syntax error: exit 2', () => {
  const root = project({ 'src/s.mjs': SIMPLE, 'coverage/lcov.info': lcov(true) })
  assert.equal(run(root, '--nope').code, 2)
  writeFileSync(join(root, 'src/broken.mjs'), 'function (')
  const r = run(root)
  assert.equal(r.code, 2)
  assert.match(r.err, /src\/broken\.mjs/)
})

test('ratchet: --init grandfathers offenders; a raised score fails; --update only lowers or removes', () => {
  const root = project({ 'src/b.mjs': BRANCHY, 'coverage/lcov.info': lcov(false) })
  const baselineFile = join(root, 'canker-baseline.json')
  const baseline = () => JSON.parse(readFileSync(baselineFile, 'utf8'))

  assert.equal(run(root, '--init').code, 0)
  assert.deepEqual(baseline(), { 'src/b.mjs': { branchy: 42 } })
  assert.equal(run(root, '--init').code, 2, 'never re-initialized over an existing baseline')
  assert.equal(run(root).code, 0)

  // one more branch: raised, fails, and --update does not absorb it
  writeFileSync(join(root, 'src/b.mjs'), BRANCHY.replace("return 'many'", "return a ? 'many' : 'none'"))
  const raised = run(root)
  assert.equal(raised.code, 1)
  assert.match(raised.out, /branchy\s+7\s+0\.0%\s+56\.00\s+42\.00/)
  assert.equal(run(root, '--update').code, 1)
  assert.deepEqual(baseline(), { 'src/b.mjs': { branchy: 42 } })

  // a new offender is not added by --update
  writeFileSync(join(root, 'src/c.mjs'), BRANCHY.replace('branchy', 'other'))
  run(root, '--update')
  assert.deepEqual(Object.keys(baseline()), ['src/b.mjs'])

  // better coverage lowers the entry; full coverage removes it
  writeFileSync(join(root, 'src/b.mjs'), BRANCHY)
  writeFileSync(join(root, 'src/c.mjs'), SIMPLE)
  const oneEighth = 'SF:src/b.mjs\nDA:1,1\nDA:2,0\nDA:3,0\nDA:4,0\nDA:5,0\nDA:6,0\nDA:7,0\nDA:8,0\nend_of_record\n'
  writeFileSync(join(root, 'coverage/lcov.info'), oneEighth)
  assert.equal(run(root, '--update').code, 0)
  assert.deepEqual(baseline(), { 'src/b.mjs': { branchy: 30.12 } })
  writeFileSync(join(root, 'coverage/lcov.info'), lcov(true))
  assert.equal(run(root, '--update').code, 0)
  assert.deepEqual(baseline(), {})
})

test('end to end: real node --test lcov, through the bin, exit codes from the process', () => {
  const root = project({
    'src/b.mjs': BRANCHY,
    'coverage/.keep': '',
    'canker.json': JSON.stringify({ maxCrap: 10 }),
    'test/b.test.mjs':
      "import { test } from 'node:test'\nimport { branchy } from '../src/b.mjs'\ntest('one', () => branchy(1))\n",
  })
  const t = spawnSync(
    process.execPath,
    [
      '--test',
      '--experimental-test-coverage',
      '--test-reporter=lcov',
      '--test-reporter-destination=coverage/lcov.info',
      'test/b.test.mjs',
    ],
    // a child of the test runner inherits NODE_TEST_CONTEXT and would report to us instead of to the file
    { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  )
  assert.equal(t.status, 0, t.stderr)
  assert.ok(existsSync(join(root, 'coverage/lcov.info')))

  const red = spawnSync(process.execPath, [BIN, '--json'], { cwd: root, encoding: 'utf8' })
  assert.equal(red.status, 1, red.stderr)
  const [offender] = JSON.parse(red.stdout).offenders
  assert.equal(offender.name, 'branchy')
  assert.ok(offender.coverage > 0 && offender.coverage < 1)

  writeFileSync(join(root, 'canker.json'), JSON.stringify({ maxCrap: 100 }))
  const green = spawnSync(process.execPath, [BIN, '-C', root], { cwd: tmpdir(), encoding: 'utf8' })
  assert.equal(green.status, 0, green.stdout + green.stderr)
})
