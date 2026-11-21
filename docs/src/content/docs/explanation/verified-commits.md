---
title: Verified commits
description: Why graft has GitHub create every commit, and what that guarantees.
sidebar:
  order: 3
---

graft never runs `git commit` or `git push`. A publish builds the tree locally, sends GitHub only what it lacks, and asks GitHub to create the commit. This page explains why.

## The problem with pushing

A commit pushed from a local checkout carries whatever identity the machine is configured with, and is unsigned unless someone set up a signing key. For an agent, both are wrong: the work is not the human's, and a key on the machine is one more secret the agent can reach. A ruleset that requires signed commits rejects such pushes, which is exactly what it should do.

## GitHub signs what an App creates

When a GitHub App creates a commit through the Git Database API, GitHub signs it. The commit shows **Verified** as `<app>[bot]`. No key material touches git, and nothing is attributed to a person.

There is one catch, found by probing GitHub directly: GitHub signs the commit **only when the request carries no `author`, `committer` or `signature` key**. Presence breaks it, not value — supplying the App's own identity verbatim produces an unsigned commit that looks identical. graft's commit request accepts exactly three keys (`message`, `tree`, `parents`), and a test pins that. Everything else rests on this invariant.

## Build locally, ship the difference

The tree is built on the machine with git itself, in a throwaway index, so file modes, symlinks and clean filters come out exactly as `git add` would make them. Only blobs GitHub lacks are sent.

Then graft compares the tree hash GitHub computed with the one built locally. Trees are content-addressed: if the hashes differ, what would land is not what was validated, and nothing is committed. The commit is created only on a match, and the branch is moved with a fast-forward that fails if anyone else moved it first. That fast-forward is the concurrency guard.

## Hooks still run

Skipping `git commit` and `git push` would normally mean skipping the repository's git hooks. graft runs them itself — `pre-commit`, `prepare-commit-msg`, `commit-msg`, `pre-push` — at the equivalent moments, on the exact tree that ships. A pre-commit hook that formats files changes the tree before it is judged; a failing hook stops the publish before anything is sent. Skipping hooks takes a person's `no-verify` grant.

## Why not the simpler API

GitHub's GraphQL `createCommitOnBranch` mutation takes file contents and makes a commit in one call. It cannot express a merge: it always makes a single-parent commit. The Git Database sequence makes any shape — one parent for a publish, two for a merge the agent resolved locally — with the same fast-forward guarantee. That is why `graft merge` exists and works the same way as `graft publish`.

## Rate limits and retries

GitHub limits content-creating requests to roughly 80 a minute. Sending each changed file as its own blob would exhaust that on a large reformat, so text rides inline in the tree request, many files at once, and only binaries, symlinks and large files go as separate blobs.

Retries follow from content addressing. Writing a blob or a tree is safe to repeat: the answer is a hash fixed by the content. Creating a commit or moving a branch is not: a repeat could create a second commit. So graft retries the first kind on server errors and dropped connections, and never the second.

If a commit landed but its response was lost, re-running the same publish finds the branch already holds that content, writes nothing, and carries on. The publish is idempotent where it matters.

## What it costs

The local `git` binary becomes read-only toward GitHub. Agents fetch, diff and merge as usual, but every write — commit, branch, PR, merge, comment — is a graft verb. That is a new habit for anyone used to `git push`, and it is the point: there is one write path, and it is the one the protections are built around.
