// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ARCH_WARN_INTERVAL_MS,
  assess,
  checkArch,
  isX86,
  captureFileName,
  endsOnSpawn,
  isWorker,
  newestWorkerLog,
  parsePs,
  watch,
  STALE_MS,
  RESTART_COOLDOWN_MS,
  UNPOLLED_MS,
  assessListener,
  countLsofConnections,
  isListener,
  serviceLabel,
  watchListener,
} from '../src/runner-watchdog.mjs'

const PLIST_URL = new URL('../launchd/com.oakgreencc.runner-watchdog.plist', import.meta.url)

const WORKER_PATH = '/Users/x/SeKtor/actions-runner/bin/Runner.Worker'
const LISTENER_PATH = '/Users/x/SeKtor/actions-runner/bin/Runner.Listener'

// Shape copied from a real `_diag/Worker_*.log` on the runner Mac (2026-10-15).
const SPAWN_BLOCK = [
  '[2026-10-10 04:38:30Z INFO ProcessInvokerWrapper] Starting process:',
  "[2026-10-10 04:38:30Z INFO ProcessInvokerWrapper]   File name: '/opt/homebrew/bin/bash'",
  "[2026-10-10 04:38:30Z INFO ProcessInvokerWrapper]   Arguments: '--noprofile --norc -e -o pipefail /x/_temp/9dcc.sh'",
  "[2026-10-10 04:38:30Z INFO ProcessInvokerWrapper]   Working directory: '/x/_work/monorepo/monorepo'",
  "[2026-10-10 04:38:30Z INFO ProcessInvokerWrapper]   Require exit code zero: 'False'",
  "[2026-10-10 04:38:30Z INFO ProcessInvokerWrapper]   Encoding web name:  ; code page: ''",
  "[2026-10-10 04:38:30Z INFO ProcessInvokerWrapper]   Force kill process on cancellation: 'False'",
  "[2026-10-10 04:38:30Z INFO ProcessInvokerWrapper]   Redirected STDIN: 'False'",
  "[2026-10-10 04:38:30Z INFO ProcessInvokerWrapper]   Persist current code page: 'False'",
  "[2026-10-10 04:38:30Z INFO ProcessInvokerWrapper]   Keep redirected STDIN open: 'False'",
  "[2026-10-10 04:38:30Z INFO ProcessInvokerWrapper]   High priority process: 'False'",
].join('\n')
const BEFORE = "[2026-10-10 04:38:29Z INFO StepsRunner] Processing step: DisplayName='setup'\n"
const WEDGED_TAIL = `${BEFORE}${SPAWN_BLOCK}\n`
const STARTED_TAIL = `${WEDGED_TAIL}[2026-10-10 04:38:30Z INFO ProcessInvokerWrapper] Process started with process id 88948, waiting for process exit.\n`

// Worker_20261105-045909-utc.log: Complete job hangs spawning ps, then logs
// these directory lookups. The old detector missed it until the 65m timeout.
const DIRECTORY_TAIL = [
  "[2026-11-05 05:01:04Z INFO HostContext] Well known directory 'Bin': '/r/bin.2.338.2'",
  "[2026-11-05 05:01:04Z INFO HostContext] Well known directory 'Root': '/r'",
].join('\n')
const CLEANUP_TAIL = `${SPAWN_BLOCK.replace("'/opt/homebrew/bin/bash'", "'ps'")}\n${DIRECTORY_TAIL}\n`

const NOW = Date.parse('2026-10-10T04:50:00Z')
const STALE = NOW - STALE_MS - 1000
const FRESH = NOW - 30 * 1000

const listener = { pid: 100, ppid: 1, command: LISTENER_PATH }
const worker = { pid: 200, ppid: 100, command: WORKER_PATH }
const log = (tail = WEDGED_TAIL, mtimeMs = STALE) => ({
  path: '/r/_diag/Worker_1.log',
  mtimeMs,
  tail,
})

// --- the detector -----------------------------------------------------------

test('wedged: no child, log ends on the spawn block, silent past the threshold', () => {
  const a = assess({ processes: [listener, worker], log: log(), now: NOW })
  assert.equal(a.verdict, 'wedged')
  assert.equal(a.pid, 200)
  assert.equal(a.log, '/r/_diag/Worker_1.log')
  assert.match(a.lastLine ?? '', /High priority process/)
})

