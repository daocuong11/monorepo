---
title: cambium configuration
description: The cambium config file, every key and default, and the target repository's "cambium" key.
sidebar:
  order: 2
---

One JSON file: `--config`, else `$CAMBIUM_CONFIG`, else `~/.cambium/config.json`. Only `repos` is required.

## Defaults

```json
{
  "host": "<os.hostname()>",
  "engine": "legacy",
  "tickSeconds": 30,
  "stepTimeoutSeconds": 20,
  "repos": [{ "slug": "oakgreencc/monorepo", "path": "~/OGCC/monorepo", "baseBranch": "main" }],
  "phases": {
    "task": { "cap": 2, "wallClockMinutes": 60, "maxTurns": 200, "maxAttempts": 3, "maxReworks": 3 },
    "dispatch": {
      "cap": 0,
      "wallClockMinutes": 15,
      "maxTurns": 50,
      "maxAttempts": 3,
      "maxRounds": 3,
      "deferHours": 6,
      "maxDefers": 8
    },
    "rescue": { "cap": 0, "wallClockMinutes": 20, "maxTurns": 80, "maxAttempts": 1 }
  },
  "mergeQueueMinutes": 120,
  "merge": "none",
  "priorityLabels": ["priority:critical", "priority:high", "priority:medium", "priority:low"],
  "release": { "enabled": false, "time": "06:00" },
  "reaper": { "everyMinutes": 60, "staleMinutes": 30, "orphanDays": 3 },
  "retriage": { "enabled": false, "time": "05:00", "maxSkipDays": 14 },
  "rescue": {
    "everyMinutes": 60,
    "staleHours": 12,
    "graceMinutes": 30,
    "cooldownHours": 24,
    "maxRescues": 2,
    "causeRepo": null
  },
  "paths": {
    "home": "~/.cambium",
    "db": "~/.cambium/cambium.db",
    "heartbeat": "~/.cambium/state.json",
    "logs": "~/.cambium/logs"
  },
  "logs": { "keepPerIssue": 20, "daemonMaxBytes": 10485760 },
  "graft": { "command": "graft", "app": null, "botLogin": null },
  "worker": { "command": "claude", "args": [], "graftApp": null, "fetch": true, "env": {} },
  "update": { "auto": false, "checkMinutes": 360 },
  "gc": { "everyMinutes": 60, "graceMinutes": 60, "staleDays": 14 }
}
```

## Reloading

The daemon re-reads the file before every tick. Changes to caps, limits, `tickSeconds`, `repos`, `priorityLabels`, `release` and `worker` apply without a restart (logged as `config reloaded: <keys>`).

`host`, `engine`, `paths`, `logs` and `graft` are fixed at start. A change logs `restart cambium to apply` once.

A file that does not load, or has no `repos`, keeps the running config and logs one warning until fixed.

## Top level

| Key                  | Default    | Meaning                                                                                                   |
| -------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `host`               | hostname   | Written into `running` leases; Sweep only recovers leases with this host or none.                        |
| `engine`             | `"legacy"` | `"legacy"` (stage tick) or `"graph"`. Dispatch, release graphs, rescue, upkeep, red base and tracing need `"graph"`. |
| `tickSeconds`        | `30`       | Interval between ticks.                                                                                   |
| `stepTimeoutSeconds` | `20`       | Bound on each tick step; a step over it is logged and the tick moves on.                                  |
| `mergeQueueMinutes`  | `120`      | A submitted PR not merged after this long goes to `q:human` (`why:approve`).                              |
| `merge`              | `"none"`   | Who merges a Task PR: `"none"` (merge queue, auto-merge or a human) or `"green"` (cambium, once CI is green; graph engine). Overridable per repo. |
| `priorityLabels`     | four `priority:*` | Scheduling order, first is highest. Unlabelled issues sort after all of them.                     |

## `repos[]`

| Key             | Default            | Meaning                                                                                       |
| --------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `slug`          | required           | `owner/name`.                                                                                 |
| `path`          | required           | Local clone. Worktrees are added from it; `graft` runs in it.                                 |
| `baseBranch`    |                    | Branch Task PRs land on.                                                                      |
| `requiredCheck` | `"ci"`             | Check whose runs on `baseBranch` decide [red base](/explanation/merging-and-red-base/). `null` turns the gate and repair off. |
| `merge`         | top-level `merge`  | Per-repo override.                                                                            |
| `release`       | see below          | Per-repo release settings (graph engine).                                                     |

