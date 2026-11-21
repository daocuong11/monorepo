---
title: The boundary and the tripwires
description: graft's security model — one control the agent cannot reach, and local checks that catch mistakes early.
sidebar:
  order: 2
---

graft lets an agent work a GitHub project without being trusted with it. The design rests on a distinction between two kinds of control.

## One boundary

A **boundary** is a control the agent cannot reach. graft has exactly one: GitHub, configured so that

- the base branch requires a pull request, review from code owners, and signed commits;
- the GitHub App the agent acts as holds no Workflows or Administration permission.

Without Workflows, GitHub rejects any App write to `.github/workflows/**`. CI judges the agent's work; an agent that could edit CI could make itself green. Without Administration, the App cannot loosen the rulesets it is held to. These are not graft's rules — they are GitHub's, enforced on GitHub's side, and no local trickery changes them.

## Many tripwires

Everything graft does locally is a **tripwire** in front of that boundary: editor hooks that refuse an edit, publish gates that refuse a commit, a merge policy that refuses a merge. An agent with a shell could step over any of them.

So why have them? Because what they buy is not security but *intent*:

- A protected file is never changed by accident.
- A gate is never skipped silently.
- Every deliberate exception is a grant a person made, with a reason and an expiry, written to a log.

The other gain is timing. Without tripwires, an agent touching a protected file is discovered at review, after the work is done. With them, it is discovered at the first keystroke, before any effort is wasted.

## CODEOWNERS is the manifest

The tripwires and the boundary read the same list: CODEOWNERS. Whatever it assigns an owner is a protected path. graft's editor hook refuses to change it, `graft publish` refuses to ship it, and `graft pr merge` refuses the PR until a code owner has approved. With "require review from Code Owners" on the base branch, GitHub enforces the same list.

Because both layers read one file, they cannot drift apart. An earlier design kept a hand-maintained list of control paths with a separate check that it matched; making CODEOWNERS *the* list removed both.

A few paths are protected whether CODEOWNERS names them or not: `.graft.json`, CODEOWNERS itself, and `.claude/settings.json` — the files that define the protection. And some paths are **impossible**: the App cannot write them at all, so no grant unlocks them.

## Grants

Sometimes a person wants an agent to change a protected file. Rather than switching protection off, they issue a **grant**: a scoped, session-bound, expiring lift of one kind of tripwire.

- **Scoped.** `protected` (edit and publish protected paths), `no-verify` (skip git hooks) or `merge` (merge past the local merge policy). Each lifts one thing.
- **Session-bound.** It unlocks only the agent session it was typed into. Another session working in the same clone gets nothing.
- **Expiring.** Four hours by default, at most a day.
- **Human-made.** The agent's own hooks refuse a grant the agent runs itself.

A grant moves only the tripwire. The PR still needs the code owner's review on GitHub. The person acts twice: once to let the work happen, once to approve it.

## Approval as the normal path

Most of the time a grant is unnecessary. When an agent's PR touches protected paths, the code owner approves it on GitHub, and `graft pr merge` then lets the agent land it: it checks GitHub's own records for an approval GitHub would count. The person acts once — approve — and the agent does the rest. Paths owned only by a team, or protected only by graft's own config, cannot be cleared this way; GitHub does not record an individual's ownership of them, so a person merges.

## Why a GitHub App

The agent acts as an App, not as a person:

- Its commits are signed by GitHub and show **Verified** as the App, never attributed to whichever human `user.name` resolved to.
- Its permissions are fixed at creation and visible on GitHub.
- Its installation is the blast radius: install it only on the repositories agents should touch.
- Its key lives on the machine, never in the repository.

How the commits come to be Verified is in [Verified commits](/explanation/verified-commits/). The exact permissions and rulesets are in [GitHub App and rulesets](/reference/graft/github-app/).
