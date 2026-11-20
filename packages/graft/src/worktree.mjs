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

import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

// ---------------------------------------------------------------------------
// STRAYS. A path HEAD left behind when it moved: the index and the file still
// hold a commit HEAD was on before, though the commit it is on now does not.
// `advance` before `--no-renames` made them — a renamed file's old path stayed
// in the index across `reset --soft` as a staged add — and they are the
// uncommitted paths `worktree done` and ExitWorktree then refuse over.
//
// A dirty path is a stray only when all of these hold, so an agent's own edit
// is never one:
//   - it is a file on disk, and the index holds exactly it (fully staged);
//   - a commit HEAD was on before (its reflog) has that same content there;
//   - the file is no newer than HEAD's move off that commit — a later write,
//     even one restoring that old content, is somebody's work;
//   - GitHub holds that commit (`held`), so the content is not lost.
// Putting a stray back to HEAD loses nothing GitHub lacks.
// ---------------------------------------------------------------------------

/**
 * @param {(args: string[]) => string} git
 * @param {string[]} dirty   the worktree's uncommitted paths
 * @returns {{ path: string, from: string }[]}  each stray and the earlier HEAD holding it
 */
export function strayPaths(git, dirty) {
  if (!dirty.length) return []
  // Newest first: `<sha> HEAD@{<unix time it became HEAD>}`.
  let moves
  try {
    moves = git(['log', '-g', '--date=unix', '--format=%H %gd', 'HEAD', '--'])
      .trim()
      .split('\n')
      .map((l) => /^([0-9a-f]{40}) HEAD@\{(\d+)\}$/.exec(l.trim()))
      .filter((m) => m !== null)
      .map((m) => ({ sha: m[1], at: Number(m[2]) }))
  } catch {
    return [] // no reflog: nothing to compare against
  }
  // Each earlier HEAD, with the time HEAD moved off it.
  const earlier = []
  const seen = new Set([moves[0]?.sha])
  for (let i = 1; i < moves.length; i++) {
    if (seen.has(moves[i].sha)) continue
    seen.add(moves[i].sha)
    earlier.push({ sha: moves[i].sha, leftAt: moves[i - 1].at })
  }
  if (!earlier.length) return []

  const root = git(['rev-parse', '--show-toplevel']).trim()
  const out = []
  for (const path of dirty) {
    let mtime
    try {
      const st = lstatSync(join(root, path))
      if (!st.isFile()) continue
      mtime = Math.floor(st.mtimeMs / 1000)
    } catch {
      continue // gone from disk: a deletion, never left behind by a move
    }
    const staged = /^\d{6} ([0-9a-f]{40}) 0\t/.exec(git(['ls-files', '-s', '--', path]))?.[1]
    if (!staged) continue
    let disk
    try {
      disk = git(['hash-object', '--', path]).trim()
    } catch {
      continue
    }
    if (disk !== staged) continue
    const from = earlier.find(({ sha, leftAt }) => mtime <= leftAt && blobAt(git, sha, path) === disk)
    if (from) out.push({ path, from: from.sha })
  }
  return out
}

/** @param {(args: string[]) => string} git  @param {string} sha  @param {string} path */
function blobAt(git, sha, path) {
  try {
    return /^\d{6} blob ([0-9a-f]{40})\t/.exec(git(['ls-tree', sha, '--', path]))?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Put every stray whose earlier HEAD GitHub holds back to HEAD: dropped when
 * HEAD lacks the path, else restored to HEAD's content. Returns the paths put back.
 *
 * @param {object} input
 * @param {(args: string[]) => string} input.git
 * @param {string[]} input.dirty
 * @param {(sha: string) => Promise<boolean>} input.held   whether GitHub holds the commit
 */
export async function tidy({ git, dirty, held }) {
  /** @type {Map<string, boolean>} */
  const known = new Map()
  const back = []
  for (const { path, from } of strayPaths(git, dirty)) {
    if (!known.has(from)) known.set(from, await held(from))
    if (known.get(from)) back.push(path)
  }
  if (back.length) git(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...back])
  return back
}
