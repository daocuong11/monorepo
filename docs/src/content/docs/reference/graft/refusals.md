---
title: graft refusals
description: Every refusal graft can give, what it means, and what clears it.
sidebar:
  order: 3
---

Every refusal happens before anything reaches GitHub. Each ends with the command that clears it. Headings are the refusal's first line.

## Publish and merge

| Refusal | Meaning | Cleared by |
| --- | --- | --- |
| `no --paths and no --all` | The publish named no paths. The refusal lists every dirty path. | `--paths` with the intended paths, or `--all`. |
| `N paths are protected` | CODEOWNERS, `protected.extra` or self-protection covers these paths. Includes paths the pre-commit hook staged. | Dropping them from `--paths`, or a `protected` grant. The PR still needs code-owner review. |
| `cannot be written by the App at all` | A `protected.impossible` path, by default `.github/workflows/**`. | Nothing. A human applies the change. |
| `this worktree is behind <base>, and publishing would revert N files` | Displacement: the worktree's base is older than the branch. | Rebasing onto `origin/<base>` (recipe in the message), or `--allow-displacement` when reverting is intended. |
| `validation ran against a different origin/<base>` | The base moved after `graft validate`. | `graft advance`, then `graft validate` again; or `--stale-base-ok`. |
| `N paths are not something a publish carries` | A `payload.neverPublish` match, or a path growing by more than `payload.ceilingBytes`. | Removing the path, or `--allow-large <paths>`. |
| `the <hook> hook exited N` | A repository git hook failed. | Fixing the cause; or `--no-verify` with a `no-verify` grant. |
| `the <hook> hook is required by .graft.json but is not an executable file` | A `hooks.required` hook is missing or not executable. | Fixing `hooks.path` or the file mode. |
| `refusing to run: this project's .graft.json requires graft >= X` | `minVersion` is newer than the installed graft. | Updating graft. |
| `refusing to advance: N paths changed on the branch AND in this worktree` | Uncommitted edits collide with new commits on the branch. | `git merge --no-commit <sha>`, resolve, `git add`, `graft merge <branch>`. |
| `refusing to merge: HEAD's first parent is X, but the branch head on GitHub is Y` | The merge was made on a stale worktree. | `git merge --abort`, `graft advance`, redo the merge, `graft merge`. |
| `refusing to merge: N unmerged paths in the index` | Conflicts remain. | Resolving and `git add`-ing each named path. |
| `worktree NOT advanced: a merge in progress (of X) is not on the branch` | The worktree is mid-merge with something the branch lacks. | `graft merge <branch>`, or `git merge --abort`. |

A retry after a lost response finds the content already on the branch: `nothing to publish: … already has this content — no commit made`. Nothing is written; an open PR is reused; the worktree advances.

## `graft pr merge` refusals

The policy is read from the base branch only, never from the worktree. A `merge` grant lifts these locally; GitHub's rulesets still apply.

| Refusal | Meaning | Cleared by |
| --- | --- | --- |
| base not in `mergeableBases` | Agents may not merge into this base. "has no graft policy yet": the base has no `.graft.json`, so only the default branch is mergeable. | A human merge, or a protected change to `mergeableBases`. |
| touches protected paths | No code-owner approval GitHub would count. The refusal's "No code-owner approval clears it: …" names what is missing. | An individual `@login` owner of every protected path approving on GitHub. Team-owned and `protected.extra` paths are never cleared this way. |
| base is red | `requiredCheck` is failing on the base. | A PR that contains the broken head and passes: `graft pr update`, wait for green, merge. |
| the policy on the base does not parse | The base's `.graft.json` is broken. | A protected fix to `.graft.json`. |

Code-owner approval counts on the current head, or on an earlier commit when the base's ruleset keeps stale approvals (`dismiss_stale_reviews_on_push: false`, graft's default). No owner may be requesting changes.

## `graft issue` refusals

| Refusal | Meaning |
| --- | --- |
| `--body` | Inline bodies are refused; use `--body-file`. |
| body changed since it was read | `issue edit`'s etag is stale. A fresh `issue read` gives a new one. |
| label '…' does not exist | Added labels must already exist on the repository. |
| did not assign … | GitHub dropped the login: no repository access, or the login is the App itself. |
| … is unreadable | `issue read` failed with the named status: 404 wrong number or repository, 403 permission. |

## GitHub errors

| Error | Meaning |
| --- | --- |
| 403 not accessible by integration | The App lacks that permission by design (workflows, administration, secrets). |
| 404 | Wrong repository, or the App is not installed there. |
| 422 on `git/refs/heads` | The branch moved mid-publish. Nothing changed. |

## Retries

graft waits out GitHub's 403/429 rate-limit refusals, doubling each wait and reporting it on stderr. Only content-addressed writes (`POST /git/blobs`, `POST /git/trees`) are retried on a 5xx or a dropped connection. Commit creation and ref updates never are.
