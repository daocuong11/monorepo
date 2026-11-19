// @ts-check
/**
 * Finishing a worktree: once GitHub holds everything in it, put its branch
 * back where the session found it, so Claude Code's `ExitWorktree remove`
 * sees nothing to lose (#73).
 *
 * ---------------------------------------------------------------------------
 * WHAT ExitWorktree COUNTS. When `EnterWorktree` creates a worktree it records
 * the commit HEAD was on (its "original head commit": a SHA, not a ref). On
 * `remove` it counts `git rev-list refs/heads/<worktree-branch> ^<that SHA>`
 * and refuses on anything above zero. No ref enters the count — not local
 * `main`, not `origin/*` — so no fetch or fast-forward of `main` can satisfy
 * it. Every graft worktree goes past that SHA twice:
 *
 *   1. `graft hook sync-worktree` (PostToolUse EnterWorktree) fast-forwards
 *      the branch onto origin/<base> AFTER the SHA was recorded;
 *   2. `graft publish` moves the branch onto the commit GitHub created, which
 *      no local commit before it can contain, and the merge happens on GitHub.
 *
 * Both are published history. So once `graft status` would say `nothing local
 * that GitHub does not have`, the branch's commits are disposable locally and
 * the branch is rewound to the recorded SHA: the count is zero, and
 * `ExitWorktree remove` passes without `discard_changes`. A worktree holding
 * one commit GitHub lacks is never rewound — its count stays and the guard
 * still refuses, which is the one case it exists for.
 *
 * ---------------------------------------------------------------------------
 * THE RECORDED SHA. The sync hook writes the HEAD it found, before moving it,
 * to `graft-entered-at` in the worktree's own git dir (removed with the
 * worktree). Without that file — a worktree made before this, or with the hook
 * off — the oldest entry of the branch's reflog is its creation point, which
 * is the same commit.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** The file, in the worktree's git dir, holding the commit the worktree was created on. */
export const ENTERED_AT = 'graft-entered-at'

const SHA = /^[0-9a-f]{40}$/

/** @param {(args: string[]) => string} git */
const enteredAtPath = (git) => git(['rev-parse', '--path-format=absolute', '--git-path', ENTERED_AT]).trim()

/**
 * Record `sha` as the commit this worktree was created on — once: the first
 * record is the one ExitWorktree also holds.
 *
 * @param {(args: string[]) => string} git  @param {string} sha
 */
export function recordEntry(git, sha) {
  const p = enteredAtPath(git)
  if (!existsSync(p)) writeFileSync(p, `${sha}\n`)
}

/**
 * The commit this worktree was created on: the recorded one, else the oldest
 * reflog entry of `branch`. Null when neither is known.
 *
 * @param {(args: string[]) => string} git  @param {string | null} branch
 */
export function enteredAt(git, branch) {
  const p = enteredAtPath(git)
  if (existsSync(p)) {
    const sha = readFileSync(p, 'utf8').trim()
    if (SHA.test(sha) && exists(git, sha)) return sha
  }
  if (!branch) return null
  try {
    const oldest = git(['reflog', 'show', '--format=%H', `refs/heads/${branch}`, '--'])
      .trim()
      .split('\n')
      .at(-1)
    return oldest && SHA.test(oldest) ? oldest : null
  } catch {
    return null
  }
}

/** @param {(args: string[]) => string} git  @param {string} sha */
function exists(git, sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

/** @param {(args: string[]) => string} git  @param {string} a  @param {string} b */
function isAncestor(git, a, b) {
  try {
    git(['merge-base', '--is-ancestor', a, b])
    return true
  } catch {
    return false
  }
}

/**
 * Rewind a fully published worktree to the commit it was created on.
 *
 * `status` is `localOnly`'s answer for this worktree; anything dirty or
 * unpublished in it refuses, and nothing moves. The move is `reset --keep`,
 * which refuses rather than overwrite a local change.
 *
 * @param {object} input
 * @param {(args: string[]) => string} input.git   runs git in the worktree
 * @param {{ head: string | null, local: string | null, dirty: string[], unpublished: string[] }} input.status
 * @returns {{ rewound: true, from: string, to: string }
 *   | { rewound: false, why: 'local-only' | 'unknown-entry' | 'already-there', to?: string }}
 */
export function rewind({ git, status }) {
  if (status.dirty.length || status.unpublished.length) return { rewound: false, why: 'local-only' }
  const to = enteredAt(git, status.local)
  if (!to) return { rewound: false, why: 'unknown-entry' }
  const from = status.head
  if (!from || isAncestor(git, from, to)) return { rewound: false, why: 'already-there', to }
  git(['reset', '--quiet', '--keep', to])
  return { rewound: true, from, to }
}
