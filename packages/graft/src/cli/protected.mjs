// @ts-check
/**
 * `graft protected` — what the protection policy says, so nobody has to guess.
 *
 *   graft protected a.mjs b/c.ts   the tier of each path, and why
 *   graft protected --changed      the same, for every uncommitted path
 *   graft protected --ref origin/main …   as of a ref, the way publish reads it
 *
 * Exits 1 when any named path is protected or impossible, so a script can ask.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flag, has, positionals } from '../context.mjs'
import { keyDiffers } from '../protected.mjs'
import { dirtyPaths } from '../publish/publish.mjs'
import { COMMON_VALUE_FLAGS, contextFrom } from './common.mjs'

export async function run(argv) {
  if (has(argv, '--help')) {
    console.log('usage: graft protected [paths…] [--changed] [--ref <ref>] [-C <dir>]')
    return 0
  }
  const ctx = contextFrom(argv)
  const ref = flag(argv, '--ref')
  const policy = ref ? ctx.policyAt(ref) : ctx.localPolicy()
  const paths = [
    ...positionals(argv, [...COMMON_VALUE_FLAGS, '--ref']),
    ...(has(argv, '--changed') ? dirtyPaths(ctx.git) : []),
  ]

  console.log(`CODEOWNERS: ${policy.codeownersPath ?? '(none — only protected.extra and self-protected files apply)'}`)
  if (policy.configProblem) console.log(`  ! ${policy.configProblem} — judged by the defaults`)
  for (const u of policy.unsupported) console.log(`  ! ${u}`)
  if (!paths.length) return 0

  // A key-protected file (KEYED) is judged by its key: the ref (or HEAD)
  // against the working tree.
  const at = (/** @type {string} */ path) => {
    try {
      return ctx.git(['show', `${ref ?? 'HEAD'}:${path}`])
    } catch {
      return null
    }
  }
  const onDisk = (/** @type {string} */ path) => {
    const f = join(ctx.requireRoot(), path)
    return existsSync(f) ? readFileSync(f, 'utf8') : null
  }
  let hit = false
  for (const p of paths) {
    const r = policy.check(p)
    if (r?.key && !keyDiffers(at(r.path), onDisk(r.path), r.key)) {
      console.log(`${'ordinary'.padEnd(10)} ${r.path} — only its "${r.key}" key is protected, and it is unchanged`)
      continue
    }
    if (r) hit = true
    console.log(r ? `${r.tier.padEnd(10)} ${r.path} — ${r.why}` : `${'ordinary'.padEnd(10)} ${p}`)
  }
  return hit ? 1 : 0
}
