// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../src/cli.mjs'

const dense = ['// a', '// b', '// c', ...Array.from({ length: 10 }, (_, k) => `f(${k})`)].join('\n')
const clean = Array.from({ length: 12 }, (_, k) => `f(${k})`).join('\n')

function fakeRepo(files) {
  const disk = { ...files }
  const out = { stdout: '', stderr: '' }
  const io = {
    cwd: '/repo',
    stdout: (s) => {
      out.stdout += s
    },
    stderr: (s) => {
      out.stderr += s
    },
    listFiles: () => Object.keys(files),
    readFile: (p) => disk[p.replace(/^\/repo\//, '')] ?? null,
    writeFile: (p, text) => {
      disk[p.replace(/^\/repo\//, '')] = text
    },
  }
  return { io, out, disk }
}

test('exit 0 and a summary when clean', () => {
  const { io, out } = fakeRepo({ 'README.md': '', 'a.mjs': clean })
  assert.equal(run([], io), 0)
  assert.equal(out.stdout, '')
  assert.match(out.stderr, /ok, 2 files checked/)
})

test('exit 1 with one line per offender: path, rule, density vs ceiling', () => {
  const { io, out } = fakeRepo({ 'notes.md': '', 'a.mjs': dense })
  assert.equal(run([], io), 1)
  assert.equal(
    out.stdout,
    'notes.md\tmarkdown\tmarkdown file outside markdown.allow\na.mjs\tcomments\tcomment density 0.231 > 0.150 (3/13 lines)\n',
  )
})

test('--json reports the same offenders', () => {
  const { io, out } = fakeRepo({ 'a.mjs': dense })
  assert.equal(run(['--json'], io), 1)
  const report = JSON.parse(out.stdout)
  assert.equal(report.ok, false)
  assert.equal(report.checked, 1)
  assert.deepEqual(report.offenders[0], {
    path: 'a.mjs',
    rule: 'comments',
    density: 3 / 13,
    ceiling: 0.15,
    commentLines: 3,
    lines: 13,
    reason: 'comment density 0.231 > 0.150 (3/13 lines)',
  })
})

test('exit 2 on bad arguments or bad config', () => {
  assert.equal(run(['--nope'], fakeRepo({}).io), 2)
  assert.equal(run(['--init', '--update'], fakeRepo({}).io), 2)
  const { io, out } = fakeRepo({ 'deadwood.json': '{"comments":{"maxDensity":"high"}}' })
  assert.equal(run([], io), 2)
  assert.match(out.stderr, /maxDensity/)
})

test('--init seeds the baseline once; later runs tolerate it', () => {
  const { io, disk } = fakeRepo({ 'notes.md': '', 'a.mjs': dense })
  assert.equal(run(['--init'], io), 0)
  assert.deepEqual(JSON.parse(disk['deadwood.baseline.json']), {
    markdown: ['notes.md'],
    comments: { 'a.mjs': 0.2308 },
  })
  assert.equal(run([], io), 0)
  assert.equal(run(['--init'], io), 2)
})

test('--update only shrinks: new offenders still fail and nothing is written', () => {
  const repo = fakeRepo({ 'notes.md': '', 'a.mjs': dense })
  repo.disk['deadwood.baseline.json'] = JSON.stringify({ markdown: [], comments: { 'a.mjs': 0.2308 } })
  const before = repo.disk['deadwood.baseline.json']
  assert.equal(run(['--update'], repo.io), 1)
  assert.equal(repo.disk['deadwood.baseline.json'], before)
})

test('--update drops fixed entries; a plain run only warns about them', () => {
  const repo = fakeRepo({ 'a.mjs': clean })
  repo.disk['deadwood.baseline.json'] = JSON.stringify({ markdown: ['gone.md'], comments: { 'a.mjs': 0.3 } })
  assert.equal(run([], repo.io), 0)
  assert.match(repo.out.stderr, /2 baseline entries can shrink; run deadwood --update/)
  assert.equal(run(['--update'], repo.io), 0)
  assert.deepEqual(JSON.parse(repo.disk['deadwood.baseline.json']), { markdown: [], comments: {} })
})

test('the bin reads only git-tracked files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'deadwood-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, '.gitignore'), 'dist/\n')
  writeFileSync(join(dir, 'README.md'), '# x\n')
  writeFileSync(join(dir, 'src/a.mjs'), clean)
  mkdirSync(join(dir, 'dist'))
  writeFileSync(join(dir, 'dist/out.mjs'), dense)
  writeFileSync(join(dir, 'untracked.md'), '')
  git('add', '.gitignore', 'README.md', 'src/a.mjs')

  const bin = fileURLToPath(new URL('../bin/deadwood.mjs', import.meta.url))
  const ok = spawnSync(process.execPath, [bin, '--json'], { cwd: dir, encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(JSON.parse(ok.stdout).checked, 2)

  writeFileSync(join(dir, 'src/b.mjs'), dense)
  git('add', 'src/b.mjs')
  const bad = spawnSync(process.execPath, [bin, '-C', dir], { encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /^src\/b\.mjs\tcomments\t/)
})
