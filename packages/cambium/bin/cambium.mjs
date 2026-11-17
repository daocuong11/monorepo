#!/usr/bin/env node
// @ts-check
import { main } from '../src/cli.mjs'

const controller = new AbortController()
for (const sig of /** @type {const} */ (['SIGTERM', 'SIGINT'])) process.once(sig, () => controller.abort())

try {
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    env: process.env,
    signal: controller.signal,
  })
} catch (err) {
  console.error(`cambium: ${/** @type {Error} */ (err)?.message ?? err}`)
  process.exitCode = 1
}
