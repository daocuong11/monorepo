# graft refusals

Every refusal happens before anything reaches GitHub, so retrying after the fix is always safe. Find the refusal's first line below.

## `no --paths and no --all`

The publish did not say what it carries. The refusal lists every dirty path. Pass `--paths` with the ones you mean; `--all` only when every listed path belongs in the commit.

## `N paths are protected`

CODEOWNERS (or `.graft.json` `protected.extra`, or self-protection) says a human approves these. Either drop them from `--paths` and publish the rest, or ask the human for `--scope protected`. With a grant, the PR still needs the code owner's review on GitHub — say that in the PR body. The gates judge the tree as built, so a path the pre-commit hook staged is listed too; if you did not name it, the hook wrote it — report that rather than working around it.

## `cannot be written by the App at all`

`protected.impossible` — by default `.github/workflows/**`. No grant exists. Leave the path out, and put the exact patch in your report for the human to apply.

## `this worktree is behind <base>, and publishing would revert N files`

Your worktree's base is older than the branch, and publishing whole files would silently undo the listed changes. Run the recipe in the message (park edits in a wip commit, rebase onto `origin/<base>`, `reset --soft`). `--allow-displacement` only when reverting those files is the intent.

## `validation ran against a different origin/<base>`

The base moved after `graft validate`. `graft advance <base-or-branch>`, then `graft validate` again. `--stale-base-ok` only when the intervening commits provably cannot touch this change; state why in the PR.

## `N paths are not something a publish carries`

A `*.log` (or another `payload.neverPublish` pattern), or a path growing by more than the ceiling in one publish. Logs and dumps stay out of git. If the path truly is source, `--allow-large <exact paths>`.

## `the <hook> hook exited N`

The repository's own git hook failed — the same hook `git commit`/`git push` would have run. Read its output above the refusal, fix the cause, publish again. Skipping hooks is `--no-verify` and needs a `no-verify` grant: a human's call.

## `the <hook> hook is required by .graft.json but is not an executable file`

A hook the project requires is missing (a bad `hooks.path`, a file without `+x`). Report it; do not work around it.

## `refusing to run: this project's .graft.json requires graft >= X`

Update graft on this machine (human task), then retry.

## `refusing to advance: N paths changed on the branch AND in this worktree`

Your uncommitted edits collide with new commits on the branch. `git merge --no-commit <sha>` (the message names it), resolve, `git add`, then `graft merge <branch>`. No local commit is needed.

## `refusing to merge: HEAD's first parent is X, but the branch head on GitHub is Y`

The merge was made on a stale worktree. `git merge --abort` (if a merge is still in progress), `graft advance <branch>`, redo the merge with `git merge --no-commit`, `graft merge <branch>`.

## `refusing to merge: N unmerged paths in the index`

A merge in progress still has conflicts. Resolve each named path, `git add` it, run `graft merge <branch>` again. Nothing was published.

## `worktree NOT advanced: a merge in progress (of X) is not on the branch`

The worktree is mid-merge with something the branch does not contain. Publish it with `graft merge <branch>`, or `git merge --abort` it, then advance.

## `graft pr merge` refusals

- **base not in mergeableBases** — this project does not let agents merge into that branch; hand the PR to a human. "has no graft policy yet" means the base carries no `.graft.json`, so the defaults applied (only the default branch); adding one with `mergeableBases` is a protected change.
- **touches protected paths** — ask the code owner to approve the PR on GitHub, then run `graft pr merge <n>` again: an approval GitHub counts (an individual `@login` owner of every such path, on the current head — or on an earlier commit when the base's ruleset keeps stale approvals, as graft's does) lets it through, with a note naming the approver. The refusal's "No code-owner approval clears it: …" says what is missing. Paths owned only by a team, or protected only by `.graft.json`, are never cleared this way — the human merges those.
- **base is red** — merging onto a known break buries it. If this PR is the fix: `graft pr update <n>`, let its required check finish green, then merge; a PR that contains the broken head and passes goes through.
- **the policy on the base does not parse** — the base's `.graft.json` is broken, so the merge could only be judged by the defaults. Report it; fixing it is a protected change.

A `merge` grant lifts these locally; GitHub's rulesets still apply. The policy is read from the base branch alone — never from your worktree.

## `graft issue` refusals

- **`--body`** — bodies come from a file: write it, pass `--body-file <f>` (or pipe it with `--body-file -`).
- **body changed since it was read** (`issue edit`) — someone edited the issue after your `issue read`. Read it again, re-apply your change to the new body, and edit with the new `etag`. Never retry with the old one.
- **label '…' does not exist** — GitHub would have created it. Check the repo's labels (`graft api GET /repos/o/r/labels --paginate`) for the intended name; creating a new label is the human's call.
- **did not assign …** — GitHub silently dropped the login: it has no access to the repo, or it is the App itself (which cannot be assigned).
- **… is unreadable** (`issue read`, exit 1, nothing on stdout) — the line names the status: 404 wrong number/repo, 403 permission. Not "the issue is empty".

## `graft ci wait` verdicts

Exit 0 green, 1 red, 2 **unknowable** — the newest run was cancelled/skipped/neutral, the wait timed out, or check runs were unreadable three times in a row; the JSON's `reason` says which. Unknowable is never green: re-run the wait (a longer `--timeout`), or find out why the check did not answer. No `--check` and no `requiredCheck` in `.graft.json` is a usage error.

## GitHub errors

- **403 not accessible by integration** — the App lacks that permission on purpose (workflows, administration, secrets). Hand it to the human.
- **404** — wrong repo, or the App is not installed there. `graft doctor`.
- **422 on git/refs/heads** — the branch moved mid-publish; nothing changed. `graft advance <branch>` and retry.