test('a worker with a child is a running step, never wedged', () => {
  const child = { pid: 300, ppid: 200, command: '/opt/homebrew/bin/bash' }
  const a = assess({ processes: [listener, worker, child], log: log(), now: NOW })
  assert.equal(a.verdict, 'healthy')
})

test('a log still being written is never wedged', () => {
  const a = assess({ processes: [listener, worker], log: log(WEDGED_TAIL, FRESH), now: NOW })
  assert.equal(a.verdict, 'healthy')
})

test('a log ending on Process started is never wedged', () => {
  const a = assess({ processes: [listener, worker], log: log(STARTED_TAIL), now: NOW })
  assert.equal(a.verdict, 'healthy')
})

test('no worker is a no-op', () => {
  assert.equal(assess({ processes: [listener], log: log(), now: NOW }).verdict, 'none')
})

test('two workers cannot be told apart by the newest log, so neither is wedged', () => {
  const other = { pid: 201, ppid: 1, command: WORKER_PATH }
  assert.equal(assess({ processes: [listener, worker, other], log: log(), now: NOW }).verdict, 'ambiguous')
})

test('no diag log is not evidence of a hang', () => {
  assert.equal(assess({ processes: [worker], log: null, now: NOW }).verdict, 'healthy')
})

test('endsOnSpawn: other logging after the spawn means it moved on', () => {
  assert.equal(endsOnSpawn(WEDGED_TAIL), true)
  assert.equal(endsOnSpawn(STARTED_TAIL), false)
  assert.equal(endsOnSpawn(`${WEDGED_TAIL}[x INFO JobServerQueue] Uploading\n`), false)
  assert.equal(endsOnSpawn(BEFORE), false)
})

test('isWorker matches the executable name only — never the Listener', () => {
  assert.equal(isWorker(WORKER_PATH), true)
  assert.equal(isWorker('Runner.Worker'), true)
  assert.equal(isWorker(LISTENER_PATH), false)
  assert.equal(isWorker('/bin/Runner.Worker.sh'), false)
})

test('cleanup directory lookups do not hide an unstarted spawn', async () => {
  const f = fakePorts({ processes: [listener, worker], diag: log(CLEANUP_TAIL), dies: 'SIGKILL' })
  const result = await watch(f.ports)
  assert.equal(result.assessment.verdict, 'wedged')
  assert.deepEqual(f.order, ['capture:200', 'SIGTERM', 'SIGKILL'])
})

test('directory lookups do not hide evidence of a started process or other progress', () => {
  for (const tail of [
    `${STARTED_TAIL}${DIRECTORY_TAIL}`,
    `${WEDGED_TAIL}[x INFO JobServerQueue] Uploading\n${DIRECTORY_TAIL}`,
    `${WEDGED_TAIL}[x INFO HostContext] Unloading trace listeners\n`,
    DIRECTORY_TAIL,
  ]) {
    assert.equal(endsOnSpawn(tail), false)
  }
})

test('cleanup spawn still requires a stale log and no children', () => {
  const child = { pid: 300, ppid: worker.pid, command: '/bin/ps' }
  assert.equal(assess({ processes: [worker, child], log: log(CLEANUP_TAIL), now: NOW }).verdict, 'healthy')
  assert.equal(assess({ processes: [worker], log: log(CLEANUP_TAIL, FRESH), now: NOW }).verdict, 'healthy')
})

test('parsePs reads pid, ppid and a command with spaces', () => {
  assert.deepEqual(parsePs('  100     1 /a b/Runner.Listener\n  200   100 /a b/Runner.Worker\n'), [
    { pid: 100, ppid: 1, command: '/a b/Runner.Listener' },
    { pid: 200, ppid: 100, command: '/a b/Runner.Worker' },
  ])
})

// --- the kill sequence, through ports ---------------------------------------

/**
 * @param {{ processes: any[], diag: any, dies?: string,
 *   capture?: (pid: number) => string | Promise<string> }} opts
 */
