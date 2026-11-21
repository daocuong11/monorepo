// @ts-check
/**
 * Every package's bin is committed executable. pnpm makes a bin executable on
 * install, so one committed 644 shows up as a mode change in every fresh
 * worktree. That uncommitted path makes `graft worktree done` and ExitWorktree
 * refuse to remove a worktree whose work is all merged.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const packages = fileURLToPath(new URL('../..', import.meta.url))

test('every packages/*/bin file is 100755 in git', (t) => {
  let out
  try {
    out = execFileSync('git', ['-C', packages, 'ls-files', '-s', '--', '*/bin/*'], { encoding: 'utf8' })
  } catch {
    return t.skip('not a git checkout')
  }
  const entries = out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => /^(\d{6}) \S+ \d\t(.+)$/.exec(l))
    .filter((m) => m !== null)
  assert.ok(entries.length > 0, 'found no bin files')
  assert.deepEqual(
    entries.filter((m) => m[1] !== '100755').map((m) => `${m[2]} is ${m[1]}`),
    [],
  )
})
