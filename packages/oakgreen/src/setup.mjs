// @ts-check
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  QUEUE_LABELS,
  cambiumConfigPath,
  cambiumSkeleton,
  configuredRepos,
  gitRoot,
  myceliumSources,
  readCambiumConfig,
  slugFromRemote,
} from './stack.mjs'

/**
 * @typedef {{
 *   env: import('./stack.mjs').Env,
 *   home: string,
 *   cwd: string,
 *   config?: string,
 *   repo?: string,
 *   dryRun: boolean,
 *   exec: import('./tools.mjs').Exec,
 *   github: import('./github.mjs').GithubClient,
 *   print: (line: string) => void,
 * }} Context
 */

/** @param {Context} ctx @returns {Promise<string | null>} */
async function originSlug(ctx) {
  const r = await ctx.exec('git', ['remote', 'get-url', 'origin'], { cwd: ctx.cwd })
  return r.code === 0 ? slugFromRemote(r.stdout) : null
}

/**
 * Idempotent: creates only what is missing and never rewrites an existing file.
 *
 * @param {Context} ctx
 * @returns {Promise<{ ok: boolean, created: string[], steps: string[] }>}
 */
export async function runSetup(ctx) {
  const { print, dryRun } = ctx
  const created = []
  const steps = []
  let ok = true

  const file = cambiumConfigPath(ctx)
  const existing = readCambiumConfig(file)
  let config = existing.config
  if (existing.present) {
    print(`= cambium config ${file} exists${existing.error ? ` but is not JSON (${existing.error})` : ''}; left as is`)
    if (existing.error) ok = false
  } else {
    const slug = ctx.repo ?? ctx.env.MYCELIUM_REPO ?? (await originSlug(ctx))
    config = cambiumSkeleton(slug ?? 'OWNER/NAME', gitRoot(ctx.cwd) ?? ctx.cwd)
    if (!slug) steps.push(`Set repos[0].slug in ${file}`)
    if (dryRun) print(`+ would write cambium config ${file}`)
    else {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' })
      print(`+ wrote cambium config ${file}`)
      created.push(file)
    }
  }

  const repos = configuredRepos({ repo: ctx.repo, config, env: ctx.env }).filter((r) => r !== 'OWNER/NAME')
  if (!repos.length) steps.push('Re-run `oakgreen setup --repo owner/name` to create the queue labels')
  for (const repo of repos) {
    try {
      const have = new Set(await ctx.github.listLabels(repo))
      for (const label of QUEUE_LABELS) {
        if (have.has(label.name)) continue
        if (dryRun) print(`+ would create label ${label.name} on ${repo}`)
        else {
          await ctx.github.createLabel(repo, label)
          print(`+ created label ${label.name} on ${repo}`)
          created.push(`${repo}#${label.name}`)
        }
      }
      if (QUEUE_LABELS.every((l) => have.has(l.name))) print(`= queue labels on ${repo} all present`)
    } catch (err) {
      ok = false
      print(`! labels on ${repo}: ${/** @type {Error} */ (err).message}`)
    }
  }

  steps.push(
    'Create the GitHub Apps (cambium and workers) and install them on the repo: graft setup app',
    `Set graft.app, graft.botLogin and worker.graftApp in ${file}`,
    'Install the launchd agent: cambium install, then run the launchctl bootstrap command it prints',
  )
  if (!myceliumSources(ctx.env).length)
    steps.push('Optional: set MYCELIUM_* env vars for intake sources (see the mycelium README)')
  print('\nRemaining human steps:')
  for (const [i, s] of steps.entries()) print(`  ${i + 1}. ${s}`)
  print('Then run: oakgreen doctor')
  return { ok, created, steps }
}
