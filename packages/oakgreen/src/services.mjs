// @ts-check
/**
 * The stack's long-running services: launchd user agents (macOS).
 *
 * - `start`: install the agent when its tool can (`cambium install`, `mycelium install`, `canopy install`,
 *   `oakgreen proxy install`), enable
 *   it, load it.
 * - `stop`: disable and unload it, so it stays stopped across logins until `start`.
 * - `restart`: a new process on the same agent definition. SIGTERM, then launchd's KeepAlive starts it again
 *   (cambium finishes its current tick first; its workers keep running). Picks up new code after an npm update.
 * - `reload`: re-read the agent's plist too (its environment, e.g. OTEL_*, or the program path): `bootout`,
 *   wait until launchd has let go of it, then `bootstrap`. Waiting matters: bootstrapping while the old process
 *   is still finishing a tick fails with "Bootstrap failed: 5: Input/output error".
 *
 * Order is otelcol, cambium, mycelium, canopy, proxy, so the first spans have a collector to go to and the page comes up
 * over a running stack; `stop` goes in reverse.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * `install`: the tool whose `install` writes the agent; `'oakgreen'` for one oakgreen writes itself (`proxy`).
 * @typedef {{ name: string, label: string, what: string, install?: import('./tools.mjs').Tool | 'oakgreen' }} Service
 */

/** @type {readonly Service[]} */
export const SERVICES = Object.freeze([
  { name: 'otelcol', label: 'com.oakgreencc.otelcol', what: 'OpenTelemetry collector (traces for canopy)' },
  { name: 'cambium', label: 'com.oakgreencc.cambium', what: 'the scheduler daemon', install: 'cambium' },
  { name: 'mycelium', label: 'com.oakgreencc.mycelium', what: 'intake connectors', install: 'mycelium' },
  { name: 'canopy', label: 'com.oakgreencc.canopy', what: 'the local status page', install: 'canopy' },
  { name: 'proxy', label: 'com.oakgreencc.proxy', what: 'http://<name>.localhost/ on :80', install: 'oakgreen' },
])

/**
 * @typedef {{
 *   exec: import('./tools.mjs').Exec,
 *   home: string,
 *   uid: number,
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   runTool?: (tool: import('./tools.mjs').Tool, args: string[]) => Promise<import('./tools.mjs').Result>,
 *   installSelf?: (service: string) => Promise<import('./tools.mjs').Result>,
 * }} Ports
 * @typedef {{
 *   name: string, label: string, what: string, plist: string, installed: boolean, loaded: boolean,
 *   pid: number | null, state: string | null, lastExit: string | null,
 * }} Status
 * @typedef {{ name: string, ok: boolean, detail: string }} Outcome
 */

export const plistOf = (/** @type {string} */ home, /** @type {string} */ label) =>
  join(home, 'Library', 'LaunchAgents', `${label}.plist`)

/** `launchctl print` fields this needs. @param {string} text */
export function parsePrint(text) {
  const field = (/** @type {string} */ k) => new RegExp(`^\\s*${k} = (.+)$`, 'm').exec(text)?.[1]?.trim() ?? null
  const pid = Number(field('pid'))
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    state: field('state'),
    lastExit: field('last exit code'),
  }
}

/** @param {Ports} p */
const target = (p) => `gui/${p.uid}`

/** @param {Ports} p @param {Service} s @returns {Promise<Status>} */
export async function statusOf(p, s) {
  const plist = plistOf(p.home, s.label)
  const installed = (p.exists ?? existsSync)(plist)
  const r = await p.exec('launchctl', ['print', `${target(p)}/${s.label}`])
  const parsed = r.code === 0 ? parsePrint(r.stdout) : { pid: null, state: null, lastExit: null }
  return { ...s, plist, installed, loaded: r.code === 0, ...parsed }
}

/**
 * Poll `statusOf` until `done` or the deadline. @param {Ports} p @param {Service} s
 * @param {(st: Status) => boolean} done @returns {Promise<Status | null>} null on timeout
 */
async function waitFor(p, s, done) {
  const now = p.now ?? Date.now
  const sleep = p.sleep ?? delay
  const deadline = now() + (p.timeoutMs ?? 180_000)
  for (;;) {
    const st = await statusOf(p, s)
    if (done(st)) return st
    if (now() >= deadline) return null
    await sleep(1000)
  }
}

