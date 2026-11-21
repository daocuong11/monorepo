// @ts-check
/**
 * SessionStart hook — is raw git in this session bound to the App?
 *
 *   graft hook session-check
 *
 * The `GIT_CONFIG_*` block in `.claude/settings.json` and the Bash hooks are
 * loaded once, when a session starts. A session that started before `graft
 * setup project`, or that inherited another project's block, has raw git that
 * reaches for the human's SSH key or someone else's credential helper — and
 * no error anywhere says so. This asks git, under the session's environment,
 * what a raw `git fetch` would authenticate as (session-env.mjs), and tells
 * the agent and the human when it is not the App. Silent when it is.
 *
 * It cannot help a session that loaded no settings at all — this hook is in
 * those settings. What it catches is the session that loaded them and still
 * is not bound: a foreign block, a remote on another owner's SSH, a helper
 * that answers before graft's.
 *
 * It also says when this graft is older than `.graft.json`'s `minVersion`.
 * Every verb refuses then (gates/version.mjs), but hooks do not go through
 * that gate: an old graft's hooks run quietly and do less, such as never
 * recording the commit `graft worktree done` rewinds to. Saying so at session
 * start beats finding out at the end of the work.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveContext } from '../context.mjs'
import { VERSION, versionRefusal } from '../gates/version.mjs'
import { readRawGit, sessionFindings } from '../session-env.mjs'

/**
 * @param {any} event
 * @param {{ env?: NodeJS.ProcessEnv, running?: string }} [opts]   `running`: the graft version (default: this one)
 * @returns {string | null}
 */
export function check(event, { env = process.env, running } = {}) {
  const ctx = resolveContext({ cwd: event?.cwd ?? process.cwd(), env })
  if (!ctx.root) return null
  const stale = staleGraft(ctx, running)
  const bound = binding(ctx, env)
  return [stale, bound].filter(Boolean).join('\n\n') || null
}

/**
 * The notice when this graft is older than the project's `minVersion`, else null.
 * @param {{ config: { minVersion?: string | null } }} ctx  @param {string} [running]
 */
export function staleGraft(ctx, running) {
  let min = null
  try {
    min = ctx.config.minVersion ?? null
  } catch {
    return null // unreadable policy: doctor names it
  }
  if (!versionRefusal(min, running)) return null
  return (
    `graft: this is graft ${running ?? VERSION}; this project's .graft.json requires >= ${min}.\n` +
    'Every graft verb will refuse, and its hooks are doing less than the project expects.\n' +
    'Update it (`oakgreen update`, or `npm install -g @oakgreencc/graft`), then start a new session.'
  )
}

/** @param {any} ctx  @param {NodeJS.ProcessEnv} env */
function binding(ctx, env) {
  const settingsPath = join(ctx.root, '.claude', 'settings.json')
  let settingsEnv = null
  try {
    if (existsSync(settingsPath)) settingsEnv = JSON.parse(readFileSync(settingsPath, 'utf8')).env ?? null
  } catch {
    // Unreadable settings: still say what raw git would do; doctor names the file.
  }
  const { url, helpers } = readRawGit({ cwd: ctx.root, env })
  if (!url) return null
  const problems = sessionFindings({ url, helpers, processEnv: env, settingsEnv }).filter((f) => f.level !== 'ok')
  if (!problems.length) return null
  return [
    'graft: raw git in this session is NOT bound to the GitHub App.',
    ...problems.map((f) => `- ${f.label}${f.detail ? `\n  ${f.detail}` : ''}`),
  ].join('\n')
}

/** A notice (see hooks/index.mjs): shown at session start, never blocks. */
export const event = 'SessionStart'

/** @param {any} input  @param {{ env: NodeJS.ProcessEnv }} opts */
export const decide = (input, { env }) => check(input, { env })
