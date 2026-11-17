#!/usr/bin/env node
// @ts-check
import { main } from '../src/cli.mjs'

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (err) {
  process.stderr.write(`oakgreen: ${/** @type {Error} */ (err).message}\n`)
  process.exitCode = 1
}