const running = (/** @type {Status} */ st) => st.loaded && st.pid !== null

/** Load it (retrying while launchd still holds the old one), then wait for a process. @param {Ports} p @param {Service} s @param {string} plist @returns {Promise<Outcome>} */
async function bootstrap(p, s, plist) {
  // A stopped (disabled) agent refuses to bootstrap; enabling an enabled one is a no-op.
  await p.exec('launchctl', ['enable', `${target(p)}/${s.label}`])
  for (let i = 0; ; i++) {
    const r = await p.exec('launchctl', ['bootstrap', target(p), plist])
    if (r.code === 0) break
    if (i >= 9) return { name: s.name, ok: false, detail: `launchctl bootstrap: ${(r.stderr || r.stdout).trim()}` }
    await (p.sleep ?? delay)(3000)
  }
  const up = await waitFor(p, s, running)
  return up
    ? { name: s.name, ok: true, detail: `loaded, pid ${up.pid}` }
    : { name: s.name, ok: false, detail: 'loaded but no process came up; see its logs' }
}

/**
 * New process, same definition. Not loaded but installed: load it.
 * @param {Ports} p @param {Service} s @returns {Promise<Outcome>}
 */
export async function restart(p, s) {
  const st = await statusOf(p, s)
  if (!st.loaded) return st.installed ? bootstrap(p, s, st.plist) : notInstalled(s)
  const r = await p.exec('launchctl', ['kill', 'TERM', `${target(p)}/${s.label}`])
  if (r.code !== 0 && st.pid !== null)
    return { name: s.name, ok: false, detail: `launchctl kill TERM: ${(r.stderr || r.stdout).trim()}` }
  const before = st.pid
  const up = await waitFor(p, s, (x) => running(x) && x.pid !== before)
  return up
    ? { name: s.name, ok: true, detail: `restarted, pid ${before ?? '–'} → ${up.pid}` }
    : { name: s.name, ok: false, detail: `no new process within the timeout (was pid ${before ?? '–'})` }
}

/**
 * Re-read the plist: unload, wait until launchd has let go, load.
 * @param {Ports} p @param {Service} s @returns {Promise<Outcome>}
 */
export async function reload(p, s) {
  const st = await statusOf(p, s)
  if (!st.installed) return notInstalled(s)
  if (st.loaded) {
    await p.exec('launchctl', ['bootout', `${target(p)}/${s.label}`])
    const gone = await waitFor(p, s, (x) => !x.loaded)
    if (!gone) return { name: s.name, ok: false, detail: 'still loaded after bootout; it may be finishing a tick' }
  }
  return bootstrap(p, s, st.plist)
}

/**
 * Installed and running afterwards. Not installed: its tool writes the agent first, when it has one.
 * @param {Ports} p @param {Service} s @returns {Promise<Outcome>}
 */
export async function start(p, s) {
  let st = await statusOf(p, s)
  if (running(st)) return { name: s.name, ok: true, detail: `already running, pid ${st.pid}` }
  if (!st.installed) {
    const r =
      s.install === 'oakgreen'
        ? await p.installSelf?.(s.name)
        : s.install && (await p.runTool?.(s.install, ['install']))
    if (!r) return notInstalled(s)
    st = await statusOf(p, s)
    if (r.code !== 0 || !st.installed) {
      const why = (r.stderr || r.stdout).trim().split('\n').at(-1) || `exit ${r.code}`
      return { name: s.name, ok: false, detail: `${s.install} install: ${why}` }
    }
  }
  if (st.loaded) {
    const r = await p.exec('launchctl', ['kickstart', `${target(p)}/${s.label}`])
    if (r.code !== 0)
      return { name: s.name, ok: false, detail: `launchctl kickstart: ${(r.stderr || r.stdout).trim()}` }
    const up = await waitFor(p, s, running)
    return up
      ? { name: s.name, ok: true, detail: `started, pid ${up.pid}` }
      : { name: s.name, ok: false, detail: 'no process came up; see its logs' }
  }
  return bootstrap(p, s, st.plist)
}