`repos[].release`: `{ "enabled", "time", "from", "to" }`. `enabled` and `time` default to the top-level `release`; `from` to `baseBranch`; `to` to `"main"`. A repo whose `from` equals `to` has no promotion PR.

## `phases`

| Key                         | Default | Meaning                                                              |
| --------------------------- | ------- | -------------------------------------------------------------------- |
| `task.cap`                  | `2`     | Live Task workers, counted from tracked processes.                   |
| `task.wallClockMinutes`     | `60`    | Worker killed past this.                                             |
| `task.maxTurns`             | `200`   | Passed as `--max-turns`.                                             |
| `task.maxAttempts`          | `3`     | Attempts before `q:human` + `why:budget`.                            |
| `task.maxReworks`           | `3`     | Reworks of one PR before `q:human` + `why:budget`.                   |
| `dispatch.cap`              | `0`     | Triage workers; `0` turns triage off.                                |
| `dispatch.wallClockMinutes` | `15`    |                                                                      |
| `dispatch.maxTurns`         | `50`    |                                                                      |
| `dispatch.maxAttempts`      | `3`     | Failed triage starts before `q:human`.                               |
| `dispatch.maxRounds`        | `3`     |                                                                      |
| `dispatch.deferHours`       | `6`     | Recheck delay when a `defer` verdict gives no `recheckHours`.        |
| `dispatch.maxDefers`        | `8`     | Defers before `q:human` + `why:triage`.                              |
| `rescue.cap`                | `0`     | Rescue workers; `0` turns rescue off.                                |
| `rescue.wallClockMinutes`   | `20`    |                                                                      |
| `rescue.maxTurns`           | `80`    |                                                                      |
| `rescue.maxAttempts`        | `1`     |                                                                      |

## Clocks

| Key                      | Default   | Meaning                                                                         |
| ------------------------ | --------- | ------------------------------------------------------------------------------- |
| `release.enabled`        | `false`   | Run the release step daily.                                                     |
| `release.time`           | `"06:00"` | Host-local `HH:MM`.                                                             |
| `reaper.everyMinutes`    | `60`      | Reaper interval; `0` turns it off.                                              |
| `reaper.staleMinutes`    | `30`      | An untracked agent PR idle this long is examined.                               |
| `reaper.orphanDays`      | `3`       | A PR naming no issue is closed after this long untouched.                       |
| `retriage.enabled`       | `false`   | Daily return of `q:human` issues (not `why:approve`) to `q:intake`.             |
| `retriage.time`          | `"05:00"` | Host-local `HH:MM`.                                                             |
| `retriage.maxSkipDays`   | `14`      | An unchanged `q:human` issue is re-triaged anyway after this many days; `0` never skips. |
| `rescue.everyMinutes`    | `60`      | Stuck-item sweep interval.                                                      |
| `rescue.staleHours`      | `12`      | Age for `stale-task`, `stale-intake` and `pr-stale`.                            |
| `rescue.graceMinutes`    | `30`      | A label change counts only after this long since the marker last moved.         |
| `rescue.cooldownHours`   | `24`      | An item rescued within this is skipped.                                         |
| `rescue.maxRescues`      | `2`       | Rescues per item per week before it goes straight to `q:human` + `why:rescue`.  |
| `rescue.causeRepo`       | `null`    | Repository for root-cause tickets; `null` files them in the item's own repo.    |
| `update.auto`            | `false`   | Self-update between ticks.                                                      |
| `update.checkMinutes`    | `360`     | Check interval; minimum 5.                                                      |

### `gc`

| Key                | Default | Meaning                                                                           |
| ------------------ | ------- | --------------------------------------------------------------------------------- |
| `gc.everyMinutes`  | `60`    | Worktree GC interval; `0` turns it off (`cambium gc` still works).               |
| `gc.graceMinutes`  | `60`    | A worktree touched within this (directory, HEAD, reflog, dirty path) is skipped. |
| `gc.staleDays`     | `14`    | Idle worktrees holding work GitHub lacks are archived after this.                |

GC skips the checkout itself, worker worktrees and locked worktrees (a Claude Code session lock counts only while its pid is alive). Verdicts:

