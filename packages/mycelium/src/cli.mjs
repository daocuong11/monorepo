// @ts-check
import { parseArgs } from 'node:util'
import { graftClient } from './github.mjs'
import { createIntake } from './intake.mjs'
import { BACKFILL_HOURS, SOURCES, pass, runLoop, sourceFromEnv } from './runner.mjs'
import { defaultStatePath, fileState, memoryState } from './state.mjs'

export const HELP = `mycelium — intake connectors: external events become q:intake intent issues

  mycelium poll <source> [--dry-run]   one pass over one source (${SOURCES.join(', ')})
  mycelium run [--dry-run]             every configured source, each on its own interval

Flags:
  --dry-run          print envelopes and the issue actions; no writes, no cursor moves
  --repo <o/r>       target repository (else $MYCELIUM_REPO)
  --state <file>     cursor file (else $MYCELIUM_STATE, else $XDG_STATE_HOME/mycelium/state.json)

Credentials and settings come from the environment; see the README.`

/** @type {import('./intake.mjs').GithubClient} */
const offline = {
  openIntents: async () => [],
  createIssue: async () => {
    throw new Error('dry run: no writes')
  },
  comment: async () => {
    throw new Error('dry run: no writes')
  },
}

/**
 * @param {string[]} argv
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetch?: import('./http.mjs').Fetch,
 *   github?: import('./intake.mjs').GithubClient,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   signal?: AbortSignal,
 *   out?: (line: string) => void,
 *   err?: (line: string) => void,
 * }} [deps]
 */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    fetch = /** @type {any} */ (globalThis.fetch),
    signal,
    sleep = (ms) =>
      new Promise((r) => {
        const t = setTimeout(r, ms)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            r(undefined)
          },
          { once: true },
        )
      }),
    now = Date.now,
    out = (l) => process.stdout.write(`${l}\n`),
    err = (l) => process.stderr.write(`${l}\n`),
  } = deps
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      repo: { type: 'string' },
      state: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [verb, name] = positionals
  if (values.help || !verb || verb === 'help') {
    out(HELP)
    return verb || values.help ? 0 : 1
  }
  const dryRun = values['dry-run']
  const repo = values.repo ?? env.MYCELIUM_REPO
  if (!repo && !deps.github && !dryRun) throw new Error('no repository: pass --repo <owner/name> or set MYCELIUM_REPO')
  const github = deps.github ?? (repo ? graftClient({ repo }) : offline)
  const state = dryRun ? memoryState() : fileState(values.state ?? defaultStatePath(env))
  const hours = Number(env.MYCELIUM_BACKFILL_HOURS ?? BACKFILL_HOURS)
  const ctx = {
    intake: createIntake(github),
    state,
    backfillMs: (Number.isFinite(hours) && hours >= 0 ? hours : BACKFILL_HOURS) * 3_600_000,
    dryRun,
    print: (/** @type {any} */ r) => out(JSON.stringify(r)),
  }

  if (verb === 'poll') {
    if (!name) throw new Error(`usage: mycelium poll <source>  (${SOURCES.join(', ')})`)
    const tally = await pass(sourceFromEnv(name, { env, fetch, sleep }), { ...ctx, now: now() })
    err(`${tally.source}: ${tally.created} created, ${tally.commented} commented, ${tally.skipped} skipped`)
    return 0
  }
  if (verb === 'run') {
    /** @type {import('./runner.mjs').Source[]} */
    const sources = []
    for (const n of SOURCES) {
      try {
        sources.push(sourceFromEnv(n, { env, fetch, sleep }))
      } catch (e) {
        err(`${/** @type {Error} */ (e).message} (skipped)`)
      }
    }
    if (sources.length === 0) throw new Error('no source is configured')
    await runLoop(sources, { ...ctx, now, sleep, signal, report: err })
    return 0
  }
  throw new Error(`unknown verb '${verb}'\n\n${HELP}`)
}