function fakePorts({ processes, diag, dies = 'never', capture = (pid) => `/r/wedge-x-${pid}.sample.txt` }) {
  /** @type {string[]} */
  const lines = []
  /** @type {[number, string][]} */
  const signals = []
  /** @type {string[]} every capture and signal, in the order they happened */
  const order = []
  let alive = true
  return {
    lines,
    signals,
    order,
    ports: {
      capture: (pid) => {
        order.push(`capture:${pid}`)
        return capture(pid)
      },
      listProcesses: () => (alive ? processes : processes.filter((p) => p.pid !== 200)),
      newestLog: () => diag,
      now: () => NOW,
      signal: (pid, sig) => {
        signals.push([pid, sig])
        order.push(sig)
        if (sig === dies) alive = false
      },
      sleep: async () => {},
      log: (line) => lines.push(line),
    },
  }
}

test('wedged → SIGTERM, and no SIGKILL when SIGTERM was enough', async () => {
  const f = fakePorts({ processes: [listener, worker], diag: log(), dies: 'SIGTERM' })
  await watch(f.ports)
  assert.deepEqual(f.signals, [[200, 'SIGTERM']])
  assert.match(f.lines[0], /wedged .*pid=200 log=\/r\/_diag\/Worker_1\.log .*last=.*High priority process/)
  assert.match(f.lines.at(-1) ?? '', /freed .*gone after SIGTERM/)
})

test('wedged → SIGTERM then SIGKILL when the worker survives the grace', async () => {
  const f = fakePorts({ processes: [listener, worker], diag: log(), dies: 'SIGKILL' })
  await watch(f.ports)
  assert.deepEqual(f.signals, [
    [200, 'SIGTERM'],
    [200, 'SIGKILL'],
  ])
  assert.match(f.lines.at(-1) ?? '', /freed .*gone after SIGKILL/)
})

// --- the capture before the kill (sektorapp/monorepo#3107) -----------------

test('wedged → the worker is captured before SIGTERM, and the path is logged', async () => {
  const f = fakePorts({ processes: [listener, worker], diag: log(), dies: 'SIGKILL' })
  await watch(f.ports)
  assert.deepEqual(f.order, ['capture:200', 'SIGTERM', 'SIGKILL'])
  assert.match(f.lines[1], /captured .*pid=200 .*sample at \/r\/wedge-x-200\.sample\.txt/)
})

test('a capture that throws is logged and the kill still runs', async () => {
  const f = fakePorts({
    processes: [listener, worker],
    diag: log(),
    dies: 'SIGKILL',
    capture: () => {
      throw new Error('sample: no such process')
    },
  })
  await watch(f.ports)
  assert.deepEqual(f.signals, [
    [200, 'SIGTERM'],
    [200, 'SIGKILL'],
  ])
  assert.match(f.lines[1], /capture-failed .*pid=200 .*sample: no such process/)
  assert.ok(!f.lines.some((l) => /\bcaptured\b/.test(l)))
})

test('a capture that rejects is logged and the kill still runs', async () => {
  const f = fakePorts({
    processes: [listener, worker],
    diag: log(),
    dies: 'SIGTERM',
    capture: async () => {
      throw new Error('exit 1')
    },
  })
  await watch(f.ports)
  assert.deepEqual(f.signals, [[200, 'SIGTERM']])
  assert.match(f.lines[1], /capture-failed .*exit 1/)
})

test('a capture that hangs times out, is logged, and the kill still runs', async () => {
  const f = fakePorts({
    processes: [listener, worker],
    diag: log(),
    dies: 'SIGKILL',
    capture: () => new Promise(() => {}),
  })
  const started = Date.now()
  await watch(f.ports, { captureTimeoutMs: 20 })
  assert.ok(Date.now() - started < 5000, 'the timeout bounds the capture')
  assert.deepEqual(f.signals, [
    [200, 'SIGTERM'],
    [200, 'SIGKILL'],
  ])
  assert.match(f.lines[1], /capture-failed .*timed out/)
})

test('dry run never captures', async () => {
  const f = fakePorts({ processes: [listener, worker], diag: log() })
  await watch(f.ports, { dryRun: true })
  assert.deepEqual(f.order, [])
})

test('healthy, no-worker and ambiguous runs never capture', async () => {
  const child = { pid: 300, ppid: 200, command: '/opt/homebrew/bin/bash' }
  const other = { pid: 201, ppid: 1, command: WORKER_PATH }
  for (const processes of [[listener], [listener, worker, child], [listener, worker, other]]) {
    const f = fakePorts({ processes, diag: log() })
    await watch(f.ports)
    assert.deepEqual(f.order, [])
  }
})

