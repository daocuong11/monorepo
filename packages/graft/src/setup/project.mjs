// @ts-check
/**
 * `graft setup project` — bootstrap one repository for agent work.
 *
 * Brings two things to the state agent work needs, detecting each first and
 * changing only what is missing. Three files, each shown before it is written:
 *
 *   .graft.json              the project's policy (config.mjs), or the `graft`
 *   (or package.json)       key of the root package.json — the user picks: the base PRs
 *                           land on, what validates a tree, where the tracked
 *                           git hooks live, which bases agents may merge into.
 *   CODEOWNERS              the manifest of protected paths (protected.mjs).
 *                           At minimum it must own the files that define the
 *                           protection — itself, `.graft.json`, the Claude
 *                           settings, the hooks — or an agent could loosen its
 *                           own policy and merge that on green.
 *   .claude/settings.json   the credential helper, the Claude Code hooks and
 *                           the permissions (settings.mjs).
 *
 * And the base branch's ruleset on GitHub (rulesets.mjs) — what turns
 * CODEOWNERS from documentation into a boundary. The App detects it; the
 * human's `gh` writes it, because the App holds no Administration permission,
 * on purpose.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CODEOWNERS_LOCATIONS, findCodeowners, ownersOf, parseCodeowners } from '../codeowners.mjs'
import { PACKAGE_FILE, PACKAGE_KEY, PROJECT_FILE, locateProjectConfig } from '../config.mjs'
import { contextOptions } from '../cli/common.mjs'
import { flag, has, resolveContext } from '../context.mjs'
import { NoAppError, isNotFound, readAppCredentials } from '../github/app.mjs'
import { installUrl } from './manifest.mjs'
import { createPrompter } from './prompt.mjs'
import { ensureBaseRuleset, ghAdmin } from './rulesets.mjs'
import { claudeHooks, envToPairs, gitConfigEnv, mergeSettings } from './settings.mjs'

const say = (line = '') => console.log(line)

/** Tracked hook directories, in the order they are looked for. */
export const HOOK_DIRS = ['.githooks', '.husky', '.hooks']

/** A validate command from package.json scripts and the lockfile present. */
export function suggestValidate(root) {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return null
  let scripts = {}
  try {
    scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {}
  } catch {
    return null
  }
  const script = ['ci', 'test'].find((s) => scripts[s])
  if (!script) return null
  const pm = existsSync(join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(root, 'yarn.lock'))
      ? 'yarn'
      : existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))
        ? 'bun'
        : 'npm'
  return `${pm} run ${script}`
}

/** The first tracked hooks directory that exists, or null. */
export function detectHooksDir(root) {
  return HOOK_DIRS.find((d) => existsSync(join(root, d))) ?? null
}

/**
 * The CODEOWNERS lines the protection needs and the file does not have.
 *
 * @param {{ text: string, codeownersPath: string, hooksDir: string | null, owner: string }} input
 * @returns {string[]}
 */
export function missingCodeownersLines({ text, codeownersPath, hooksDir, owner }) {
  const rules = parseCodeowners(text)
  const wanted = [
    [`/${codeownersPath}`, codeownersPath],
    [`/${PROJECT_FILE}`, PROJECT_FILE],
    ['/.claude/settings.json', '.claude/settings.json'],
    ...(hooksDir ? [[`/${hooksDir}/`, `${hooksDir}/pre-commit`]] : []),
  ]
  return wanted.filter(([, sample]) => !ownersOf(rules, sample).length).map(([pattern]) => `${pattern}  ${owner}`)
}

/** A new CODEOWNERS, owning only the protection itself. */
export function newCodeowners(lines) {
  return [
    '# Paths a human must approve. graft reads this file as the manifest of',
    '# protected paths: agents cannot edit or publish them without a',
    '# maintainer grant, and with "Require review from Code Owners" on the',
    "# base branch's ruleset, GitHub will not merge them without the owner.",
    '#',
    '# Keep it short. List what changes what the gates catch, what an agent may',
    '# do, or what reaches production — not everything that is important.',
    '',
    '# The protection itself.',
    ...lines,
    '',
  ].join('\n')
}

