#!/usr/bin/env node
// @ts-check
import { run } from '../src/cli.mjs'

process.exitCode = run(process.argv.slice(2))