test('captureFileName is wedge-<iso>-<pid>.sample.txt with no colons', () => {
  assert.equal(captureFileName('2026-11-01T00:47:17.967Z', 61365), 'wedge-2026-11-01T00-47-17.967Z-61365.sample.txt')
})

test('the Listener is never signalled', async () => {
  const f = fakePorts({ processes: [listener, worker], diag: log() })
  await watch(f.ports)
  assert.ok(f.signals.every(([pid]) => pid !== listener.pid))
})

test('healthy and no-worker runs signal nothing and log nothing', async () => {
  const child = { pid: 300, ppid: 200, command: '/opt/homebrew/bin/bash' }
  for (const processes of [[listener], [listener, worker, child]]) {
    const f = fakePorts({ processes, diag: log() })
    await watch(f.ports)
    assert.deepEqual(f.signals, [])
    assert.deepEqual(f.lines, [])
  }
})

test('dry run logs the verdict and signals nothing', async () => {
  const f = fakePorts({ processes: [listener, worker], diag: log() })
  await watch(f.ports, { dryRun: true })
  assert.deepEqual(f.signals, [])
  assert.match(f.lines[0], /wedged .*\(dry run\)/)
})

// --- reading the diag dir ---------------------------------------------------

test('newestWorkerLog picks the newest Worker_*.log by mtime and returns its tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-watchdog-'))
  writeFileSync(join(dir, 'Worker_a.log'), 'old\n')
  writeFileSync(join(dir, 'Worker_b.log'), WEDGED_TAIL)
  writeFileSync(join(dir, 'Runner_c.log'), 'listener\n')
  utimesSync(join(dir, 'Worker_a.log'), new Date(1000), new Date(1000))
  utimesSync(join(dir, 'Worker_b.log'), new Date(2000), new Date(2000))
  utimesSync(join(dir, 'Runner_c.log'), new Date(3000), new Date(3000))
  const got = newestWorkerLog(dir)
  assert.equal(got?.path, join(dir, 'Worker_b.log'))
  assert.equal(got?.tail, WEDGED_TAIL)
  assert.equal(newestWorkerLog(join(dir, 'missing')), null)
})

// --- the LaunchAgent --------------------------------------------------------

function plistValue(plist, key) {
  const m = plist.match(new RegExp(`<key>${key}</key>\\s*<(string|integer)>([^<]*)</\\1>`))
  return m ? m[2] : null
}

test('the LaunchAgent is labelled to match its file name', () => {
  const plist = readFileSync(PLIST_URL, 'utf8')
  assert.equal(plistValue(plist, 'Label'), 'com.oakgreencc.runner-watchdog')
  assert.match(PLIST_URL.pathname, /\/com\.oakgreencc\.runner-watchdog\.plist$/)
})

test('the LaunchAgent runs this packaged script, from the central checkout', () => {
  const plist = readFileSync(PLIST_URL, 'utf8')
  const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
  const central = plistValue(plist, 'WorkingDirectory')
  assert.ok(central, 'WorkingDirectory must name the central checkout')
  assert.ok(
    args.includes(`${central}/packages/runner-watchdog/src/runner-watchdog.mjs`),
    'ProgramArguments must run packages/runner-watchdog/src/runner-watchdog.mjs in the central checkout',
  )
  assert.ok(
    fileURLToPath(new URL('../src/runner-watchdog.mjs', import.meta.url)).endsWith(
      '/packages/runner-watchdog/src/runner-watchdog.mjs',
    ),
  )
})

test('the LaunchAgent ticks often enough to free a hang inside ~6 minutes', () => {
  const plist = readFileSync(PLIST_URL, 'utf8')
  const interval = Number(plistValue(plist, 'StartInterval'))
  assert.ok(interval > 0 && interval <= 60, `StartInterval ${interval}s`)
})

test('the install instructions in the plist header use the same label and file', () => {
  const plist = readFileSync(PLIST_URL, 'utf8')
  const header = plist.slice(0, plist.indexOf('<plist'))
  assert.match(header, /packages\/runner-watchdog\/launchd\/com\.oakgreencc\.runner-watchdog\.plist/)
  assert.match(
    header,
    /launchctl bootstrap gui\/\$\(id -u\) ~\/Library\/LaunchAgents\/com\.oakgreencc\.runner-watchdog\.plist/,
  )
  assert.match(header, /launchctl bootout gui\/\$\(id -u\)\/com\.oakgreencc\.runner-watchdog/)
})