| Verdict    | Condition                               | Action                                                                                         |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| complete   | `graft status`: GitHub holds all of it  | Removed with its local branch.                                                                 |
| stale      | Idle `staleDays`, work GitHub lacks     | Archived to `<home>/gc/<owner>__<name>/<dir>-<stamp>/` (`commits.bundle`, `changes.patch`, `untracked/`, `worktree.json`), then removed. |
| kept       | Anything else                           | Left; `cambium gc --dry-run` gives the reason.                                                 |

## `paths`, `logs`

| Key                    | Default                  | Meaning                                                 |
| ---------------------- | ------------------------ | ------------------------------------------------------- |
| `paths.home`           | `~/.cambium`             | Setting it moves every default path under it.           |
| `paths.db`             | `<home>/cambium.db`      | SQLite store.                                           |
| `paths.heartbeat`      | `<home>/state.json`      | [Heartbeat](/reference/cambium/heartbeat/) file.        |
| `paths.logs`           | `<home>/logs`            | Daemon and worker logs.                                 |
| `logs.keepPerIssue`    | `20`                     | Worker runs kept per issue.                             |
| `logs.daemonMaxBytes`  | `10485760`               | Daemon log rotation size.                               |

Worker logs: `<paths.logs>/<owner>__<name>/issue-<n>/a<attempt>-<stamp>.{prompt.md,out.log,err.log}`.

## `graft`, `worker`

| Key               | Default    | Meaning                                                                                           |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `graft.command`   | `"graft"`  | graft executable.                                                                                 |
| `graft.app`       | `null`     | App cambium acts as (`GRAFT_APP` for its own `graft` calls).                                      |
| `graft.botLogin`  | `null`     | That App's login. When set, only state markers written by it are trusted.                         |
| `worker.command`  | `"claude"` | Worker executable.                                                                                |
| `worker.args`     | `[]`       | Extra arguments appended to the worker command.                                                   |
| `worker.graftApp` | `null`     | App workers act as (`GRAFT_APP` in the worker's environment). Never shared with `graft.app`.     |
| `worker.fetch`    | `true`     |                                                                                                   |
| `worker.env`      | `{}`       | Extra environment for every worker; string values only.                                           |

## Target repository: `"cambium"` key

Read from the root `package.json` of the central checkout (`repos[].path`) at each worker start. Every field is optional.

```json
"cambium": {
  "worktree": { "root": ".claude/worktrees", "branch": "agent/{issue}-{slug}" },
  "install": "pnpm install --frozen-lockfile",
  "hydrate": { "dirs": [], "files": [] },
  "prepare": []
}
```

| Key               | Default                           | Meaning                                                                                                     |
| ----------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `worktree.root`   | `.claude/worktrees`               | Worktree directory, relative to the clone.                                                                  |
| `worktree.branch` | `agent/{issue}-{slug}`            | `{issue}` required. `{slug}`: issue title in kebab case, at most 40 characters, cut at a word.              |
| `install`         | `pnpm install --frozen-lockfile`  | Run (`sh -c`) when `node_modules/.pnpm/lock.yaml` differs from `pnpm-lock.yaml`. `false` skips.             |
| `hydrate.dirs`    | `[]`                              | Git-ignored directories copied from the checkout (copy-on-write clone, else byte copy; never a link).       |
| `hydrate.files`   | `[]`                              | Git-ignored files copied likewise. `"hydrate": false` disables.                                             |
| `prepare`         | `[]`                              | Commands run with `sh -c` in the worktree, in order.                                                        |

- Worktree path: `<repos[].path>/<root>/<topic>`, topic being the branch less its first segment (`agent/12-fix-the-tick` → `12-fix-the-tick`).
- Created with `git fetch origin <baseBranch>` then `git worktree add --no-track -B <branch> <dir> origin/<baseBranch>`.
- A retry keeps the branch of its first attempt; an existing PR's branch wins over both.
- Prepare order: install-fresh, hydrate, prepare. A failure exits with `cambium: prepare failed: …` and is requeued as `spawn-failed`.
- Unknown keys, wrong types, paths outside the repository or an unparseable `package.json` fail the start (`spawn-failed`).
- Teardown requires `graft status <branch> -C <dir>` to end with `nothing local that GitHub does not have`; otherwise the worktree is kept and the reason logged.
