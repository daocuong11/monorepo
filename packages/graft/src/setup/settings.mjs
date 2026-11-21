// @ts-check
/**
 * What `graft setup project` writes into `.claude/settings.json` — pure.
 *
 * Three things, each for a reason:
 *
 *   env      a `GIT_CONFIG_*` block. It rewrites the owners' SSH remotes to
 *            HTTPS and names `graft credential` as the helper, so a plain
 *            `git fetch` authenticates as the App instead of reaching for a
 *            human's SSH key (a biometric prompt no headless session can
 *            answer). It turns local signing off, because an agent's local
 *            commits never leave the machine — GitHub signs what is published —
 *            and a local signature would reach for the human's key too.
 *            Environment rather than `git config` so it binds agent sessions
 *            only and never changes the human's own git.
 *   hooks    the Claude Code hooks: credentials, PR writes, protected paths,
 *            the worktree sync, and the session-start check that the env
 *            above actually reached the session (session-env.mjs). Tracked
 *            in the project, so every contributor's sessions get them.
 *   perms    `graft`, the read-only git and the worktree tools the workflow
 *            uses, allowed without a prompt (the tool is the gate; a prompt,
 *            or auto mode's classifier, in front of it is noise that can
 *            stall a headless session — permissions.mjs lists the calls);
 *            `git push` and `gh` denied (the two paths that act as the human).
 *
 * `mergeSettings` is idempotent: running setup twice changes nothing, and
 * unrelated keys, hooks and permissions are kept.
 */

/** The helper line. `!` makes git run it as a shell command. */
export const DEFAULT_HELPER = '!graft credential'

/** A credential helper value that is graft's own. */
export const isGraftHelper = (value) => /(?:graft|agit)(\.mjs)?\s+credential/.test(value)

/**
 * @param {{ owners: string[], helper?: string }} input
 * @returns {Record<string, string>}
 */
export function gitConfigEnv({ owners, helper = DEFAULT_HELPER }) {
  /** @type {[string, string][]} */
  const pairs = []
  for (const owner of owners) pairs.push([`url.https://github.com/${owner}/.insteadOf`, `git@github.com:${owner}/`])
  pairs.push(
    // Puts <owner>/<repo>.git in the helper's `path`: without it git sends the
    // host alone, and there is no repo to scope an installation token to.
    ['credential.https://github.com.useHttpPath', 'true'],
    // An empty value RESETS the helper list, so the human's osxkeychain/gh
    // helper is not consulted first and does not answer as the human.
    ['credential.https://github.com.helper', ''],
    ['credential.https://github.com.helper', helper],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
  )
  return pairsToEnv(pairs)
}

/** @param {[string, string][]} pairs */
function pairsToEnv(pairs) {
  /** @type {Record<string, string>} */
  const env = { GIT_CONFIG_COUNT: String(pairs.length) }
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k
    env[`GIT_CONFIG_VALUE_${i}`] = v
  })
  return env
}

/** The `[key, value]` pairs of an env's GIT_CONFIG block. */
export function envToPairs(env = {}) {
  const n = Number(env.GIT_CONFIG_COUNT ?? 0)
  /** @type {[string, string][]} */
  const out = []
  for (let i = 0; i < n; i++) out.push([env[`GIT_CONFIG_KEY_${i}`] ?? '', env[`GIT_CONFIG_VALUE_${i}`] ?? ''])
  return out
}

/** A key the graft block owns: replaced wholesale, never duplicated. */
const graftOwned = (key) =>
  /^url\.https:\/\/github\.com\/.*\.insteadOf$/.test(key) ||
  key.startsWith('credential.https://github.com.') ||
  key === 'commit.gpgsign' ||
  key === 'tag.gpgsign'

const hook = (command, extra = {}) => ({ type: 'command', command, timeout: 30, ...extra })

/** The Claude Code hooks graft wires. */
export function claudeHooks() {
  return {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          hook('graft hook guard-credentials', { timeout: 10 }),
          hook('graft hook guard-pr-writes'),
          hook('graft hook guard-protected', { timeout: 10 }),
        ],
      },
      {
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [hook('graft hook guard-protected', { timeout: 10 })],
      },
      {
        // `graft worktree done` first, so a merged worktree's branch is rewound and the remove passes.
        matcher: 'ExitWorktree',
        hooks: [
          hook('graft hook finish-worktree', { timeout: 60, statusMessage: 'Checking GitHub holds this worktree' }),
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: 'EnterWorktree',
        hooks: [hook('graft hook sync-worktree', { timeout: 60, statusMessage: 'Syncing worktree to its base' })],
      },
    ],
    // Raw git's binding is loaded once, at session start: say so when it is wrong.
    SessionStart: [{ matcher: 'startup|resume', hooks: [hook('graft hook session-check', { timeout: 10 })] }],
  }
}

