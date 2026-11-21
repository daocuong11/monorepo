---
title: canopy
description: canopy's flags, tabs, HTTP endpoints and what it reads from cambium.
sidebar:
  order: 6
---

canopy is a local, read-only page over cambium's heartbeat, the GitHub queues and cambium's traces. It holds no credentials and writes nothing.

Package: `@oakgreencc/canopy`. Node ≥ 22, no runtime dependencies. GitHub is read through `graft graphql`; `graft` must be on `PATH`.

## Commands

| Command | Behaviour |
| --- | --- |
| `canopy [flags]` | Serves the page in the foreground. |
| `canopy install [flags] [--dry-run]` | Writes `~/Library/LaunchAgents/com.oakgreencc.canopy.plist`, serving with the given flags. `--dry-run` prints it. Log: `~/.canopy/logs/canopy.log`. |

## Flags

| Flag | Default |
| --- | --- |
| `--port <n>` | `4317` |
| `--host <addr>` | `127.0.0.1` |
| `--state <file>` | cambium config's `paths.heartbeat` (or `<paths.home>/state.json`), else `~/.cambium/state.json` |
| `--traces <file>` | `<paths.home>/otel/traces.jsonl` from the cambium config, else `~/.cambium/otel/traces.jsonl` |
| `--config <file>` | `$CAMBIUM_CONFIG`, else `~/.cambium/config.json` |
| `--repo <owner/name>` | Repeatable. Else the config's `repos[].slug`, else the heartbeat's repos. |
| `--cache <seconds>` | `15`, also the minimum |
| `--graft <cmd>` | `graft` |

## Tabs

The header always shows mode and last tick. The tab is kept in the URL hash.

| Tab | Hash | Shows |
| --- | --- | --- |
| Inbox | `#inbox`, `#inbox/<owner>/<name>/<n>` | `q:human` items and stranded issues, grouped, in a list beside a reading pane. |
| Queue | `#queue` | Triage, Running and Pull requests; the `q:intake`, `q:task` and `q:promote` lanes; a band of every issue by stage. |
| Graphs | `#graphs`, `#graphs/<name>` | Each cambium graph drawn, with the last 24 hours of moves replayed. |
| Traces | `#traces`, `#traces/<trace id>` | One row per traced run; a span waterfall per run. |
| Health | `#health` | Last tick, workers, events. |

### Inbox groups

Each item sits in the first group it matches. Empty groups are hidden; the sort applies within each group.

| Group | Labels |
| --- | --- |
| Needs a session | `why:budget`, or `ask:decide` with `ask:session` |
| Answer in a comment | any other `ask:decide` |
| Offline chores | `ask:verify`, `ask:chore` |
| Approvals | `why:approve`, `ask:approve` |
| Other | no `ask:*` label to go by |
| PR closed | stranded issues |

Approvals are matched before the other groups.

### Inbox keys

| Key | Action |
| --- | --- |
| `j` / `k`, arrow keys | Move |
| `Enter` | Read |
| `o` | Open on GitHub |
| `Escape` | Back to the list (narrow screens) |

### Interactive session

A `q:human` item cambium wrote a session brief for (`<home>/briefs/<owner>__<name>/issue-<n>.md`, currently `why:budget` only) shows **Interactive session** in the reading pane: the command `cd <repo path> && claude "$(cat <brief>)"` and a **Copy** button. The repo path comes from `repos[].path` in the cambium config; without one the command has no `cd`. Items without a brief show nothing.

### Queue placement

| Labels on an open issue | Column |
| --- | --- |
| `running` with `q:intake` | Triage |
| `running` with `q:task` | Running |
| `q:intake` with `wait:deferred` or `wait:blocked` | Deferred / Blocked (waiting) |
| `q:intake` | Intake |
| `q:task` | Task |
| `q:promote` (open, or closed and not yet promoted) | Promote |
| `q:human` | Inbox |

A **stranded** issue is open, carries no queue label, and its `agent/*` PR closed unmerged with no open agent PR closing it. Read from the 50 most recently updated closed PRs per repository.

## HTTP endpoints

Only `GET` and `HEAD` are answered, and only for a loopback `Host` (or the `--host` given).

| Endpoint | Returns |
| --- | --- |
| `GET /` | One self-contained HTML page; polls `/api/state` every 5 s. |
| `GET /api/state` | `{ now, pollMs, cacheMs, notes, heartbeat, github, traces }` |
| `GET /api/traces` | Trace file fields plus `traces`: the newest 200 runs. |
| `GET /api/traces/<trace id>` | `{ summary, spans }`, spans in tree order with `depth`. 404 for an unknown id. |
| `GET /api/issue/<owner>/<name>/<n>` | `{ issue, fetchedAt, error }` for an issue in a watched repository. 404 otherwise. |

### `/api/state` fields

| Field | Shape |
| --- | --- |
| `heartbeat` | `{ status, path, message, stale, ageMs, staleAfterMs, data }`. `status`: `ok`, `missing`, `unreadable`, `unknown-version`. `stale` after 3 × `tickSeconds`. |
| `github` | `{ repos, columns: { intake, waiting, task, running, human, promote }, prs, fetchedAt, cached }` A `human` item with a session brief carries `brief: { path, command }`. |
| `traces` | `{ status, path, message, files, malformed, total, errored, byIssue, progress, recent, flow }`. `status`: `ok`, `missing`, `unreadable`. |

## Inputs

| Input | Source |
| --- | --- |
| Heartbeat | cambium's `state.json`, schema [`version: 1`](/reference/cambium/heartbeat/). Any other version is reported, not parsed. |
| Traces | The local collector's OTLP/JSON file and rotated backups (`traces-<time>.jsonl`), newest first, up to 64 MB. Re-parsed only when size or mtime changes. |
| Session briefs | `<paths.home>/briefs/` from the cambium config, else `~/.cambium/briefs/`. Checked for each `q:human` item on every `/api/state`. |
| Queues | GitHub labels, through `graft graphql`. Each repository's answer is cached for `--cache` seconds; a failed refresh keeps the last good answer. |
