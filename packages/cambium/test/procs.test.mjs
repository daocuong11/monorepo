// @ts-check
/** realProcs: killing a worker takes its whole process tree, not just its process group. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { descendants, realProcs } from '../src/workers.mjs'

test('descendants walks the pid/ppid table breadth-first, ignoring unrelated and malformed rows', () => {
  const table = ['  1     0', ' 10     1', ' 11    10', ' 12    10', ' 13    11', ' 20     1', 'junk', ''].join('\n')
  assert.deepEqual(descendants(10, table), [11, 12, 13])
  assert.deepEqual(descendants(13, table), [])
  assert.deepEqual(descendants(99, table), [])
})

test('descendants survives a cycle in the table', () => {
  assert.deepEqual(descendants(1, '2 1\n3 2\n2 3'), [2, 3])
})

test('kill takes a grandchild that left the worker’s process group', async (t) => {
  // The worker (its own group, like the spawner's) starts a grandchild in a new group, as Claude Code's
  // Bash tool does, and prints its pid.
  const inner =
    "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e3)'],{detached:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1e3)"
  // A bare env: the runner's (nx, NODE_OPTIONS) can add output of its own.
  const worker = spawn(process.execPath, ['-e', inner], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH },
  })
  /** @type {number} */
  const grandchild = await new Promise((res) => {
    let out = ''
    worker.stdout.on('data', (d) => {
      out += d
      const m = /^(\d+)$/m.exec(out)
      if (m) res(Number(m[1]))
    })
  })
  t.after(() => {
    for (const p of [grandchild, worker.pid]) {
      try {
        process.kill(/** @type {number} */ (p), 'SIGKILL')
      } catch {}
    }
  })
  assert.ok(realProcs.alive(grandchild), `grandchild ${grandchild} alive`)

  realProcs.kill(/** @type {number} */ (worker.pid))

  for (let i = 0; i < 50 && (realProcs.alive(grandchild) || realProcs.alive(/** @type {number} */ (worker.pid))); i++)
    await sleep(20)
  assert.equal(realProcs.alive(grandchild), false, 'grandchild in its own group is killed')
})

test('terminate: the tool grandchild is SIGKILLed, `claude` gets SIGTERM, and the prepare step exits with it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-term-'))
  const marker = join(dir, 'term')
  // `claude`: starts a tool process in a group of its own (as the Bash tool does), prints its pid, and on
  // SIGTERM records it (where Claude Code would end its spans and flush) and exits.
  const claude = `const fs=require('fs');const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e3)'],{detached:true,stdio:'ignore'});console.log(c.pid);process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'TERM');process.exit(0)});setInterval(()=>{},1e3)`
  // The prepare step: runs `claude` as its child and exits when it does (prepare.mjs).
  const prepare = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(claude)}],{stdio:'inherit'});c.on('exit',(code)=>process.exit(code??1));process.on('SIGTERM',()=>{})`
  const worker = spawn(process.execPath, ['-e', prepare], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH },
  })
  /** @type {number} */
  const tool = await new Promise((res) => {
    let out = ''
    worker.stdout.on('data', (d) => {
      out += d
      const m = /^(\d+)$/m.exec(out)
      if (m) res(Number(m[1]))
    })
  })
  t.after(() => {
    for (const p of [tool, worker.pid]) {
      try {
        process.kill(/** @type {number} */ (p), 'SIGKILL')
      } catch {}
    }
  })
  await sleep(100) // claude's SIGTERM handler is installed after it prints

  realProcs.terminate(/** @type {number} */ (worker.pid))

  const pid = /** @type {number} */ (worker.pid)
  for (let i = 0; i < 100 && (realProcs.alive(tool) || realProcs.alive(pid)); i++) await sleep(20)
  assert.equal(realProcs.alive(tool), false, 'the tool process is killed outright')
  assert.equal(realProcs.alive(pid), false, 'the prepare step exits once claude has')
  assert.equal(existsSync(marker) && readFileSync(marker, 'utf8'), 'TERM', 'claude got SIGTERM, not SIGKILL')
})
