#!/usr/bin/env node
// @ts-check
import { main } from '../src/cli.mjs'

process.exitCode = main({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
})
