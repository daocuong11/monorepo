---
title: Glossary
description: Terms used across graft, cambium, mycelium, canopy, canker and deadwood.
sidebar:
  order: 99
---

## Attempt

One run of a worker on an issue, counted from 1. A requeue adds one; after `maxAttempts` the issue goes to `q:human` with `why:budget`.

## Boundary

The one control an agent cannot reach: GitHub, enforcing code-owner review on the base branch and withholding permissions from the App. See [Boundary and tripwires](/explanation/boundary-and-tripwires/).

## Candidate

What a publish or merge would land, judged before anything is sent: the tree as built (pre-commit hook included) and the paths it changes.

## Code-owner approval

A review GitHub would count toward merging a protected path: an individual `@login` owner from the base's CODEOWNERS approving every such path, with no owner requesting changes.

## CRAP

Change Risk Anti-Patterns score: `comp² × (1 − cov)³ + comp`. High when a function is both complex and untested. See [canker](/reference/canker/).

## Displacement

Content a publish would silently revert because the worktree's base is older than the branch it lands on.

## Envelope

mycelium's normalised form of an external event: `source`, `externalId`, `receivedAt`, `author`, `title`, `body`, `url`, `meta`.

## Fingerprint

A hash of an envelope's source and identity. Envelopes with the same fingerprint land on one intent issue.

## Gate

A local check on a publish (scope, no-verify, validated base, protection, displacement, payload) that refuses before the first write.

## Grant

A human's scoped, session-bound, expiring lift of one kind of tripwire: `protected`, `no-verify` or `merge`. Holding one is called maintainer mode.

## Graph

A typed workflow cambium runs: nodes, edges between them, and an entry queue. cambium's graphs are `task`, `pr`, `dispatch`, `release-prepare`, `release-promote` and `rescue`. See [graphs](/reference/cambium/graphs/).

## Heartbeat

The `state.json` file cambium writes at the end of every tick. canopy and `oakgreen doctor` read it.

## Human queue

Issues labelled `q:human`, with a `why:*` label giving the reason.

## Impossible path

A path the App cannot write at all, by default `.github/workflows/**`. No grant unlocks it.

## Intent issue

A `q:intake` issue mycelium opens for a fingerprint.

## Lease

The `running` label on an issue, held while a worker works it. The state marker names the host.

## Marker

The hidden JSON first line of the one comment cambium owns on each issue. It records where the issue rests in its graph, the attempt, the PR and the history.

## Node

A step in a graph. A **step node** acts and moves on; a **wait** holds until a condition is ready, polled once per tick.

## Promotion PR

The PR cambium opens to promote a repository's integration branch to its release branch (`release.from` → `release.to`), labelled `q:promote`.

## Protected path

A path a human must approve: owned in CODEOWNERS, listed in `protected.extra`, or one of the files that define the protection itself.

## Protection policy

The verdict on paths (impossible, protected, ordinary) read from CODEOWNERS and `.graft.json` at one place: a worktree, a ref or a branch on GitHub. The **base policy** is the one the base branch holds.

## Publish

Landing a worktree's in-scope changes as one commit GitHub creates. Never `git push`.

## Queue

A `q:*` label on an issue: `q:intake`, `q:task`, `q:human`, `q:promote`. At most one per open issue.

## Red base

A base branch whose newest commit with a `requiredCheck` verdict failed. cambium starts no task workers on it except the repair.

## Rescue

cambium's diagnosis of a stuck issue or PR by a read-only worker, followed by fixes cambium carries out and root-cause tickets labelled `rescue`.

## Resolution

The paths of a merge whose content is neither parent's: the agent's own work in it.

## Session

The agent session asking for a grant. A grant unlocks only the session it names.

## Stranded issue

An open issue with no queue label whose agent PR closed unmerged, with no open agent PR closing it.

## Tick

One pass of cambium's loop: read, reconcile, watch, sweep, schedule, release, upkeep, heartbeat. Default every 30 seconds.

## Tripwire

A local control in front of the boundary (an editor hook, a publish gate, a merge policy). An agent with a shell could step over one, but never by accident.

## Validated base

The base commit a green `graft validate` ran against. A publish onto a different base is refused.

## Worker

A headless `claude -p` process cambium starts in its own worktree for one issue: a task worker, a triage worker or a rescue worker.
