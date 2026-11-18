// @ts-check
import { parseArgs } from 'node:util'
import { resolveSettings } from './config.mjs'
import { cachedQueues, graftClient, MIN_TTL_MS } from './github.mjs'
import { createApp, DEFAULT_HOST, DEFAULT_PORT } from './server.mjs'
import { traceStore } from './traces.mjs'

export const HELP = `canopy — a local read-only page over cambium's heartbeat and the GitHub queues

usage: canopy [--port <n>] [--host <addr>] [--state <file>] [--traces <file>] [--config <file>] [--repo <owner/name>]... [--cache <seconds>]

  --port <n>         listen port (default ${DEFAULT_PORT})
  --host <addr>      listen address (default ${DEFAULT_HOST}; loopback only unless you say otherwise)
  --state <file>     cambium heartbeat (default: paths.heartbeat from the cambium config, else ~/.cambium/state.json)
  --traces <file>    OTLP/JSON spans from cambium's collector (default: <paths.home>/otel/traces.jsonl)
  --config <file>    cambium config (default: $CAMBIUM_CONFIG, else ~/.cambium/config.json)
  --repo <o/n>       repository to show queues for; repeatable (default: the config's repos, else the heartbeat's)
  --cache <seconds>  how long a GitHub answer is reused (default and minimum ${MIN_TTL_MS / 1000})
  --graft <cmd>      graft binary (default: graft on PATH)

Reads only. Open http://<host>:<port>/ ; the page polls /api/state (and /api/traces on the Traces tab).
`

/**
 * Parse flags and build the server; the caller listens. Returns a number
 * (exit code) when there is nothing to serve.
 *
 * @param {string[]} argv
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   client?: import('./github.mjs').GithubClient,
 *   out?: (s: string) => void,
 *   err?: (s: string) => void,
 * }} [deps]
 * @returns {number | { server: import('node:http').Server, host: string, port: number }}
 */
export function main(
  argv,
  { env = process.env, client, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {},
) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        state: { type: 'string' },
        traces: { type: 'string' },
        config: { type: 'string' },
        repo: { type: 'string', multiple: true },
        cache: { type: 'string' },
        graft: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }))
  } catch (e) {
    err(`canopy: ${/** @type {Error} */ (e).message}\n\n${HELP}`)
    return 2
  }
  if (values.help) {
    out(HELP)
    return 0
  }
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    err(`canopy: --port must be 0-65535, got ${values.port}\n`)
    return 2
  }
  const cacheS = values.cache === undefined ? MIN_TTL_MS / 1000 : Number(values.cache)
  if (!Number.isFinite(cacheS)) {
    err(`canopy: --cache must be a number of seconds, got ${values.cache}\n`)
    return 2
  }
  let settings
  try {
    settings = resolveSettings(
      { state: values.state, traces: values.traces, config: values.config, repos: values.repo },
      { env },
    )
  } catch (e) {
    err(`canopy: ${/** @type {Error} */ (e).message}\n`)
    return 2
  }
  const host = values.host ?? DEFAULT_HOST
  const queues = cachedQueues({
    client: client ?? graftClient({ bin: values.graft ?? 'graft' }),
    ttlMs: cacheS * 1000,
  })
  const notes = settings.configError ? [settings.configError] : []
  const server = createApp({
    statePath: settings.statePath,
    repos: settings.repos,
    queues,
    host,
    notes,
    traces: traceStore({ path: settings.tracesPath }),
  })
  return { server, host, port }
}
