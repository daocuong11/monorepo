// @ts-check
/**
 * Stacked-base gate: an agent builds only on a base it may merge into.
 *
 * `graft pr merge` refuses a PR whose base is outside `mergeableBases`
 * (pr-policy.mjs). A publish that cuts a NEW branch from such a base, or opens
 * a PR against one, makes exactly that PR: work that no agent can land, and
 * that lands at all only if the PR beneath it merges first. Orchestrators that
 * track one PR per issue (cambium) read the two layers as duplicates and close
 * the lower one, stranding the upper. So the refusal moves forward to publish
 * time, before anything is written.
 *
 * Staged work is two issues, the second blocked by the first, each with its own
 * PR into a mergeable base. A human who wants a stack anyway grants `merge`.
 *
 * Publishing to an EXISTING branch is left alone: the branch, and any PR on
 * it, already exist, and refusing a fix to them helps nobody.
 */

/**
 * @param {{ base: string, allowedBases: string[], newBranch: boolean, newPr: boolean }} input
 *   `newBranch`: the publish creates the branch from `base`. `newPr`: it opens a PR against `base`.
 * @returns {string | null} the refusal, or null to go ahead
 */
export function stackedBaseRefusal({ base, allowedBases, newBranch, newPr }) {
  if (allowedBases.includes(base) || (!newBranch && !newPr)) return null
  const bases = allowedBases.length ? allowedBases.map((b) => `\`${b}\``).join(', ') : 'no branch'
  const what = newPr ? `open a PR against \`${base}\`` : `cut a new branch from \`${base}\``
  return (
    `refusing to publish: this would ${what}, and agents merge only into ${bases} (mergeableBases in .graft.json). ` +
    'A PR stacked on another branch cannot land until the one beneath it merges, and no agent can merge it.\n\n' +
    'Publish onto a mergeable base instead. Work that must be reviewed in stages is two issues, the second blocked ' +
    'by the first, each with its own PR.'
  )
}
