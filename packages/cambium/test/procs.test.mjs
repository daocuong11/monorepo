// @ts-check
/** realProcs: killing a worker takes its whole process tree, not just its process group. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