test('the package declares the script as a bin', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.bin['runner-watchdog'], './src/runner-watchdog.mjs')
})

// --- the architecture check (sektorapp/monorepo#3606) ----------------------

const X86_FILE = '/r/bin/Runner.Worker: Mach-O 64-bit executable x86_64'
const ARM_FILE = '/r/bin/Runner.Worker: Mach-O 64-bit executable arm64'

/** @param {{ out: string | Error, last?: number | null }} o */
function archPorts({ out, last = null }) {
  const lines = []
  const marks = []
  return {
    lines,
    marks,
    ports: {
      fileOutput: () => {
        if (out instanceof Error) throw out
        return out
      },
      lastWarnedMs: () => last,
      markWarned: (ms) => marks.push(ms),
      now: () => NOW,
      log: (l) => lines.push(l),
    },
  }
}

test('isX86 reads file output', () => {
  assert.equal(isX86(X86_FILE), true)
  assert.equal(isX86(ARM_FILE), false)
})

test('an x86_64 worker logs one warning naming the fix', () => {
  const f = archPorts({ out: X86_FILE })
  assert.equal(checkArch(f.ports), true)
  assert.equal(f.lines.length, 1)
  assert.match(f.lines[0], /x86_64/)
  assert.match(f.lines[0], /running-ci\.md/)
  assert.deepEqual(f.marks, [NOW])
})

test('an arm64 worker logs nothing', () => {
  const f = archPorts({ out: ARM_FILE })
  assert.equal(checkArch(f.ports), false)
  assert.deepEqual(f.lines, [])
})

test('the x86_64 warning repeats at most once a day', () => {
  const recent = archPorts({ out: X86_FILE, last: NOW - ARCH_WARN_INTERVAL_MS + 1000 })
  assert.equal(checkArch(recent.ports), false)
  assert.deepEqual(recent.lines, [])
  const old = archPorts({ out: X86_FILE, last: NOW - ARCH_WARN_INTERVAL_MS - 1000 })
  assert.equal(checkArch(old.ports), true)
})

test('an unreadable binary does not throw', () => {
  const f = archPorts({ out: new Error('ENOENT') })
  assert.equal(checkArch(f.ports), false)
  assert.deepEqual(f.lines, [])
})

// --- the Listener ------------------------------------------------------------

const idle = [listener]
const busy = [listener, worker]
const conns = (n) => () => n

test('isListener matches the Listener executable only', () => {
  assert.equal(isListener(LISTENER_PATH), true)
  assert.equal(isListener(WORKER_PATH), false)
})

test('an idle Listener holding a connection is healthy', () => {
  const a = assessListener({ processes: idle, connections: conns(1), unpolledSince: null, now: NOW })
  assert.equal(a.verdict, 'healthy')
})

test('a Listener with a Worker alive is never unpolled, connections or not', () => {
  const a = assessListener({
    processes: busy,
    connections: conns(0),
    unpolledSince: { pid: 100, sinceMs: NOW - UNPOLLED_MS * 10 },
    now: NOW,
  })
  assert.equal(a.verdict, 'healthy')
})

test('no connection starts a pending clock; past UNPOLLED_MS it is unpolled', () => {
  const first = assessListener({ processes: idle, connections: conns(0), unpolledSince: null, now: NOW })
  assert.equal(first.verdict, 'pending')
  assert.equal(first.sinceMs, NOW)
  const later = assessListener({
    processes: idle,
    connections: conns(0),
    unpolledSince: { pid: 100, sinceMs: NOW - UNPOLLED_MS },
    now: NOW,
  })
  assert.equal(later.verdict, 'unpolled')
})

test('a record for another pid does not carry over to a new Listener', () => {
  const a = assessListener({
    processes: idle,
    connections: conns(0),
    unpolledSince: { pid: 999, sinceMs: NOW - UNPOLLED_MS * 10 },
    now: NOW,
  })
  assert.equal(a.verdict, 'pending')
})

test('an lsof that fails is not evidence', () => {
  const a = assessListener({
    processes: idle,
    connections: () => {
      throw new Error('lsof: not found')
    },
    unpolledSince: { pid: 100, sinceMs: NOW - UNPOLLED_MS * 10 },
    now: NOW,
  })
  assert.equal(a.verdict, 'healthy')
})