/**
 * Disable, then unload and wait for the process to go. The plist stays, so `start` brings it back.
 * @param {Ports} p @param {Service} s @returns {Promise<Outcome>}
 */
export async function stop(p, s) {
  const st = await statusOf(p, s)
  await p.exec('launchctl', ['disable', `${target(p)}/${s.label}`])
  if (!st.loaded) return { name: s.name, ok: true, detail: st.installed ? 'not running' : 'not installed' }
  await p.exec('launchctl', ['bootout', `${target(p)}/${s.label}`])
  const gone = await waitFor(p, s, (x) => !x.loaded)
  return gone
    ? { name: s.name, ok: true, detail: `stopped (was pid ${st.pid ?? '–'})` }
    : { name: s.name, ok: false, detail: 'still loaded after bootout; it may be finishing a tick' }
}

/** @param {Service} s @returns {Outcome} */
const notInstalled = (s) => ({
  name: s.name,
  ok: false,
  detail: `not installed (no ${s.label}.plist in ~/Library/LaunchAgents)`,
})

/**
 * The services named (all, when none are), in stack order; unknown names are an error.
 * @param {string[]} names @returns {{ services: Service[], unknown: string[] }}
 */
export function pick(names) {
  const unknown = names.filter((n) => !SERVICES.some((s) => s.name === n))
  return { services: names.length ? SERVICES.filter((s) => names.includes(s.name)) : [...SERVICES], unknown }
}

/**
 * `oakgreen services | start | stop | restart | reload [name...]`. With no names, every service; one that is not
 * installed (and, for `start`, cannot be) is skipped, and only an error when named.
 *
 * @param {Verb} verb @param {string[]} names @param {Ports & { json?: boolean }} p
 * @param {(s: string) => void} out @param {(s: string) => void} err
 * @returns {Promise<number>}
 */
export async function runServices(verb, names, p, out, err) {
  const act = { start, stop, restart, reload }
  if ((p.platform ?? process.platform) !== 'darwin') {
    err(`oakgreen ${verb}: services are launchd agents; this is macOS only for now\n`)
    return 2
  }
  const { services, unknown } = pick(names)
  if (unknown.length) {
    err(`oakgreen ${verb}: unknown service ${unknown.join(', ')} (known: ${SERVICES.map((s) => s.name).join(', ')})\n`)
    return 2
  }
  if (verb === 'services') {
    const list = await Promise.all(services.map((s) => statusOf(p, s)))
    out(p.json ? `${JSON.stringify(list, null, 2)}\n` : formatStatus(list))
    return 0
  }
  let ok = true
  for (const s of verb === 'stop' ? [...services].reverse() : services) {
    const st = await statusOf(p, s)
    if (!st.installed && !names.length && !(verb === 'start' && s.install)) {
      out(`· ${s.name.padEnd(8)} not installed, skipped\n`)
      continue
    }
    out(`… ${s.name.padEnd(8)} ${ING[verb]}\n`)
    const r = await act[verb](p, s)
    // `start` with no names tries to install every service; one that cannot be (not configured) is skipped.
    if (!r.ok && verb === 'start' && !st.installed && !names.length) {
      out(`· ${s.name.padEnd(8)} skipped: ${r.detail}\n`)
      continue
    }
    out(`${r.ok ? '✓' : '✗'} ${s.name.padEnd(8)} ${r.detail}\n`)
    ok &&= r.ok
  }
  return ok ? 0 : 1
}

/** @typedef {'services' | 'start' | 'stop' | 'restart' | 'reload'} Verb */
const ING = { start: 'starting', stop: 'stopping', restart: 'restarting', reload: 'reloading' }

/** @param {Status[]} list */
export function formatStatus(list) {
  const rows = list.map((st) => {
    const mark = running(st) ? '✓' : st.installed ? '✗' : '·'
    const detail = running(st)
      ? `running, pid ${st.pid}`
      : st.loaded
        ? `loaded, not running${st.lastExit ? ` (last exit ${st.lastExit})` : ''}`
        : st.installed
          ? `installed, not loaded: oakgreen start ${st.name}`
          : 'not installed'
    return `${mark} ${st.name.padEnd(8)} ${detail}  — ${st.what}`
  })
  return `${rows.join('\n')}\n`
}
