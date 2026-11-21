---
title: Merging and the red base
description: Who merges agent PRs, why cambium updates a PR before merging it, and how a broken base branch is handled.
sidebar:
  order: 7
---

An agent PR going green is not the end. Someone has to merge it, and the merge has to leave the base branch green for the next worker. This page covers both.

## Who merges

By default, not cambium. With `merge: "none"`, a green PR is left to whatever the repository already uses: a GitHub merge queue, auto-merge, or a person. If it is not merged within a set time after submission, cambium hands it to `q:human` with `why:approve`.

With `merge: "green"` (graph engine only), cambium merges a PR once its CI is green and it has no conflicts. It does so through `graft pr merge`, so graft's merge policy still decides: a PR touching protected paths needs a code owner's approval, a base branch agents may not merge into is refused, and a red base stops the line. A refusal only a person can clear goes to `q:human`.

The default is conservative for a reason. An earlier scheduler merged one PR per tick and could never drain a backlog. Leaving merging to dedicated machinery avoided that; letting cambium merge is an opt-in for repositories that have none.

## Update, then merge

Two PRs can each be green against the same base and red together. A merge queue exists to catch exactly this: it tests each PR on top of the ones ahead of it.

GitHub's merge queue costs money, and neither of the stack's own repositories runs one. cambium gets most of the benefit without it. Before merging, it reads the PR's state live; a PR that is behind its base is updated (`graft pr update`) instead of merged. The new head runs CI, and only once that is green does cambium merge. A merge earlier in the same tick counts, so two PRs cannot both slip in on a stale base.

The cost is latency: a busy repository updates and re-tests PRs more often than a merge queue would batch them.

## The red base

Every task PR lands on the base branch. If the base is broken, every worker fails for a reason that is not its own. Without a gate, each one spends its attempts, and the human queue fills with work that was never wrong.

So cambium watches the base branch's required check. The newest commit with a verdict decides whether the base is **green**, **red** (with the last green commit and the merges since, the suspects) or **unknown**. A pending or cancelled run says nothing, so a red base stays red until a run passes. A repository whose CI runs only on pull requests is always unknown, and unknown gates nothing.

While the base is red:

- **No new task workers start** on that repository, except the repair.
- **Failures are not charged.** A worker that fails during a red base is requeued at the same attempt and never sent to a person. It waits for green.
- **A repair issue is opened** automatically: high priority, its body naming the failing run and the suspect merges, asking to fix forward or revert. It runs as an ordinary task, charged like one.

The repair's PR merges through graft's red-base rescue: graft normally refuses to merge onto a red base, but a PR that is up to date with the base and whose own check passes is, by construction, a fix. When the base turns green, an unneeded repair issue is closed.

## Why stop the line

Merging onto a known break buries it: the next failure is attributed to the wrong change, and the cause gets harder to find with each merge on top. Stopping work until the base is green costs throughput for a while; not stopping costs much more, spread over every worker and every person reading the human queue.

Configuration is in [cambium configuration](/reference/cambium/configuration/); the merge refusals are in [graft refusals](/reference/graft/refusals/).
