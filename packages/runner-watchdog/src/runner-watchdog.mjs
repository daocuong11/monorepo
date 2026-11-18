#!/usr/bin/env node
// @ts-check
/**
 * Free the self-hosted runner from a `Runner.Worker` wedged spawning a step.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (sektorapp/monorepo#1739).
 *
 * The runner's `Runner.Worker` sometimes hangs while spawning a `run:` step's
 * bash. Its newest `_diag/Worker_*.log` ends on the `ProcessInvokerWrapper]
 * Starting process:` block, with no `Process started with process id` line
 * after it, and the worker sits at ~0% CPU with no child process. The runner
 * takes one job at a time, so every queued run — `develop` CD included — waits
 * behind it until `timeout-minutes` plus the 5-minute cancellation grace fires:
 * 35 minutes for `ci`, 65 for `deploy-infra`/`cd`.
 *
 * `docs/guidelines/running-ci.md` in sektorapp/monorepo, § "A job that is
 * `in_progress` but doing nothing", documents the manual fix as rung 2: kill only the worker. The
 * listener survives and takes the next job. This script takes that rung, from
 * launchd, so nobody has to be watching.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL AND WILL NOT TOUCH.
 *
 * A worker is wedged only when every one of these holds:
 *
 *   - it has no child process — a step that is running has one;
 *   - the newest `Worker_*.log` has a `Starting process:` block with no
 *     `Process started` after it, and nothing but `ProcessInvokerWrapper]`
 *     lines follow it — the worker never got past the spawn;
 *   - that log has not been written for `STALE_MS` — a healthy spawn logs
 *     `Process started` within milliseconds.
 *
 * A worker with children, or whose log is still moving, is a slow step and not
 * a hang, and is never signalled. With more than one `Runner.Worker` alive the
 * newest log cannot be attributed to a pid, so nothing is signalled and the
 * verdict says so. Only a process whose executable is named `Runner.Worker` can
 * be a target; the Listener is never signalled and never restarted (rung 3 does
 * not free this hang — the old worker outlived it on 2026-10-10).
 *
 * The kill is SIGTERM, then SIGKILL after `GRACE_MS` if the same pid is still a
 * `Runner.Worker`. On 2026-10-10 only `-9` ended it.
 *
 * Before SIGTERM, a wedged worker is sampled (`sample <pid> 3`) into
 * `<runnerDir>/wedge-<iso>-<pid>.sample.txt`, so the hung frames survive the
 * kill (sektorapp/monorepo#3107 — the cause of the wedge is not settled). The capture is bounded
 * by `CAPTURE_TIMEOUT_MS` and its failure never delays or prevents the kill;
 * either way it logs one `captured` or `capture-failed` line.
 *
 * Once a day it also runs `file` on `<runnerDir>/bin/Runner.Worker` and, when
 * that says `x86_64`, logs one `x86_64` line naming the fix (sektorapp/monorepo#3606): the x64
 * build under Rosetta 2 is the cause of the wedge (sektorapp/monorepo#3107, #3446), and nothing
 * else would notice the runner drifting back to it. A log line only — no alert
 * channel — and an unreadable binary is silent.
 *
 * Every verdict other than "nothing to do" and every signal goes to
 * `<runnerDir>/runner-watchdog.log`, one line each, naming the worker pid, the
 * diag log and its last line — so later occurrences can be counted from it.
 *
 * Usage:
 *   node packages/runner-watchdog/src/runner-watchdog.mjs [--dry-run] [--quiet]
 *   pnpm exec runner-watchdog [--dry-run] [--quiet]
 *
 * Reads `FACTORY_RUNNER_DIR` (default `~/SeKtor/actions-runner`), as
 * sektorapp/monorepo's `factory.mjs` does.
 */
import { execFile, execFileSync } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

/** How long the diag log must be silent before a spawn counts as hung. */
export const STALE_MS = 5 * 60 * 1000

/** How long SIGTERM gets before SIGKILL. */
export const GRACE_MS = 10 * 1000

/** The longest a capture may hold up the kill (sektorapp/monorepo#3107: 15 s or less). */
export const CAPTURE_TIMEOUT_MS = 15 * 1000

/** Seconds `sample` records the wedged worker for. */
const SAMPLE_SECONDS = 3

/** How much of the log's end is read; a spawn block is ~12 short lines. */
const TAIL_BYTES = 64 * 1024

/** Keep the log readable by hand. */
const LOG_MAX_BYTES = 256 * 1024

