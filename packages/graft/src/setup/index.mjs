// @ts-check
/**
 * `graft setup` — from nothing to an agent that can work this repository.
 *
 *   graft setup            the App, if none acts for this repo's owner yet, then the project
 *   graft setup app        create (or --manual: register) the GitHub App and install it
 *   graft setup project    bootstrap this repository: .graft.json, CODEOWNERS, .claude/settings.json
 *
 * Run it yourself, in a terminal: it opens a browser and asks for two clicks
 * on GitHub that only a human with the right to create Apps can make. An agent
 * asked to set up graft should hand the human this command, not try to run it.
 */

import { appFor, loadUserConfig } from '../config.mjs'
import { contextOptions } from '../cli/common.mjs'
import { flag, has, resolveContext } from '../context.mjs'
import { setupApp } from './app.mjs'
import { setupProject } from './project.mjs'

const USAGE = `usage: graft setup [app | project] [--yes] …

  graft setup            App first if this repo's owner has none, then the project
  graft setup app        create the GitHub App via GitHub's manifest flow and install it
                        (--manual to register an App you already have)
  graft setup project    write .graft.json, CODEOWNERS and .claude/settings.json here

Each prints its own flags with --help.`

/** @param {string[]} argv */
export async function run(argv) {
  const [sub, ...rest] = argv
  if (sub === 'app') return setupApp(rest)
  if (sub === 'project') return setupProject(rest)
  if (sub === '--help' || sub === 'help') return console.log(USAGE)

  // Bare `graft setup`: only create an App when nothing acts for this owner.
  const all = sub ? argv : []
  let owner = flag(all, '--org') ?? flag(all, '--owner')
  let project = null
  try {
    const ctx = resolveContext(contextOptions(all))
    project = ctx.config
    owner = owner ?? (ctx.root ? ctx.repo().owner : null)
  } catch {
    // Not in a repo, or no origin: setup app will ask for the owner.
  }
  const app = appFor({ owner: owner ?? undefined, project, user: loadUserConfig() })
  if (!app || has(all, '--new-app')) {
    const ownerFlags = owner && !flag(all, '--org') && !flag(all, '--owner') ? ['--owner', owner] : []
    await setupApp([...all, ...ownerFlags])
  } else
    console.log(`✓ App ${app} acts for ${owner ?? 'this machine'} (graft setup app --manual or --new-app to change)`)
  return setupProject(all)
}
