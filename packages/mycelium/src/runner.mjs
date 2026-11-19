// @ts-check
import { ASC_ENV, ascConfig, ascSource } from './sources/asc.mjs'
import { DISCORD_ENV, discordChannel, discordConfig, discordSource } from './sources/discord.mjs'
import { PLAY_ENV, playConfig, playSource } from './sources/play.mjs'

export const SOURCES = /** @type {const} */ (['discord', 'asc', 'play'])
export const BACKFILL_HOURS = 24

/**
 * @typedef {{
 *   name: string,
 *   intervalMs: number,
 *   pull: (cursor: any, at: { now: number, since: number }) => Promise<{ envelope: import('./envelope.mjs').Envelope | null, cursor: any }[]>,
 * }} Source
 * @typedef {{ get: (key: string) => any, set: (key: string, cursor: any) => void }} State
 */

const NEEDS = {
  discord: DISCORD_ENV.slice(0, 2),
  asc: ASC_ENV,
  play: [PLAY_ENV[0], `${PLAY_ENV[1]} or ${PLAY_ENV[2]}`],
}

/**
 * One source from the environment, or an error naming what it needs.
 *
 * @param {string} name
 * @param {{ env: Record<string, string | undefined>, fetch: import('./http.mjs').Fetch, sleep?: (ms: number) => Promise<void> }} ports
 * @returns {Source}
 */
export function sourceFromEnv(name, { env, fetch, sleep }) {
  const interval = Number(env[`MYCELIUM_${name.toUpperCase()}_INTERVAL_S`])
  const intervalMs = Number.isFinite(interval) && interval > 0 ? interval * 1000 : undefined
  const make = {
    discord: () => {
      const config = discordConfig(env)
      return config && discordSource({ fetch, sleep, config, intervalMs })
    },
    asc: () => {
      const config = ascConfig(env)
      return config && ascSource({ fetch, sleep, config, intervalMs })
    },
    play: () => {
      const config = playConfig(env)
      return config && playSource({ fetch, sleep, config, intervalMs })
    },
  }[name]
  if (!make) throw new Error(`unknown source '${name}'; the sources are ${SOURCES.join(', ')}`)
  const source = make()
  if (!source) throw new Error(`${name}: not configured; set ${NEEDS[/** @type {keyof NEEDS} */ (name)].join(', ')}`)
  return source
}

const truthy = (/** @type {string | undefined} */ v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim())

/**
 * The notifier's reply channels, one per source that opted in
 * (`MYCELIUM_<SOURCE>_NOTIFY=true`) and is configured. Empty: no notifier.
 *
 * @param {{ env: Record<string, string | undefined>, fetch: import('./http.mjs').Fetch, sleep?: (ms: number) => Promise<void> }} ports
 * @returns {Record<string, import('./notify.mjs').Channel>}
 */
export function channelsFromEnv({ env, fetch, sleep }) {
  /** @type {Record<string, import('./notify.mjs').Channel>} */
  const channels = {}
  if (truthy(env.MYCELIUM_DISCORD_NOTIFY)) {
    const config = discordConfig(env)
    if (!config) throw new Error(`discord notify: set ${DISCORD_ENV.slice(0, 2).join(', ')}`)
    channels.discord = discordChannel({ fetch, sleep, config })
  }
  return channels
}

/**
 * One pass over one source. Each envelope is planned, then (unless dry)
 * filed, and only then does the cursor move past it; a failure stops the
 * pass with the cursor on the last envelope that landed.
 *
 * @param {Source} source
 * @param {{
 *   intake: ReturnType<typeof import('./intake.mjs').createIntake>,
 *   state: State,
 *   now: number,
 *   backfillMs: number,
 *   dryRun?: boolean,
 *   print?: (record: any) => void,
 * }} ctx
 */
export async function pass(source, { intake, state, now, backfillMs, dryRun = false, print = () => {} }) {
  const items = await source.pull(state.get(source.name), { now, since: now - backfillMs })
  const tally = { source: source.name, created: 0, commented: 0, skipped: 0 }
  for (const item of items) {
    if (!item.envelope) tally.skipped++
    else {
      const action = await intake.plan(item.envelope)
      if (dryRun) {
        print({ envelope: item.envelope, ...action })
        if (action.action === 'create') await intake.assume(action.fingerprint)
      } else {
        const done = await intake.apply(action)
        print({
          source: source.name,
          externalId: item.envelope.externalId,
          fingerprint: action.fingerprint,
          action: action.action,
          ...done,
        })
      }
      tally[action.action === 'create' ? 'created' : 'commented']++
    }
    if (!dryRun) state.set(source.name, item.cursor)
  }
  return tally
}

/**
 * Every source on its own interval until `signal` aborts. A failed pass is
 * reported and retried at the next interval; it never stops the others.
 *
 * @param {Source[]} sources
 * @param {Omit<Parameters<typeof pass>[1], 'now'> & {
 *   now?: () => number,
 *   sleep: (ms: number) => Promise<void>,
 *   signal?: AbortSignal,
 *   report?: (line: string) => void,
 *   jobs?: { name: string, intervalMs: number, run: (now: number) => Promise<string> }[],
 * }} ctx
 */
export async function runLoop(sources, { now = Date.now, sleep, signal, report = () => {}, jobs = [], ...ctx }) {
  const due = new Map([...sources, ...jobs].map((s) => [s.name, 0]))
  while (!signal?.aborted) {
    for (const s of sources) {
      if (signal?.aborted) break
      const t = now()
      if (t < /** @type {number} */ (due.get(s.name))) continue
      ctx.intake.reset()
      try {
        const tally = await pass(s, { ...ctx, now: t })
        report(`${s.name}: ${tally.created} created, ${tally.commented} commented, ${tally.skipped} skipped`)
      } catch (err) {
        report(`${s.name}: ${/** @type {Error} */ (err).message}`)
      }
      due.set(s.name, t + s.intervalMs)
    }
    // After the sources, so an intent filed this round is answered this round.
    for (const j of jobs) {
      if (signal?.aborted) break
      const t = now()
      if (t < /** @type {number} */ (due.get(j.name))) continue
      try {
        report(await j.run(t))
      } catch (err) {
        report(`${j.name}: ${/** @type {Error} */ (err).message}`)
      }
      due.set(j.name, t + j.intervalMs)
    }
    if (signal?.aborted) break
    await sleep(Math.max(0, Math.min(...due.values()) - now()))
  }
}