const WORKER = 'Runner.Worker'
const SPAWN = 'ProcessInvokerWrapper] Starting process:'
const STARTED = 'Process started with process id'
const INVOKER = 'ProcessInvokerWrapper]'

/**
 * @typedef {{ pid: number, ppid: number, command: string }} Proc
 * @typedef {{ path: string, mtimeMs: number, tail: string }} DiagLog
 * @typedef {{ verdict: 'none' | 'healthy' | 'ambiguous' | 'wedged', reason: string,
 *   pid?: number, log?: string, lastLine?: string }} Assessment
 */

/** True when `command` (a path or bare name, as `ps -o comm=` prints) is the worker. */
export function isWorker(command) {
  return basename(String(command).trim()) === WORKER
}

/** The last non-empty line of a log tail. */
export function lastLine(tail) {
  const lines = String(tail)
    .split('\n')
    .filter((l) => l.trim() !== '')
  return lines[lines.length - 1] ?? ''
}

/**
 * True when the log tail ends inside a spawn block: a `Starting process:` with
 * no `Process started` after it. Directory lookups can be logged after a stuck
 * cleanup spawn; they do not mean the process started or the worker moved on.
 */
export function endsOnSpawn(tail) {
  const lines = String(tail)
    .split('\n')
    .filter((l) => l.trim() !== '')
  let at = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(SPAWN)) {
      at = i
      break
    }
  }
  if (at === -1) return false
  return lines
    .slice(at + 1)
    .every(
      (l) =>
        (l.includes(INVOKER) && !l.includes(STARTED)) ||
        / INFO HostContext\] Well known directory '(?:Bin|Root|Work)': /.test(l),
    )
}

/**
 * Decide, from a snapshot, whether a worker is wedged.
 *
 * Pure on purpose: the precedence of the refusals is the
 * part worth testing, and it needs no runner to hand.
 *
 * @param {{ processes: Proc[], log: DiagLog | null, now: number, staleMs?: number }} snapshot
 * @returns {Assessment}
 */
export function assess({ processes, log, now, staleMs = STALE_MS }) {
  const workers = processes.filter((p) => isWorker(p.command))
  if (workers.length === 0) return { verdict: 'none', reason: 'no Runner.Worker' }

  const logPath = log?.path ?? '-'
  const last = log ? lastLine(log.tail) : ''
  if (workers.length > 1) {
    return {
      verdict: 'ambiguous',
      reason: `${workers.length} Runner.Worker processes (${workers.map((w) => w.pid).join(',')}) — the newest log cannot be attributed, touching none`,
      log: logPath,
      lastLine: last,
    }
  }

  const [worker] = workers
  const base = { pid: worker.pid, log: logPath, lastLine: last }
  const children = processes.filter((p) => p.ppid === worker.pid)
  if (children.length > 0) {
    return { verdict: 'healthy', reason: `has ${children.length} child process(es)`, ...base }
  }
  if (!log) return { verdict: 'healthy', reason: 'no Worker_*.log to read', ...base }
  if (!endsOnSpawn(log.tail)) {
    return { verdict: 'healthy', reason: 'log does not end on a spawn block', ...base }
  }
  const silentMs = now - log.mtimeMs
  if (silentMs < staleMs) {
    return {
      verdict: 'healthy',
      reason: `log ends on a spawn but was written ${Math.round(silentMs / 1000)}s ago`,
      ...base,
    }
  }
  return {
    verdict: 'wedged',
    reason: `no child, log ends on a spawn with no Process started, silent ${Math.round(silentMs / 1000)}s`,
    ...base,
  }
}

/**
 * One greppable line.
 *
 * @param {string} iso
 * @param {string} event
 * @param {{ pid?: number, log?: string, lastLine?: string, reason?: string }} [fields]
 */
