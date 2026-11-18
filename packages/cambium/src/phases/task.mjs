// @ts-check
/**
 * @param {{
 *   repo: string, issue: import('../github.mjs').Issue, marker: import('../marker.mjs').Marker,
 *   branch: string, pr: import('../github.mjs').PullRequest | null, agentsMd: string | null, maxAttempts: number,
 * }} input
 */
export function taskPrompt({ repo, issue, marker, branch, pr, agentsMd, maxAttempts }) {
  const history = marker.history
    .map(
      (h) =>
        `- ${h.at} attempt ${h.attempt}: ${h.outcome}${h.pr ? ` (PR #${h.pr})` : ''}${h.reason ? ` — ${h.reason}` : ''}`,
    )
    .join('\n')
  return `You are a Task worker started by cambium, the scheduler, in a fresh git worktree of ${repo}.
This is attempt ${marker.attempt} of ${maxAttempts}. Nobody is watching this session; work until the task is done or you are certain it cannot be.

Your contract (the repository's AGENTS.md, four points):
1. Task: GitHub issue #${issue.number} (below). Its acceptance checks are the definition of done.
2. Verify: \`pnpm verify\` (lint + tests). Green means committable; the pre-commit hook runs the same command.
3. Push: \`graft publish ${branch} "<conventional commit message>" --paths <a,b> --pr "<title>" --closes ${issue.number}\`. Never \`git commit\`, \`git push\`, \`git fetch\` or \`git pull\`.
4. Done: \`graft ci wait ${branch}\`. Green: stop, the PR merges through the queue. Red: read why (\`graft jobs <run>\`), fix, publish again.

Rules:
- Publish to exactly the branch \`${branch}\` and pass \`--closes ${issue.number}\`: that is how cambium finds your PR.
- Do not touch labels or the issue body (\`graft issue label\` / \`graft issue edit\` are denied); cambium moves the queue.
- Exiting without a published PR counts as a failed attempt.
${
  pr
    ? `\nA PR already exists: #${pr.number} (${pr.url}) on \`${pr.branch}\`. Start from it: \`graft advance ${pr.branch}\`, then fix what failed.\n`
    : ''
}${marker.lastFailure ? `\nWhy the last attempt failed:\n\`\`\`\n${marker.lastFailure}\n\`\`\`\n` : ''}${history ? `\nHistory of this issue:\n${history}\n` : ''}
--- Issue #${issue.number}: ${issue.title} (${issue.url})
${issue.body}
${triageSection(marker.triage)}${agentsMd ? `\n--- AGENTS.md\n${agentsMd}` : ''}`
}

/** What triage added (dispatch graph), when it added anything. @param {import('../marker.mjs').Marker['triage']} t */
function triageSection(t) {
  if (!t || (!t.title && !t.acceptance?.length)) return ''
  const checks = (t.acceptance ?? []).map((a) => `- [ ] ${a}`).join('\n')
  return `\n--- From triage (cambium's dispatch, also posted on the issue)\n${t.title ? `Task: ${t.title}\n` : ''}${checks ? `Acceptance checks:\n${checks}\n` : ''}`
}

/**
 * @param {import('../github.mjs').Snapshot} snap
 * @param {{ issue: number, branch?: string | null }} w
 */
export function prFor(snap, { issue, branch }) {
  const rank = { OPEN: 0, MERGED: 1, CLOSED: 2 }
  return (
    snap.prs
      .filter((p) => (branch && p.branch === branch) || p.closes.includes(issue))
      .sort((a, b) => rank[a.state] - rank[b.state])[0] ?? null
  )
}

/**
 * A PR whose head is still the commit CI already failed on is no progress.
 * @param {import('../github.mjs').PullRequest | null} pr
 * @param {{ failedSha?: string | null }} [marker]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function taskExit(pr, marker = {}) {
  if (pr?.state === 'OPEN' && marker.failedSha && pr.headSha === marker.failedSha)
    return { ok: false, reason: `worker exited without pushing a fix: PR #${pr.number} head is still the red commit` }
  if (pr && (pr.state === 'OPEN' || pr.state === 'MERGED')) return { ok: true }
  return {
    ok: false,
    reason: pr ? `PR #${pr.number} was closed without merging` : 'worker exited without a published PR',
  }
}
