// @ts-check
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { judge, readHeartbeat } from '../src/heartbeat.mjs'
import { heartbeat, T0 } from './fixtures.mjs'

test('a fresh v1 heartbeat is ok and not stale', () => {
  const hb = judge(heartbeat(), { now: T0 + 10_000 })
  assert.equal(hb.status, 'ok')
  assert.equal(hb.stale, false)
  assert.equal(hb.ageMs, 10_000)
  assert.equal(hb.staleAfterMs, 90_000)
  assert.equal(hb.message, null)
  assert.equal(hb.data.mode, 'running')
  assert.equal(hb.data.workers[0].logs.stdout, '/tmp/logs/a2.out.log')
  assert.deepEqual(
    hb.data.steps.map((/** @type {any} */ s) => [s.name, s.ok]),
    [
      ['read', true],
      ['reconcile', false],
    ],
  )
})

test('stale after three ticks of tickSeconds', () => {
  assert.equal(judge(heartbeat(), { now: T0 + 90_000 }).stale, false)
  const hb = judge(heartbeat(), { now: T0 + 90_001 })
  assert.equal(hb.stale, true)
  assert.match(String(hb.message), /90s ago.*3 ticks of 30s/)
  const slow = judge(heartbeat({ daemon: { startedAt: null, tickSeconds: 60 } }), { now: T0 + 120_000 })
  assert.equal(slow.stale, false)
})

test('no finished tick counts as stale, not a crash', () => {
  const hb = judge(heartbeat({ tick: {} }), { now: T0 })
  assert.equal(hb.status, 'ok')
  assert.equal(hb.stale, true)
  assert.equal(hb.ageMs, null)
})

test('unknown version gives a clear message and no data', () => {
  for (const version of [2, undefined, '1']) {
    const hb = judge(heartbeat({ version }), { now: T0 })
    assert.equal(hb.status, 'unknown-version')
    assert.equal(hb.data, null)
    assert.match(String(hb.message), /not one canopy reads \(expects 1\)/)
  }
})

test('sparse v1 is filled in so the page never guards', () => {
  const hb = judge({ version: 1 }, { now: T0 })
  assert.equal(hb.status, 'ok')
  assert.deepEqual(hb.data.workers, [])
  assert.deepEqual(hb.data.events, [])
  assert.equal(hb.data.mode, 'unknown')
  assert.equal(hb.staleAfterMs, 90_000)
})

test('readHeartbeat: missing, not JSON, not an object, and ok from disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canopy-'))
  const missing = await readHeartbeat(join(dir, 'nope.json'))
  assert.equal(missing.status, 'missing')
  assert.match(String(missing.message), /no heartbeat at/)

  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{"version":1,')
  assert.equal((await readHeartbeat(bad)).status, 'unreadable')

  const arr = join(dir, 'arr.json')
  writeFileSync(arr, '[]')
  assert.equal((await readHeartbeat(arr)).status, 'unreadable')

  const good = join(dir, 'state.json')
  writeFileSync(good, JSON.stringify(heartbeat()))
  const hb = await readHeartbeat(good, { now: T0 + 1000 })
  assert.equal(hb.status, 'ok')
  assert.equal(hb.path, good)
})

test('readHeartbeat: a read error other than ENOENT is unreadable', async () => {
  const hb = await readHeartbeat('/x', {
    read: async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    },
  })
  assert.equal(hb.status, 'unreadable')
  assert.match(String(hb.message), /permission denied/)
})
