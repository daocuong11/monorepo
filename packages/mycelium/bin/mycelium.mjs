#!/usr/bin/env node
// @ts-check
import { main } from '../src/cli.mjs'

const stop = new AbortController()
for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.once(sig, () => stop.abort())

try {
  process.exitCode = await main(process.argv.slice(2), { signal: stop.signal })
} catch (err) {
  process.stderr.write(`mycelium: ${/** @type {Error} */ (err).message}\n`)
  process.exitCode = 1
}