/** Lines added/removed between two texts — enough to confirm a write by. */
export function lineDiff(before, after) {
  const a = (before ?? '').split('\n')
  const b = after.split('\n')
  const inA = new Set(a)
  const inB = new Set(b)
  return [
    ...a.filter((l) => l.trim() && !inB.has(l)).map((l) => `- ${l}`),
    ...b.filter((l) => l.trim() && !inA.has(l)).map((l) => `+ ${l}`),
  ]
}

/** What is left on GitHub after setup: optional, and the human's call. */
export function githubChecklist({ owner, repo, requiredCheck, slug }) {
  const rules = `https://github.com/${owner}/${repo}/settings/rules`
  return [
    'Optional, on GitHub:',
    ...(requiredCheck
      ? []
      : ['  Once CI exists: graft setup project --required-check <job> adds it to the base ruleset.']),
    `  A second ruleset limiting what the App may create, e.g. branches \`agent/**\` only: ${rules}`,
    `  Settings → General → Allow auto-merge, if agents will use \`graft pr merge --auto\`.`,
    ...(slug ? ['', `  App installation (repositories it may touch): ${installUrl(slug)}`] : []),
    '',
    'Then check everything with: graft doctor',
  ].join('\n')
}

/**
 * Said last whenever `.claude/settings.json` changed: Claude Code reads its
 * env and hooks once, at session start, so a session already open has none of
 * what was just written — its raw git still authenticates as the human.
 */
export const RESTART_NOTICE = [
  '! Claude Code sessions already open in this repository are NOT protected by what was just written:',
  '  they loaded .claude/settings.json (the git env and the hooks) when they started. Restart them.',
].join('\n')

const USAGE = `usage: graft setup project [--config-in <.graft.json | package.json>] [--base <branch>]
                          [--validate "<command>"] [--required-check <name>]
                          [--mergeable <a,b | none>] [--codeowner <@handle>] [--hooks-path <dir>]
                          [--no-claude] [--yes]`

/** An answer to "where does the policy live", or `null` when it names neither place. */
export function configLocation(answer) {
  const a = String(answer ?? '')
    .trim()
    .toLowerCase()
  if (['.graft.json', 'graft.json', 'graft'].includes(a)) return PROJECT_FILE
  if (['package.json', 'package'].includes(a)) return PACKAGE_FILE
  return null
}

/** JSON in the original text's indentation and final newline. */
function stringifyLike(obj, original) {
  const m = /^([ \t]+)"/m.exec(original)
  return JSON.stringify(obj, null, m ? m[1] : 2) + (original.endsWith('\n') ? '\n' : '')
}

/**
 * The writes that put `policy` at `target` and take it out of the other place,
 * so exactly one holds it. `content: null` deletes the file. `package.json`
 * keeps its other keys, their order, and its indentation.
 *
 * @param {{ target: string, policy: object, graftText: string | null, pkgText: string | null }} input
 * @returns {{ path: string, content: string | null }[]}
 */
export function placePolicy({ target, policy, graftText, pkgText }) {
  if (target === PACKAGE_FILE) {
    if (pkgText === null)
      throw new Error(`no ${PACKAGE_FILE} at the repository root; keep the policy in ${PROJECT_FILE}`)
    const pkg = JSON.parse(pkgText)
    pkg[PACKAGE_KEY] = policy
    const out = [{ path: PACKAGE_FILE, content: stringifyLike(pkg, pkgText) }]
    if (graftText !== null) out.push({ path: PROJECT_FILE, content: null })
    return out
  }
  const out = [{ path: PROJECT_FILE, content: `${JSON.stringify(policy, null, 2)}\n` }]
  if (pkgText !== null) {
    const pkg = JSON.parse(pkgText)
    if (pkg && typeof pkg === 'object' && pkg[PACKAGE_KEY] !== undefined) {
      delete pkg[PACKAGE_KEY]
      out.push({ path: PACKAGE_FILE, content: stringifyLike(pkg, pkgText) })
    }
  }
  return out
}

/**
 * @param {string[]} argv
 * @param {{ prompt?: import('./prompt.mjs').Prompter, cwd?: string, env?: NodeJS.ProcessEnv, admin?: ReturnType<typeof ghAdmin> }} [deps]
 */
