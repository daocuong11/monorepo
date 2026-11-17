// @ts-check
/**
 * The optional half of `graft setup project`: asked, then done — never a
 * checklist left for the reader.
 *
 *   App branches   a second ruleset: the App may create branches under one
 *                  prefix only (agent/** by default). Repository admins,
 *                  maintainers and writers bypass it, so people are not held
 *                  to it; the App is never a bypass actor.
 *   auto-merge     the repository setting `graft pr merge --auto` needs.
 *
 * Both are written as the human through `gh` (rulesets.mjs `ghAdmin`), for
 * the same reason as the base ruleset: the App holds no Administration
 * permission. When `gh` cannot do it, the step says where to do it by hand.
 */

/** The ruleset graft owns for the App's branches. */
export const APP_BRANCHES_RULESET = 'graft: app branches'

/** People bypass the creation rule; the App is never listed. 5 admin, 2 maintain, 4 write. */
export const PEOPLE_BYPASS = Object.freeze(
  [5, 2, 4].map((actor_id) => ({ actor_id, actor_type: 'RepositoryRole', bypass_mode: 'always' })),
)

/** Files that mean a bot creates branches here, and would be blocked too. */
export const BRANCH_BOT_FILES = [
  '.github/dependabot.yml',
  '.github/dependabot.yaml',
  'renovate.json',
  'renovate.json5',
  '.github/renovate.json',
  '.github/renovate.json5',
  '.renovaterc',
  '.renovaterc.json',
]

/**
 * `agent/**`, `agent/`, `agent` → `agent/**`; empty or `none` → null.
 *
 * @param {string | null | undefined} answer
 */
export function branchPattern(answer) {
  const a = String(answer ?? '').trim()
  if (!a || a === 'none') return null
  if (/[\s~^:?[\\]/.test(a) || a.startsWith('/') || a.startsWith('refs/'))
    throw new Error(`--app-branches takes a branch prefix like agent/**, not "${a}"`)
  return a.endsWith('/**') ? a : `${a.replace(/\/+$/, '')}/**`
}

/**
 * The ruleset that lets the App create only `pattern` branches.
 *
 * @param {string} pattern  e.g. agent/**
 */
export function appBranchesBody(pattern) {
  return {
    name: APP_BRANCHES_RULESET,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~ALL'], exclude: [`refs/heads/${pattern}`] } },
    bypass_actors: PEOPLE_BYPASS.map((a) => ({ ...a })),
    rules: [{ type: 'creation' }],
  }
}

/**
 * @typedef {{
 *   owner: string, repo: string,
 *   admin: { who: string, api: (method: string, path: string, body?: any) => Promise<any> },
 *   prompt: import('./prompt.mjs').Prompter,
 *   say: (line?: string) => void,
 *   c: import('./style.mjs').Palette,
 * }} Step
 */

/**
 * Ask whether to limit the App's branches, and create the ruleset if so.
 *
 * @param {Step & { answer?: string | null, bots?: string[] }} input
 *   `answer`: --app-branches, if given. `bots`: BRANCH_BOT_FILES present here.
 * @returns {Promise<'ok' | 'created' | 'skipped' | 'manual'>}
 */
export async function ensureAppBranches({ owner, repo, admin, prompt, say, c, answer = null, bots = [] }) {
  const rulesets = `/repos/${owner}/${repo}/rulesets`
  const manual = `https://github.com/${owner}/${repo}/settings/rules`
  let existing = null
  try {
    existing = ((await admin.api('GET', rulesets)) ?? []).find((r) => r.name === APP_BRANCHES_RULESET)
  } catch (err) {
    say(c.warn(`could not read the rulesets as ${admin.who}: ${/** @type {Error} */ (err).message}`))
    say(c.skip(`limit the App's branches by hand, if you want to: ${manual}`))
    return 'manual'
  }
  if (existing) {
    say(c.ok(`the App may only create the branches "${APP_BRANCHES_RULESET}" allows`))
    return 'ok'
  }

  if (answer === null) {
    say(`The App can create any branch. A ruleset can hold it to one prefix; people are not held to it.`)
    if (bots.length)
      say(
        c.warn(
          `${bots.join(', ')} ${bots.length > 1 ? 'mean bots create' : 'means a bot creates'} branches here; ` +
            'the ruleset would block them too until you add them to its bypass list.',
        ),
      )
  }
  let pattern
  try {
    pattern =
      answer !== null
        ? branchPattern(answer)
        : (await prompt.confirm('Limit the App to creating agent/** branches?', {
              default: bots.length === 0,
              flag: '--app-branches',
            }))
          ? 'agent/**'
          : null
  } catch (err) {
    say(c.warn(/** @type {Error} */ (err).message))
    return 'skipped'
  }
  if (!pattern) {
    say(c.skip('the App may create any branch'))
    return 'skipped'
  }
  try {
    await admin.api('POST', rulesets, appBranchesBody(pattern))
  } catch (err) {
    say(c.warn(`could not create the ruleset as ${admin.who}: ${/** @type {Error} */ (err).message}`))
    say(c.skip(`create it by hand: ${manual}`))
    return 'manual'
  }
  say(c.done(`created ruleset "${APP_BRANCHES_RULESET}": the App may only create ${c.code(pattern)} branches`))
  return 'created'
}

/**
 * Ask whether to allow auto-merge, and turn it on if so.
 *
 * @param {Step & { enabled: boolean | undefined, agentsMerge: boolean, answer?: boolean | null }} input
 *   `enabled`: the repository's allow_auto_merge, as the App sees it.
 *   `agentsMerge`: some base is mergeable by agents — the reason to want it.
 *   `answer`: --auto-merge / --no-auto-merge, if given.
 * @returns {Promise<'ok' | 'enabled' | 'skipped' | 'manual'>}
 */
export async function ensureAutoMerge({ owner, repo, admin, prompt, say, c, enabled, agentsMerge, answer = null }) {
  if (enabled) {
    say(c.ok('auto-merge is allowed (graft pr merge --auto)'))
    return 'ok'
  }
  const want =
    answer ??
    (await prompt.confirm('Allow auto-merge, so agents can use `graft pr merge --auto`?', {
      default: agentsMerge,
      flag: '--auto-merge',
    }))
  if (!want) {
    say(c.skip('auto-merge stays off'))
    return 'skipped'
  }
  try {
    await admin.api('PATCH', `/repos/${owner}/${repo}`, { allow_auto_merge: true })
  } catch (err) {
    say(c.warn(`could not allow auto-merge as ${admin.who}: ${/** @type {Error} */ (err).message}`))
    say(c.skip(`turn it on by hand: https://github.com/${owner}/${repo}/settings → General → Allow auto-merge`))
    return 'manual'
  }
  say(c.done('allowed auto-merge'))
  return 'enabled'
}
