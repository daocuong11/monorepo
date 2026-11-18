# cambium

The scheduler daemon. Every tick it reads the `q:*` queues from GitHub, starts headless `claude -p` workers in their own worktrees up to a cap, watches their PRs through CI and the merge queue, and makes every queue transition itself. GitHub is the truth; local SQLite only remembers which processes it started.

This is the **Task phase** MVP. Dispatch and the daily Release run are seams (see [Follow-ups](#follow-ups)).

Zero runtime dependencies, Node ≥ 22.13 (`node:sqlite`). GitHub access goes through [`graft`](../graft), which must be on `PATH`.

## Quick start

```sh
npm install -g @oakgreencc/cambium @oakgreencc/graft
mkdir -p ~/.cambium && $EDITOR ~/.cambium/config.json   # see Configuration
cambium start --once          # one tick in the foreground
cambium install               # writes ~/Library/LaunchAgents/com.oakgreencc.cambium.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.oakgreencc.cambium.plist
cambium status
```

## Commands

| Command                                              | What                                                                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cambium start [--once]`                             | Foreground daemon, one tick every `tickSeconds`. SIGTERM/SIGINT stop it after the current tick; workers keep running and are re-adopted on restart. One daemon per database. |
| `cambium status [--json]`                            | Mode, last tick, queue counts, workers, failed steps. Exit 1 when there is no heartbeat or it is older than 3 ticks.                                                         |
| `cambium pause`                                      | Read and heartbeat only: no transitions, no starts. Running workers are left alone.                                                                                          |
| `cambium drain`                                      | Reconcile, watch and sweep as usual; start nothing new.                                                                                                                      |
| `cambium resume`                                     | Back to `running`.                                                                                                                                                           |
| `cambium run task --issue <n> [--repo <owner/name>]` | Claim one open `q:task` issue, run its worker in the foreground, then make the same transition the daemon would.                                                             |
| `cambium install [--dry-run]`                        | Write the launchd agent (`KeepAlive`, `RunAtLoad`) for `start --config <this config>`; `--dry-run` prints it. It does not call `launchctl`; it prints the command.           |

Every command takes `--config <file>`; the default is `$CAMBIUM_CONFIG`, then `~/.cambium/config.json`.

## One tick

Each step is bounded by `stepTimeoutSeconds`. A step that throws or times out is logged and recorded in the heartbeat, and the tick moves on. Nothing waits on a worker.

1. **Read.** One GraphQL query per repo (`graft graphql`): open issues with any `q:` label, open and recently merged PRs on `agent/*` with their check rollup, merge-queue state and the issues they close.
2. **Reconcile.** For each tracked worker: alive and under its wall-clock cap → nothing. Over the cap → kill its process group. Gone → exit check (a PR on its branch, or closing its issue, that is open or merged and not still on the commit CI already failed) → `submitted`; otherwise requeue with the stderr tail (a failed prepare step requeues as `spawn-failed`). Then the worktree is torn down if `graft status` says GitHub holds everything in it, else kept with a `warn` saying why.
3. **Watch** (no agent), for agent PRs whose issue is in no queue: merged → close the issue, delete the branch; red → requeue with the failing checks' summaries; left the merge queue without merging → requeue; not merged `mergeQueueMinutes` after submission → `q:human`.
4. **Sweep.** An issue labelled `running` with this host (or no host) in its marker and no tracked worker → requeue. This is what makes losing the SQLite file cost one requeue.
5. **Schedule.** Start Task workers for `q:task` issues without `running`, by priority label then age, up to `phases.task.cap` counted from live workers. A task requeued earlier in the same tick can start in that tick.
6. **Release.** Once a day at `release.time` when `release.enabled`; the run itself is a seam.
7. **Heartbeat.** Write the state file.

A requeue is `q:task` with attempt + 1, or, once `maxAttempts` are spent, `q:human` + `why:budget`. cambium never merges: the merge queue and auto-merge do.

## State on GitHub

| Label                                               | Meaning                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `q:intake`, `q:task`, `q:human`, `q:promote`        | The queue. At most one per open issue.                                         |
| `running`                                           | A worker holds the lease (with `q:task`).                                      |
| `why:budget` (also `why:reject`, `why:approve`)     | Why it is in `q:human`.                                                        |
| _no `q:` label_, cambium comment, open `agent/*` PR | Submitted: in the Release Queue, which is the PR's merge-queue state.          |
| `priority:critical` … `priority:low`                | Scheduling order (configurable). Unlabelled sorts after every listed priority. |

Only cambium moves these labels; workers have `graft issue label` and `graft issue edit` denied.

Each issue cambium touches gets one comment it owns and edits in place. Its first line is a hidden marker, the rest is a human rendering of it:

```html
<!-- cambium:state {"v":1,"phase":"task","stage":"queued","attempt":2,"pr":120,"branch":"agent/12-fix-the-tick","host":null,"start":null,"submittedAt":"…","queued":false,"failedSha":"deadbeef…","lastFailure":"CI red on PR #120 …","history":[{"at":"…","attempt":1,"outcome":"ci-red","reason":"…","pr":120}]} -->
```

- `stage`: `queued` | `running` | `submitted` | `human` | `done`.
- `attempt`: the attempt the next (or current) worker runs as, from 1.
- `host`, `start`: set while `running`.
- `failedSha`: the PR head CI was red on; the same commit is never requeued twice, and a worker that exits without moving the head past it has failed.
- `history`: the last 20 outcomes: `submitted`, `failed`, `killed`, `lost`, `spawn-failed`, `ci-red`, `dequeued`, `stalled`, `merged`, `budget`. `log` names the worker's stdout log on the host.
- `--` inside the JSON is written as `--` so the comment cannot end early.

Set `graft.botLogin` to the Clock App's login and only markers written by it are trusted.

## Workers

A worker is `claude -p --output-format stream-json --verbose --max-turns <maxTurns> --allowedTools Read,Edit,Write,Glob,Grep,Bash --disallowedTools "Bash(graft issue label:*),Bash(graft issue edit:*),Bash(gh:*)" <worker.args>`:

- in its own worktree, by the target repo's [worktree convention](#target-repo-convention);
- behind the prepare step: `node src/prepare.mjs -- claude …` runs install-fresh, hydrate and the repo's `prepare` commands in the worktree, writing to the worker's stderr log, then becomes the worker. It runs in the detached process so a long install never blocks a tick;
- detached, leading its own process group (a kill takes its children), stdin from the prompt file;
- with `CAMBIUM_REPO`, `CAMBIUM_ISSUE`, `CAMBIUM_PHASE`, `CAMBIUM_BRANCH` set, and `GRAFT_APP=<worker.graftApp>` when configured;
- with its prompt, stdout and stderr at `<paths.logs>/<owner>__<name>/issue-<n>/a<attempt>-<stamp>.{prompt.md,out.log,err.log}`, keeping the newest `logs.keepPerIssue` runs per issue.

The prompt states the four-point contract (task issue, `pnpm verify`, `graft publish <branch> … --closes <n>`, `graft ci wait`), the attempt, the existing PR if any (`graft advance` onto it), the last failure, the issue's history, the issue body, and the worktree's `AGENTS.md`.

## Configuration

One JSON file. Everything but `repos` is optional; these are the defaults:

```json
{
  "host": "<os.hostname()>",
  "tickSeconds": 30,
  "stepTimeoutSeconds": 20,
  "repos": [{ "slug": "oakgreencc/monorepo", "path": "~/OGCC/monorepo", "baseBranch": "main" }],
  "phases": {
    "task": { "cap": 2, "wallClockMinutes": 60, "maxTurns": 200, "maxAttempts": 3 },
    "dispatch": { "cap": 0, "wallClockMinutes": 15, "maxTurns": 50, "maxAttempts": 3, "maxRounds": 3 }
  },
  "mergeQueueMinutes": 120,
  "priorityLabels": ["priority:critical", "priority:high", "priority:medium", "priority:low"],
  "release": { "enabled": false, "time": "06:00" },
  "paths": {
    "home": "~/.cambium",
    "db": "~/.cambium/cambium.db",
    "heartbeat": "~/.cambium/state.json",
    "logs": "~/.cambium/logs"
  },
  "logs": { "keepPerIssue": 20, "daemonMaxBytes": 10485760 },
  "graft": { "command": "graft", "app": null, "botLogin": null },
  "worker": { "command": "claude", "args": [], "graftApp": null, "fetch": true }
}
```

- `repos[].path` is a local clone; worktrees are added from it and `graft` runs in it.
- `graft.app` is the App cambium acts as (`GRAFT_APP` for its own `graft` calls); `worker.graftApp` the one workers act as. Neither leaks into the other.
- Setting `paths.home` moves every default path under it.
- `release.time` is host-local `HH:MM`.

### Target repo convention

How a repo's worktrees are made is the repo's call: a `"cambium"` key in its root `package.json`, read from the central checkout (`repos[].path`) at each start. Every field is optional; these are the defaults:

```json
"cambium": {
  "worktree": { "root": ".claude/worktrees", "branch": "agent/{issue}-{slug}" },
  "install": "pnpm install --frozen-lockfile",
  "hydrate": { "dirs": [], "files": [] },
  "prepare": []
}
```

- **Branch**: `{issue}` (required) and `{slug}`, the issue title in kebab case, at most 40 characters cut at a word. A retry keeps the branch its first attempt chose (it is in the marker), and an existing PR's branch wins over both.
- **Worktree**: `<repos[].path>/<root>/<topic>`, the topic being the branch less its first segment (`agent/12-fix-the-tick` → `12-fix-the-tick`), so every attempt of an issue uses the same directory. Created with `git fetch origin <baseBranch>`, then `git worktree add --no-track -B <branch> <dir> origin/<baseBranch>`: always from the fetched remote branch, never a local one. Add `<root>` to the repo's `.gitignore`.
- **Teardown**: once the worker is reconciled, `graft status <branch> -C <dir>` (as `graft.app`) must end with `nothing local that GitHub does not have`; then the worktree and its local branch are removed. Anything else (local commits, uncommitted paths, graft failing) keeps it and logs why.
- **Retry**: a leftover worktree in the topic directory is removed under the same rule and re-created fresh; one that still holds local-only work is continued in instead (logged as `continuing in the previous worktree`), so nothing is lost.
- **Prepare**, after the worktree is created and before the worker starts, in order:
  1. **install-fresh**: when the worktree has a `package.json` and `node_modules/.pnpm/lock.yaml` is not a byte copy of `pnpm-lock.yaml`, run `install` (`sh -c`). `"install": false` skips it.
  2. **hydrate**: copy the git-ignored `dirs` and `files` from the central checkout into the worktree with a copy-on-write clone (`cp -c` on APFS), falling back to a byte copy; never a link. What the worktree already has is left alone; what the checkout lacks is reported and skipped; a copy that fails is removed and fails the step. `"hydrate": false` disables it.
  3. **prepare**: each command, `sh -c` in the worktree.

  A failure ends the process with `cambium: prepare failed: …` on stderr; the reconcile requeues it as `spawn-failed` with the stderr tail.
- Unknown keys, wrong types, paths outside the repo and an unparseable `package.json` fail the start (requeued as `spawn-failed`) with the error.

The key decides which commands run on this host, so list `package.json` as protected (CODEOWNERS) in the target repo, next to its `"graft"` policy.

## Heartbeat (`state.json`)

Written at the end of every tick to `paths.heartbeat` (default `~/.cambium/state.json`), whole and renamed into place, so a reader never sees a partial file. canopy reads it. `version` changes only on an incompatible change. All times are ISO 8601 UTC strings; durations are milliseconds.

```jsonc
{
  "version": 1,
  "host": "mac", // config.host
  "pid": 81234, // the daemon's pid
  "mode": "running", // "running" | "paused" | "draining"
  "daemon": { "startedAt": "2026-11-16T12:00:00.000Z", "tickSeconds": 30 }, // startedAt null outside the daemon
  "tick": {
    "n": 42, // ticks since this daemon started
    "startedAt": "…",
    "finishedAt": "…",
    "durationMs": 812,
    "nextAt": "…" // finishedAt + tickSeconds
  },
  "steps": [
    // in order; read, reconcile, watch, sweep, schedule, release (paused: read only; draining: no schedule)
    { "name": "read", "ok": true, "ms": 640, "error": null }
  ],
  "counts": {
    // summed over repos that were read this tick
    "intake": 0,
    "task": 3,
    "human": 1,
    "promote": 0, // open issues per q: label
    "running": 2, // open issues labelled `running`
    "review": 1, // open agent/* PRs
    "workers": 2 // tracked worker processes on this host
  },
  "caps": { "task": 2, "dispatch": 0 },
  "repos": [
    {
      "slug": "oakgreencc/monorepo",
      "ok": true,
      "error": null,
      "counts": { "intake": 0, "task": 3, "human": 1, "promote": 0, "running": 2, "review": 1 }
    } // null when the read failed
  ],
  "workers": [
    {
      "repo": "oakgreencc/monorepo",
      "issue": 12,
      "phase": "task",
      "pid": 90210,
      "alive": true,
      "attempt": 2,
      "branch": "agent/12-fix-the-tick",
      "worktree": "/Users/me/OGCC/monorepo/.claude/worktrees/12-fix-the-tick",
      "startedAt": "…",
      "elapsedMs": 1260000,
      "wallClockMs": 3600000,
      "killedReason": null, // set once killed, until the transition is written
      "logs": { "stdout": "/Users/me/.cambium/logs/…/a2-….out.log", "stderr": "…err.log" }
    }
  ],
  "events": [
    // the last 100 log lines, oldest first
    {
      "at": "…",
      "level": "info",
      "msg": "started task worker pid 90210 (attempt 2, agent/12-fix-the-tick)",
      "repo": "oakgreencc/monorepo",
      "issue": 12
    } // level: "info" | "warn" | "error"; repo/issue optional
  ]
}
```

The mode lives in the SQLite file (`paths.db`, table `control`), so `cambium status --json` returns `{ "mode", "heartbeat" }` even when the daemon is down. The daemon's own log is `<paths.logs>/cambium.log` (one `.1` kept); launchd's stderr goes to `<paths.logs>/cambium.launchd.err.log`.

## Lessons from the old Clock

| Old failure                                  | Here                                                                 | Test                |
| -------------------------------------------- | -------------------------------------------------------------------- | ------------------- |
| One merge per tick could not drain a backlog | cambium has no merge call; the queue merges                          | `lesson #4303`      |
| Fed dev faster than it drained               | Capacity is counted from live worker rows; nothing is queued locally | `lesson #4309`      |
| Dead instances held the slot forever         | Every tick probes each pid and its wall-clock cap                    | `lesson #4349` (×2) |
| Seat-identity check crashed outside tmux     | Workers are plain detached child processes                           | `lesson #4382`      |
| Stall check refused at 10,000 rows           | No local queue; labels are the queue, losing SQLite costs a requeue  | `lesson #4416` (×2) |
| Parked step resumed without waking dev       | One loop decides and spawns, in the same tick                        | `lesson #4565`      |

## Follow-ups

Seams that exist, typed, and do nothing yet:

- **Dispatch** (`src/phases/dispatch.mjs`): `Dispatch(input: { repo, intake, capacity, now }) → { started }`. Reached only when `phases.dispatch.cap > 0`; the stub starts nothing and logs that `q:intake` waits.
- **Release** (`src/phases/release.mjs`): `Release(input: { repo, now }) → { done, note }`. The once-a-day schedule (`releaseDue`) is real and recorded in the store; the run returns `{ done: false }`.
- Conditional (ETag) reads, so an unchanged poll is free against the rate limit; GraphQL has no ETag, so this needs a REST probe in front of the query.
- More than 100 queued issues or open PRs per repo, and state comments beyond an issue's first 100 comments: the read is one page.
- Spend caps per worker (turns and wall clock are enforced today).
- systemd unit / container, and spreading workers over hosts.

## Tests

```sh
npm test
```

`tick()` is driven with a fake clock, GitHub, spawner and process table; the graft client, spawner and launchd plist are tested against fake `exec`/`spawn` and temp directories. Nothing touches the network, GitHub, `claude` or `launchctl`.

## License

AGPL-3.0-only
