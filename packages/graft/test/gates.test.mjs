// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkValidatedBase, readReceipt, receiptPath, writeReceipt } from '../src/gates/validated-base.mjs'
import { VERSION, compareVersions, versionRefusal } from '../src/gates/version.mjs'
import { stackedBaseRefusal } from '../src/gates/stacked-base.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

test('compareVersions: numeric per part, a pre-release sorts before its release', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('v1.2.3', '1.2.4'), -1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0-a', '1.0.0-b'), -1)
})

test('versionRefusal: silent without a floor or at/above it; names both versions below it', () => {
  assert.equal(versionRefusal(null), null)
  assert.equal(versionRefusal(VERSION), null)
  assert.equal(versionRefusal('0.1.0', '0.2.0'), null)
  const refusal = String(versionRefusal('9.0.0', '0.1.0'))
  assert.match(refusal, /requires graft >= 9\.0\.0, and this is 0\.1\.0/)
})

test('validated base: no receipt or no base sha is "unknown", never "stale"', () => {
  assert.equal(checkValidatedBase({ receipt: null, publishBaseSha: A, ref: 'origin/main' }), null)
  assert.equal(checkValidatedBase({ receipt: { baseSha: A }, publishBaseSha: null, ref: 'origin/main' }), null)
})

test('validated base: the same base passes; a stacked publish passes on the receipt HEAD', () => {
  assert.equal(checkValidatedBase({ receipt: { baseSha: A }, publishBaseSha: A, ref: 'origin/main' }), null)
  assert.equal(
    checkValidatedBase({ receipt: { baseSha: A, headSha: B }, publishBaseSha: B, ref: 'origin/parent' }),
    null,
  )
})

test('validated base: a moved base is refused, with the advance-and-revalidate fix and the override', () => {
  const text = String(
    checkValidatedBase({
      receipt: { ref: 'origin/main', baseSha: A, headSha: B, validatedAt: '2026-09-23T00:00:00Z' },
      publishBaseSha: C,
      ref: 'origin/main',
    }),
  )
  assert.match(text, /validation ran against a different origin\/main/)
  assert.match(text, /on HEAD bbbbbbbbbbbb/)
  assert.match(text, /graft advance main/)
  assert.match(text, /--stale-base-ok/)
})

test('receipt: written under the git dir, read back; garbage or a missing baseSha reads as none', (t) => {
  const gitDir = mkdtempSync(join(tmpdir(), 'graft-receipt-'))
  t.after(() => rmSync(gitDir, { recursive: true, force: true }))
  assert.equal(readReceipt({ gitDir }), null)
  assert.equal(writeReceipt({ gitDir, ref: 'origin/main', baseSha: null }), null)

  const written = writeReceipt({ gitDir, ref: 'origin/main', baseSha: A, headSha: B, command: 'npm test' })
  assert.deepEqual(readReceipt({ gitDir }), written)
  assert.equal(written?.headSha, B)

  mkdirSync(join(gitDir, 'graft'), { recursive: true })
  writeFileSync(receiptPath(gitDir), '{not json')
  assert.equal(readReceipt({ gitDir }), null)
  writeFileSync(receiptPath(gitDir), JSON.stringify({ ref: 'origin/main' }))
  assert.equal(readReceipt({ gitDir }), null)
})

test('stacked base: a new branch or PR on a mergeable base passes', () => {
  const allowedBases = ['develop']
  assert.equal(stackedBaseRefusal({ base: 'develop', allowedBases, newBranch: true, newPr: true }), null)
})

test('stacked base: a new PR against another branch is refused, naming the base and the fix', () => {
  const refusal = String(
    stackedBaseRefusal({ base: 'agent/1-a', allowedBases: ['develop'], newBranch: true, newPr: true }),
  )
  assert.match(refusal, /open a PR against `agent\/1-a`/)
  assert.match(refusal, /agents merge only into `develop`/)
  assert.match(refusal, /two issues, the second blocked/)
})

test('stacked base: a new branch cut from another branch is refused even without a PR', () => {
  const refusal = stackedBaseRefusal({ base: 'agent/1-a', allowedBases: ['main'], newBranch: true, newPr: false })
  assert.match(String(refusal), /cut a new branch from `agent\/1-a`/)
})

test('stacked base: publishing to an existing branch with no new PR is left alone', () => {
  assert.equal(stackedBaseRefusal({ base: 'agent/1-a', allowedBases: ['main'], newBranch: false, newPr: false }), null)
})

test('stacked base: an empty mergeableBases refuses every new branch', () => {
  assert.match(
    String(stackedBaseRefusal({ base: 'main', allowedBases: [], newBranch: true, newPr: false })),
    /agents merge only into no branch/,
  )
})