export const ALLOW = [
  'Bash(graft *)',
  'Bash(git fetch *)',
  'Bash(git merge --no-commit *)',
  'Bash(git add *)',
  // A trailing ` *` needs something after it: the bare forms get their own rule.
  'Bash(git status)',
  'Bash(git status *)',
  'Bash(git diff)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git worktree add *)',
  'Bash(git worktree list)',
  'Bash(git worktree remove *)',
  'EnterWorktree',
  'ExitWorktree',
]
export const DENY = ['Bash(git push *)', 'Bash(gh *)']

/**
 * Merge graft's env, hooks and permissions into an existing settings object.
 * Returns a new object; `existing` is not modified.
 *
 * @param {any} existing
 * @param {{ env?: Record<string, string>, hooks?: any, allow?: string[], deny?: string[] }} add
 */
export function mergeSettings(existing, { env, hooks, allow = ALLOW, deny = DENY } = {}) {
  const out = structuredClone(existing ?? {})

  if (env) {
    const current = out.env ?? {}
    // Keep GIT_CONFIG entries that are not graft's, after graft's own.
    const kept = envToPairs(current).filter(([k]) => !graftOwned(k))
    const rest = Object.fromEntries(
      Object.entries(current).filter(([k]) => !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)),
    )
    const nonGit = Object.fromEntries(
      Object.entries(env).filter(([k]) => !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)),
    )
    out.env = { ...rest, ...nonGit, ...pairsToEnv([...envToPairs(env), ...kept]) }
  }

  if (hooks) {
    out.hooks = out.hooks ?? {}
    for (const [event, groups] of Object.entries(hooks)) {
      out.hooks[event] ??= []
      const list = out.hooks[event]
      for (const group of groups) {
        let target = list.find((g) => g.matcher === group.matcher)
        if (!target) {
          target = { matcher: group.matcher, hooks: [] }
          list.push(target)
        }
        // Hooks written while graft was agit become graft's, never a second copy.
        target.hooks = (target.hooks ?? []).map((x) =>
          typeof x.command === 'string' && /^agit hook /.test(x.command)
            ? { ...x, command: x.command.replace(/^agit hook /, 'graft hook ') }
            : x,
        )
        for (const h of group.hooks) {
          if (!target.hooks.some((x) => x.command === h.command)) target.hooks.push(h)
        }
      }
    }
  }

  out.permissions = out.permissions ?? {}
  for (const [key, add] of /** @type {const} */ ([
    ['allow', allow],
    ['deny', deny],
  ])) {
    out.permissions[key] ??= []
    const list = out.permissions[key]
    for (const rule of add) if (!list.includes(rule)) list.push(rule)
  }
  return out
}

/** Does a settings object carry what graft needs? Missing pieces, for `doctor`. */
export function missingFromSettings(settings) {
  const missing = []
  const pairs = envToPairs(settings?.env)
  if (!pairs.some(([k, v]) => k === 'credential.https://github.com.helper' && isGraftHelper(v)))
    missing.push('env: GIT_CONFIG block naming `graft credential` as the github.com credential helper')
  if (!pairs.some(([k]) => /^url\..*\.insteadOf$/.test(k)))
    missing.push('env: SSH → HTTPS `insteadOf` rewrite (fetches would reach for an SSH key)')
  if (!pairs.some(([k, v]) => k === 'commit.gpgsign' && /^(false|0|no|off)$/i.test(v)))
    missing.push('env: commit.gpgsign=false (local commits would reach for a signing key)')
  const commands = Object.values(settings?.hooks ?? {})
    .flat()
    .flatMap((g) => /** @type {any} */ (g)?.hooks ?? [])
    .map((h) => String(h?.command ?? ''))
  for (const name of ['guard-credentials', 'guard-pr-writes', 'guard-protected', 'finish-worktree', 'session-check'])
    if (!commands.some((c) => c.includes(`hook ${name}`))) missing.push(`hooks: graft hook ${name}`)
  return missing
}
