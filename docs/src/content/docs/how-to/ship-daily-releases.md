---
title: Ship daily releases
description: Open a promotion PR from an integration branch to a release branch every day, and merge it once approved.
sidebar:
  order: 8
---

This fits a repository where agents merge into one branch (say `develop`) and releases come from another (`main`). It needs the graph engine.

1. On the repository's `repos[]` entry in `~/.cambium/config.json`:

   ```json
   {
     "slug": "owner/app",
     "path": "~/src/app",
     "baseBranch": "develop",
     "release": { "enabled": true, "time": "06:00", "from": "develop", "to": "main" }
   }
   ```

   `from` defaults to `baseBranch`, `to` to `main`. `time` is local `HH:MM`. Top-level `"engine": "graph"` must be set.

2. Restart if you changed `engine`: `oakgreen restart cambium`.
3. Each day at `time`, cambium closes promotion PRs older than 24 hours and opens (or refreshes) one listing the PRs merged into `from` since `to`. It carries `q:promote`.
4. Review and approve the promotion PR. cambium merges it through `graft pr merge --auto`.

## Run it now

```sh
cambium run release-prepare --repo owner/app      # open or refresh the promotion PR; counts as today's run
cambium run release-promote --repo owner/app      # merge approved promotion PRs
```

## See what awaits release

canopy's **Promote** lane lists closed issues whose work is merged into `from` but not yet in `to`. This tracking runs whenever `from` and `to` differ, even with `release.enabled` off.

Node details: [cambium graphs](/reference/cambium/graphs/).