export function formatLogLine(iso, event, { pid, log, lastLine: last, reason } = {}) {
  const flat = (s) =>
    String(s ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  return `${iso}  ${event.padEnd(8)}  pid=${pid ?? '-'} log=${log ?? '-'}  ${flat(reason)}  last=${flat(last)}`
}

/** How often the architecture warning may repeat. */
export const ARCH_WARN_INTERVAL_MS = 24 * 60 * 60 * 1000

/** True when `file` output describes an x86_64 (Intel, Rosetta-translated) binary. */
export function isX86(fileOutput) {
  return /\bx86_64\b/.test(String(fileOutput))
}

/**
 * Log one line, at most once per `ARCH_WARN_INTERVAL_MS`, when the worker binary
 * is x86_64. Never throws: a missing or unreadable binary is not a finding.
 *
 * @param {{
 *   fileOutput: () => string,
 *   lastWarnedMs: () => number | null,
 *   markWarned: (ms: number) => void,
 *   now: () => number,
 *   log: (line: string) => void,
 * }} ports `fileOutput` is `file <runnerDir>/bin/Runner.Worker`'s stdout.
 * @returns {boolean} whether a warning was logged
 */
export function checkArch(ports) {
  try {
    if (!isX86(ports.fileOutput())) return false
    const now = ports.now()
    const last = ports.lastWarnedMs()
    if (last !== null && now - last < ARCH_WARN_INTERVAL_MS) return false
    ports.log(
      formatLogLine(new Date(now).toISOString(), 'x86_64', {
        reason: `${WORKER} is the x86_64 build, running under Rosetta 2, which wedges spawns; reinstall from the arm64 package (docs/guidelines/running-ci.md in sektorapp/monorepo, sektorapp/monorepo#3107)`,
      }),
    )
    ports.markWarned(now)
    return true
  } catch {
    return false
  }
}

/**
 * Run one check and, unless `dryRun`, kill a wedged worker.
 *
 * Every effect goes through `ports`, so the kill sequence is tested without a
 * runner. Returns the assessment and what was done.
 *
 * @param {{
 *   listProcesses: () => Proc[],
 *   newestLog: () => DiagLog | null,
 *   now: () => number,
 *   signal: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => void,
 *   sleep: (ms: number) => Promise<void>,
 *   log: (line: string) => void,
 *   capture: (pid: number) => string | Promise<string>,
 * }} ports `capture` records the live worker's stacks and returns where it wrote them.
 * @param {{ dryRun?: boolean, staleMs?: number, graceMs?: number, captureTimeoutMs?: number }} [opts]
 */
export async function watch(
  ports,
  { dryRun = false, staleMs = STALE_MS, graceMs = GRACE_MS, captureTimeoutMs = CAPTURE_TIMEOUT_MS } = {},
) {
  const iso = () => new Date(ports.now()).toISOString()
  const a = assess({
    processes: ports.listProcesses(),
    log: ports.newestLog(),
    now: ports.now(),
    staleMs,
  })
  /** @type {string[]} */
  const actions = []

  if (a.verdict === 'none' || a.verdict === 'healthy') return { assessment: a, actions }
  if (a.verdict === 'ambiguous') {
    ports.log(formatLogLine(iso(), 'ambiguous', a))
    return { assessment: a, actions }
  }

  ports.log(formatLogLine(iso(), 'wedged', { ...a, reason: `${a.reason}${dryRun ? ' (dry run)' : ''}` }))
  if (dryRun || a.pid === undefined) return { assessment: a, actions }
  const pid = a.pid

  /** Still the same worker? A recycled pid must never be signalled. */
  const stillWorker = () => ports.listProcesses().some((p) => p.pid === pid && isWorker(p.command))

  const send = (sig) => {
    try {
      ports.signal(pid, sig)
      actions.push(sig)
      ports.log(formatLogLine(iso(), sig, { ...a, reason: `sent ${sig}` }))
    } catch (/** @type {any} */ err) {
      ports.log(formatLogLine(iso(), 'error', { ...a, reason: `${sig} failed: ${err?.message ?? err}` }))
    }
  }

  // Evidence first (sektorapp/monorepo#3107): once killed, the hung frames are gone. Bounded, and
  // a capture that throws or hangs still falls through to the kill.
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  try {
    const path = await Promise.race([
      Promise.resolve().then(() => ports.capture(pid)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${Math.round(captureTimeoutMs / 1000)}s`)),
          captureTimeoutMs,
        )
      }),
    ])
    actions.push('capture')
    ports.log(formatLogLine(iso(), 'captured', { ...a, reason: `sample at ${path}` }))
  } catch (/** @type {any} */ err) {
    ports.log(formatLogLine(iso(), 'capture-failed', { ...a, reason: err?.message ?? err }))
  } finally {
    clearTimeout(timer)
  }

  send('SIGTERM')
  await ports.sleep(graceMs)
  if (stillWorker()) {
    send('SIGKILL')
    await ports.sleep(1000)
    if (stillWorker()) {
      ports.log(formatLogLine(iso(), 'error', { ...a, reason: 'still alive after SIGKILL' }))
    } else {
      ports.log(formatLogLine(iso(), 'freed', { ...a, reason: 'gone after SIGKILL' }))
    }
  } else {
    ports.log(formatLogLine(iso(), 'freed', { ...a, reason: 'gone after SIGTERM' }))
  }
  return { assessment: a, actions }
}

// --- real ports ------------------------------------------------------------

/** `ps -axo pid=,ppid=,comm=` rows. `comm` may be a path containing spaces. */
export function parsePs(text) {
  /** @type {Proc[]} */
  const out = []
  for (const row of String(text).split('\n')) {
    const m = row.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] })
  }
  return out
}

/** The newest `Worker_*.log` in `diagDir`, by mtime, with the end of its text. */
export function newestWorkerLog(diagDir) {
  if (!existsSync(diagDir)) return null
  let best = null
  for (const name of readdirSync(diagDir)) {
    if (!/^Worker_.*\.log$/.test(name)) continue
    const path = join(diagDir, name)
    const { mtimeMs, size } = statSync(path)
    if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs, size }
  }
  if (!best) return null
  const len = Math.min(best.size, TAIL_BYTES)
  const buf = Buffer.alloc(len)
  const fd = openSync(best.path, 'r')
  try {
    readSync(fd, buf, 0, len, best.size - len)
  } finally {
    closeSync(fd)
  }
  return { path: best.path, mtimeMs: best.mtimeMs, tail: buf.toString('utf8') }
}

/** `wedge-<iso>-<pid>.sample.txt`, with the ISO's colons made filename-safe. */
export function captureFileName(iso, pid) {
  return `wedge-${String(iso).replace(/:/g, '-')}-${pid}.sample.txt`
}

/**
 * `sample <pid> 3 -file <path>`, killed at `timeoutMs`. Resolves to the path.
 *
 * @param {string} runnerDir
 * @param {number} pid
 * @param {number} nowMs
 * @param {number} [timeoutMs]
 */
export async function sampleWorker(runnerDir, pid, nowMs, timeoutMs = CAPTURE_TIMEOUT_MS) {
  const path = join(runnerDir, captureFileName(new Date(nowMs).toISOString(), pid))
  await promisify(execFile)('sample', [String(pid), String(SAMPLE_SECONDS), '-file', path], {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  })
  if (!existsSync(path)) throw new Error(`sample exited without writing ${path}`)
  return path
}

function appendLog(logPath, line, quiet) {
  if (!quiet) console.log(line)
  try {
    if (existsSync(logPath) && statSync(logPath).size > LOG_MAX_BYTES) {
      const kept = readFileSync(logPath, 'utf8').split('\n').slice(-2000).join('\n')
      writeFileSync(logPath, kept)
    }
    appendFileSync(logPath, `${line}\n`)
  } catch (/** @type {any} */ err) {
    console.error(`could not write ${logPath}: ${err?.message ?? err}`)
  }
}

/* c8 ignore start — wiring and argv only; `watch` is what the tests drive */
async function main() {
  const argv = process.argv.slice(2)
  const quiet = argv.includes('--quiet')
  const runnerDir = process.env.FACTORY_RUNNER_DIR ?? join(homedir(), 'SeKtor', 'actions-runner')
  const logPath = join(runnerDir, 'runner-watchdog.log')
  const stamp = join(runnerDir, 'runner-watchdog.arch-warned')
  checkArch({
    fileOutput: () => execFileSync('file', [join(runnerDir, 'bin', WORKER)], { encoding: 'utf8', timeout: 5000 }),
    lastWarnedMs: () => (existsSync(stamp) ? statSync(stamp).mtimeMs : null),
    markWarned: () => writeFileSync(stamp, ''),
    now: () => Date.now(),
    log: (line) => appendLog(logPath, line, quiet),
  })
  const { assessment } = await watch(
    {
      listProcesses: () => parsePs(execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })),
      newestLog: () => newestWorkerLog(join(runnerDir, '_diag')),
      now: () => Date.now(),
      signal: (pid, sig) => process.kill(pid, sig),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (line) => appendLog(logPath, line, quiet),
      capture: (pid) => sampleWorker(runnerDir, pid, Date.now()),
    },
    { dryRun: argv.includes('--dry-run') },
  )
  if (!quiet) console.log(`${assessment.verdict}: ${assessment.reason}`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`runner-watchdog: ${err?.message ?? err}`)
      process.exit(1)
    },
  )
}
/* c8 ignore stop */