export async function setupProject(argv, deps = {}) {
  if (has(argv, '--help')) return say(USAGE)
  const prompt = deps.prompt ?? createPrompter({ yes: has(argv, '--yes') })
  try {
    const ctx = resolveContext(contextOptions(argv, deps))
    const root = ctx.requireRoot()
    const { owner, repo, full } = ctx.repo()
    say(`Setting up ${full} in ${root}`)

    // --- the App must reach this repo -----------------------------------
    let meta
    let client
    let slug = null
    try {
      slug = readAppCredentials({ owner, project: ctx.config, env: ctx.env }).slug
    } catch {
      slug = null
    }
    try {
      client = await ctx.client()
      meta = await client.api(`/repos/${owner}/${repo}`)
    } catch (err) {
      if (err instanceof NoAppError) throw new Error(`${err.message}\nCreate one first: graft setup app`)
      if (isNotFound(err)) {
        throw new Error(
          `the App is not installed on ${full} (GitHub answered 404).\n` +
            `Install it on this repository — ${slug ? installUrl(slug) : 'https://github.com/apps/<your-app>/installations/new'} — and run this again.`,
        )
      }
      throw err
    }
    say(`✓ the App can reach ${full} (default branch: ${meta.default_branch})`)

    // --- the policy: .graft.json, or package.json's "graft" key ------------
    const readRoot = (/** @type {string} */ p) =>
      existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null
    let located
    try {
      located = locateProjectConfig(readRoot)
    } catch (err) {
      throw new Error(`${/** @type {Error} */ (err).message}. Keep one, then run this again.`)
    }
    const current = located.text ? JSON.parse(located.text) : {}
    const pkgText = readRoot(PACKAGE_FILE)
    // Ask only when there is a choice: no root package.json leaves one place.
    const configAnswer =
      flag(argv, '--config-in') ??
      (pkgText === null
        ? PROJECT_FILE
        : await prompt.ask(
            `Where should graft keep this repo's policy: ${PROJECT_FILE}, or the "${PACKAGE_KEY}" key in ${PACKAGE_FILE}?`,
            { default: located.source ?? PROJECT_FILE, flag: '--config-in' },
          ))
    const target = configLocation(configAnswer)
    if (!target) throw new Error(`--config-in must be ${PROJECT_FILE} or ${PACKAGE_FILE}, not "${configAnswer}"`)
    const baseBranch =
      flag(argv, '--base') ??
      (await prompt.ask('Base branch agent PRs target', {
        default: current.baseBranch ?? meta.default_branch,
        flag: '--base',
      }))
    const validate =
      flag(argv, '--validate') ??
      (await prompt.ask('Command that validates a worktree (empty for none)', {
        default: current.validate?.command ?? suggestValidate(root) ?? '',
        flag: '--validate',
      }))
    const requiredCheck =
      flag(argv, '--required-check') ??
      (await prompt.ask('Required status check on the base, for stop-the-line (empty for none)', {
        default: current.requiredCheck ?? '',
        flag: '--required-check',
      }))
    const mergeableRaw =
      flag(argv, '--mergeable') ??
      (await prompt.ask("Bases agents may merge PRs into themselves (comma-separated, 'none' = never)", {
        default: (current.mergeableBases ?? [baseBranch]).join(',') || 'none',
        flag: '--mergeable',
      }))
    const mergeable =
      mergeableRaw.trim() === 'none'
        ? []
        : mergeableRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    const hooksDir = flag(argv, '--hooks-path') ?? current.hooks?.path ?? detectHooksDir(root)

    const project = { ...current }
    if (baseBranch !== meta.default_branch || current.baseBranch) project.baseBranch = baseBranch
    if (mergeable.length !== 1 || mergeable[0] !== baseBranch) project.mergeableBases = mergeable
    else delete project.mergeableBases
    if (requiredCheck) project.requiredCheck = requiredCheck
    else delete project.requiredCheck
    if (validate) project.validate = { ...(current.validate ?? {}), command: validate }
    if (hooksDir) project.hooks = { ...(current.hooks ?? {}), path: hooksDir }
    for (const w of placePolicy({ target, policy: project, graftText: readRoot(PROJECT_FILE), pkgText }))
      if (w.content === null) await removeWithConfirm(prompt, join(root, w.path), root)
      else await writeWithConfirm(prompt, join(root, w.path), w.content, root)
    if (target === PACKAGE_FILE)
      say(
        `  note: graft protects the "${PACKAGE_KEY}" key, not the whole ${PACKAGE_FILE}. GitHub cannot enforce a key;\n` +
          `  own /${PACKAGE_FILE} in CODEOWNERS too if every change to it should need review.`,
      )

    // --- CODEOWNERS ------------------------------------------------------
    const found = findCodeowners((p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null))
    const isOrg = meta.owner?.type === 'Organization'
    const coPath = found.path ?? CODEOWNERS_LOCATIONS[0]
    // Only ask who owns the protection when some of it is unowned: a re-run
    // over a complete CODEOWNERS needs no answer.
    const unowned = missingCodeownersLines({ text: found.text, codeownersPath: coPath, hooksDir, owner: '' }).length > 0
    const handle = !unowned
      ? ''
      : (flag(argv, '--codeowner') ??
        (await prompt.ask(
          isOrg ? 'Code owner for protected paths (@user or @org/team)' : 'Code owner for protected paths',
          { default: isOrg ? null : `@${owner}`, flag: '--codeowner' },
        )))
    const missing = unowned
      ? missingCodeownersLines({ text: found.text, codeownersPath: coPath, hooksDir, owner: handle })
      : []
    if (missing.length) {
      const next = found.path
        ? `${found.text.replace(/\n*$/, '\n')}\n# The protection itself (added by graft setup).\n${missing.join('\n')}\n`
        : newCodeowners(missing)
      await writeWithConfirm(prompt, join(root, coPath), next, root)
    } else say(`✓ ${coPath} already owns the protection itself`)

    // --- .claude/settings.json ------------------------------------------
    let settingsWritten = false
    if (!has(argv, '--no-claude')) {
      const settingsPath = join(root, '.claude', 'settings.json')
      const existing = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
      // Keep rewrites for other owners the file already names.
      const owners = new Set([owner])
      for (const [k, v] of envToPairs(existing.env)) {
        const m = /^git@github\.com:([^/]+)\/$/.exec(v)
        if (/^url\..*\.insteadOf$/.test(k) && m) owners.add(m[1])
      }
      const next = mergeSettings(existing, { env: gitConfigEnv({ owners: [...owners] }), hooks: claudeHooks() })
      settingsWritten = await writeWithConfirm(prompt, settingsPath, `${JSON.stringify(next, null, 2)}\n`, root)
    }

    // --- the base branch's ruleset, on GitHub ---------------------------
    let effective = null
    try {
      effective = await client.api(`/repos/${owner}/${repo}/rules/branches/${encodeURIComponent(baseBranch)}`)
    } catch (err) {
      say(`! could not read the rules on ${baseBranch}: ${String(/** @type {Error} */ (err).message).slice(0, 200)}`)
    }
    if (effective)
      await ensureBaseRuleset({
        owner,
        repo,
        base: baseBranch,
        requiredCheck: requiredCheck || null,
        effective,
        admin: deps.admin ?? ghAdmin(),
        prompt,
        say,
        env: ctx.env,
      })

    say('')
    say(githubChecklist({ owner, repo, requiredCheck: requiredCheck || null, slug }))
    if (settingsWritten) say(`\n${RESTART_NOTICE}`)
  } finally {
    prompt.close()
  }
}

/** Confirm, then delete — the policy moved out of this file. */
async function removeWithConfirm(prompt, path, root) {
  const rel = path.slice(root.length + 1)
  if (!existsSync(path)) return false
  say(`\nremove ${rel} (the policy now lives elsewhere; two would be refused)`)
  if (!(await prompt.confirm(`remove ${rel}?`, { default: true, flag: '--yes' }))) {
    say(`  kept ${rel} — graft will refuse to run until one of the two is gone`)
    return false
  }
  rmSync(path)
  say(`  removed ${rel}`)
  return true
}

/** Show what would change, confirm, write. Unchanged files are left alone. */
async function writeWithConfirm(prompt, path, content, root) {
  const rel = path.slice(root.length + 1)
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (before === content) {
    say(`✓ ${rel} is up to date`)
    return false
  }
  say(`\n${before === null ? 'create' : 'update'} ${rel}:`)
  for (const l of lineDiff(before, content).slice(0, 40)) say(`  ${l}`)
  if (!(await prompt.confirm(`write ${rel}?`, { default: true, flag: '--yes' }))) {
    say(`  skipped ${rel}`)
    return false
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  say(`  wrote ${rel}`)
  return true
}
