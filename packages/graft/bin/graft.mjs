#!/usr/bin/env node
// @ts-check
/**
 * graft — an agent's way to work a GitHub project, as a GitHub App.
 *
 * The local git binary stays READ-ONLY toward GitHub: it fetches (over HTTPS,
 * authenticated as the App through `graft credential`), diffs, merges and runs
 * hooks. Every write — commit, merge, branch, PR, comment — goes through the
 * verbs here, which have GitHub CREATE the commit through the API, so it lands
 * Verified as the App instead of unsigned and authored as whichever human
 * `user.name` resolved to.
 *
 * Around that write path sit the gates: scope and payload (what a publish may
 * carry), protection (CODEOWNERS as the manifest of what needs a human),
 * displacement (a stale worktree silently reverting work), validated base (a
 * green run about a different base), and the repository's own git hooks, run
 * at the moments git would have run them. A human lifts a gate with a scoped,
 * session-bound, expiring maintainer grant — never by taking graft out of the
 * loop.
 *
 * `graft help` for the verbs.
 */

import { PublishError } from '../src/errors.mjs'
import { VERSION } from '../src/gates/version.mjs'
import { explain } from '../src/cli/explain.mjs'
import { VERBS } from '../src/cli/verbs.mjs'

const HELP = `graft ${VERSION} — work a GitHub project as a GitHub App

Write path (every write is a Verified commit created by GitHub):
  graft publish <branch> <message> (--paths a,b | --all) [--pr <title>] [...]
  graft merge <branch>                 publish a local merge (git merge --no-commit → resolve → git add)
  graft advance <branch>               move HEAD onto the branch head, keeping work
  graft pr merge <n> [--auto]          merge a PR, if policy allows
  graft pr update <n>                  bring a PR up to date with its base
  graft issue <action> ...             create, comment, close, edit, assign, label (--body-file)

Read path:
  graft api <METHOD> <path> [--body <json>|--body-file <f>] [--paginate] [--raw] [--out <f>]
  graft graphql '<query>' [--vars <json>|--vars-file <f>]
  graft jobs <run-id | run URL> [--logs <dir>] [--all]
  graft ci wait <sha|ref> [--check c]  one check's verdict: exit 0 green, 1 red, 2 unknowable
  graft issue read <n>                 an issue as JSON (with the etag \`issue edit\` needs)
  graft status [<branch>]              what this worktree holds that GitHub does not (run before removing it)
  graft credential get                 git credential helper (git runs this)

Gates and grants:
  graft validate [-- <command>]        run the project's validation, record the base it was green on
  graft protected [paths...] [--changed]   what CODEOWNERS protects, and why
  graft maintainer status|grant|revoke     scoped, session-bound human override

Setup:
  graft setup [app|project]            create the GitHub App, bootstrap a repository
  graft doctor                         check this machine and repository
  graft hook <name>                    Claude Code hook entry points (settings.json runs these)

Common flags: -C <dir> (run as if in <dir>), --repo <owner/repo>.
Run \`graft <verb> --help\` for a verb's flags. Docs: skills/graft/SKILL.md.`

// graft was agit: an AGIT_* variable still counts when its GRAFT_* is unset.
for (const [k, v] of Object.entries(process.env))
  if (k.startsWith('AGIT_') && process.env[`GRAFT_${k.slice(5)}`] === undefined) process.env[`GRAFT_${k.slice(5)}`] = v

const [verb, ...argv] = process.argv.slice(2)

if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
  console.log(HELP)
  process.exit(0)
}
if (verb === 'version' || verb === '--version' || verb === '-v') {
  console.log(VERSION)
  process.exit(0)
}
if (!(verb in VERBS)) {
  console.error(`graft: unknown verb "${verb}"\n\n${HELP}`)
  process.exit(1)
}

try {
  const run = await VERBS[/** @type {keyof typeof VERBS} */ (verb)]()
  const code = await run(argv)
  if (typeof code === 'number') process.exitCode = code
} catch (err) {
  if (err instanceof PublishError) {
    console.error(err.message)
    process.exit(1)
  }
  console.error(`graft ${verb}: ${/** @type {Error} */ (err)?.message ?? err}`)
  const hint = explain(err)
  if (hint) console.error(`\n${hint}`)
  process.exit(1)
}
