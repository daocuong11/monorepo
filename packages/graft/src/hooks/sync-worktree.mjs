// @ts-check
/**
 * PostToolUse/EnterWorktree hook — fast-forward a freshly created worktree
 * onto the base branch.
 *
 *   graft hook sync-worktree
 *
 * ---------------------------------------------------------------------------
 * WHY. Claude Code's `EnterWorktree` branches from `origin/<default-branch>`
 * (or the local HEAD, with `worktree.baseRef: "head"`). Neither is necessarily
 * the branch agent PRs land on, and a local ref is only as current as the last
 * fetch. A publish lands whole file contents, so a worktree based on stale
 * content would silently revert everything it does not know about — the
 * displacement gate refuses that at publish time (gates/drift.mjs), and this
 * hook stops the situation arising.
 *
 * The base is `.graft.json`'s `baseBranch`, else the remote's HEAD branch.
 *
 * ---------------------------------------------------------------------------
 * WHY FAST-FORWARD AND NOT `reset --hard`. A hook does not know the tree is
 * disposable. So the safety is structural:
 *
 *   1. nothing happens when `path` was passed — entering an EXISTING worktree
 *      is deliberate, and its ref may be deliberate too;
 *   2. nothing happens when the tree is dirty;
 *   3. `merge --ff-only` refuses rather than discards; a worktree carrying its
 *      own commits is left exactly as it is.
 *
 * Every failure is reported and none is fatal: the hook always exits 0.
 *
 * ---------------------------------------------------------------------------
 * THE MAIN CHECKOUT TOO. The repository's primary worktree is where a human
 * reads, runs and starts things, and what the next worktree hydrates from. Its
 * base branch is fast-forwarded to the same fetched commit under the same
 * rules: checked out there and clean → `merge --ff-only`; on another branch →
 * the ref alone, by a fast-forward-only `fetch .`; anything else is reported.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { resolveContext } from '../context.mjs'

/**
 * The worktree path: from the tool's result text ("Created worktree at <path>
 * …"), which states it outright, else the event's cwd.
 */
export function worktreePath(event) {
  const blob = JSON.stringify(event?.tool_response ?? '')
  const m = blob.match(/worktree at (\/[^"\\\s]+?)(?=["\\\s]|$)/i)
  return m ? m[1] : (event?.cwd ?? process.cwd())
}

/**
 * Fast-forward the primary worktree's `base` to `target`. Null when there is
 * nothing to say: it is the same checkout as `wt`, or already there.
 *
 * @param {string} wt @param {string} base @param {string} target
 */
export function syncMain(wt, base, target) {
  const g = (/** @type {string} */ dir, /** @type {string[]} */ args) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' })
  const first = g(wt, ['worktree', 'list', '--porcelain']).split('\n')[0]
  const main = first.startsWith('worktree ') ? first.slice('worktree '.length) : null
  if (!main || !existsSync(main) || realpathSync(main) === realpathSync(wt)) return null
  const tip = (() => {
    try {
      return g(main, ['rev-parse', '-q', '--verify', `refs/heads/${base}`]).trim()
    } catch {
      return null
    }
  })()
  if (!tip || tip === target) return null
  const head = (() => {
    try {
      return g(main, ['symbolic-ref', '--short', '-q', 'HEAD']).trim()
    } catch {
      return ''
    }
  })()
  const moved = `Main checkout ${base} fast-forwarded ${tip.slice(0, 7)} → ${target.slice(0, 7)}.`
  try {
    if (head === base) {
      if (g(main, ['status', '--porcelain', '--untracked-files=no']).trim()) {
        return `Main checkout (${main}) has uncommitted changes, so its ${base} was NOT fast-forwarded to ${target.slice(0, 7)}.`
      }
      g(main, ['merge', '--ff-only', '--quiet', target])
    } else g(main, ['fetch', '--quiet', '.', `${target}:refs/heads/${base}`])
    return moved
  } catch {
    return `Main checkout ${base} (${tip.slice(0, 7)}) could not be fast-forwarded to ${target.slice(0, 7)}: it has diverged. Left untouched.`
  }
}

/**
 * The whole hook, as a function of the event. Returns the message, if any.
 * The base is Context's offline rule (`baseBranchOffline`): a hook must not
 * mint a token to find it.
 *
 * @param {any} event
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function sync(event, { env = process.env } = {}) {
  // Entering an EXISTING worktree is deliberate. Only a new one is ours.
  if (event?.tool_input?.path) return null
  const wt = worktreePath(event)
  if (!existsSync(wt)) return null

  let base = null
  try {
    const ctx = resolveContext({ cwd: wt, env })
    if (!ctx.root) return null
    const { git } = ctx
    base = ctx.baseBranchOffline()
    if (!base) return null

    if (git(['status', '--porcelain']).trim()) {
      return `Worktree has uncommitted changes, so it was NOT synced to origin/${base}. If it is behind, publishing would revert files — graft's displacement gate will say so.`
    }
    const before = git(['rev-parse', 'HEAD']).trim()
    git(['fetch', 'origin', base])
    const target = git(['rev-parse', 'FETCH_HEAD']).trim()
    let main = null
    try {
      main = syncMain(wt, base, target)
    } catch (err) {
      main = `Could not sync the main checkout: ${/** @type {Error} */ (err)?.message ?? err}.`
    }
    const both = (/** @type {string | null} */ own) => [own, main].filter(Boolean).join(' ') || null
    if (before === target) return both(null)
    try {
      git(['merge', '--ff-only', 'FETCH_HEAD'])
    } catch {
      return both(
        `Worktree at ${before.slice(0, 7)} could not be fast-forwarded to origin/${base} (${target.slice(0, 7)}) — it has diverged. Left untouched; reconcile it before publishing.`,
      )
    }
    return both(`Worktree fast-forwarded ${before.slice(0, 7)} → ${target.slice(0, 7)} (origin/${base}).`)
  } catch (err) {
    return `Could not sync the worktree to origin/${base ?? '<base>'}: ${/** @type {Error} */ (err)?.message ?? err}. Run \`graft advance ${base ?? '<base>'}\` before publishing.`
  }
}

/** A PostToolUse notice (see hooks/index.mjs): its message is shown, never blocks. */
export const event = 'PostToolUse'

/** @param {any} input  @param {{ env: NodeJS.ProcessEnv }} opts */
export const decide = (input, { env }) => sync(input, { env })