test('no Listener, or two, is never unpolled', () => {
  assert.equal(assessListener({ processes: [], connections: conns(0), unpolledSince: null, now: NOW }).verdict, 'none')
  const two = [listener, { pid: 101, ppid: 1, command: LISTENER_PATH }]
  assert.equal(
    assessListener({ processes: two, connections: conns(0), unpolledSince: null, now: NOW }).verdict,
    'ambiguous',
  )
})

function listenerPorts({ processes = idle, open = 0, state = null, lastRestart = null, restart } = {}) {
  /** @type {string[]} */
  const lines = []
  const f = {
    lines,
    state,
    restarts: 0,
    marked: /** @type {number | null} */ (null),
  }
  f.ports = {
    listProcesses: () => processes,
    connections: conns(open),
    readUnpolled: () => f.state,
    writeUnpolled: (s) => {
      f.state = s
    },
    lastRestartMs: () => lastRestart,
    markRestarted: (ms) => {
      f.marked = ms
    },
    restart:
      restart ??
      (() => {
        f.restarts++
        return 'launchctl kickstart -k gui/501/actions.runner.x'
      }),
    now: () => NOW,
    log: (l) => lines.push(l),
  }
  return f
}

test('pending records when the silence began and does nothing else', () => {
  const f = listenerPorts()
  const { assessment, actions } = watchListener(f.ports)
  assert.equal(assessment.verdict, 'pending')
  assert.deepEqual(f.state, { pid: 100, sinceMs: NOW })
  assert.deepEqual(actions, [])
  assert.deepEqual(f.lines, [])
})

test('unpolled → restart, logged, stamped, and the clock cleared', () => {
  const f = listenerPorts({ state: { pid: 100, sinceMs: NOW - UNPOLLED_MS } })
  const { actions } = watchListener(f.ports)
  assert.deepEqual(actions, ['restart'])
  assert.equal(f.restarts, 1)
  assert.equal(f.marked, NOW)
  assert.equal(f.state, null)
  assert.match(f.lines[0], /unpolled/)
  assert.match(f.lines[1], /restarted .*launchctl kickstart -k/)
})

test('a restart inside the cooldown is skipped', () => {
  const f = listenerPorts({
    state: { pid: 100, sinceMs: NOW - UNPOLLED_MS },
    lastRestart: NOW - RESTART_COOLDOWN_MS + 1000,
  })
  watchListener(f.ports)
  assert.equal(f.restarts, 0)
  assert.deepEqual(f.lines, [])
})

test('a connection coming back clears the clock', () => {
  const f = listenerPorts({ open: 1, state: { pid: 100, sinceMs: NOW - 60_000 } })
  assert.equal(watchListener(f.ports).assessment.verdict, 'healthy')
  assert.equal(f.state, null)
})

test('dry run logs the verdict and restarts nothing', () => {
  const f = listenerPorts({ state: { pid: 100, sinceMs: NOW - UNPOLLED_MS } })
  watchListener(f.ports, { dryRun: true })
  assert.equal(f.restarts, 0)
  assert.equal(f.marked, null)
  assert.match(f.lines[0], /unpolled .*\(dry run\)/)
})

test('a failed restart is logged, and still starts the cooldown', () => {
  const f = listenerPorts({
    state: { pid: 100, sinceMs: NOW - UNPOLLED_MS },
    restart: () => {
      throw new Error('Could not find service')
    },
  })
  const { actions } = watchListener(f.ports)
  assert.deepEqual(actions, [])
  assert.equal(f.marked, NOW)
  assert.match(f.lines[1], /error .*restart failed: Could not find service/)
})

test('countLsofConnections counts n lines of lsof -Fn output', () => {
  assert.equal(countLsofConnections('p52898\nf12\nn192.168.86.22:54390->20.85.130.105:443\n'), 1)
  assert.equal(countLsofConnections('p1\nf3\nna->b\nf4\nnc->d\n'), 2)
  assert.equal(countLsofConnections(''), 0)
})

test('serviceLabel is the plist basename that svc.sh wrote to .service', () => {
  assert.equal(
    serviceLabel('/Users/x/Library/LaunchAgents/actions.runner.sektorapp.Jamess-MacBook-Pro.plist\n'),
    'actions.runner.sektorapp.Jamess-MacBook-Pro',
  )
  assert.throws(() => serviceLabel('  '))
})
