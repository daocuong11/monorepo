# runner-watchdog

Private, unreleased. A launchd job for the self-hosted GitHub Actions runner Mac.

The runner's `Runner.Worker` sometimes hangs while spawning a step's bash: no child process, its newest `_diag/Worker_*.log` ends on a `Starting process:` block with no `Process started` after it. The runner takes one job at a time, so everything queues behind it until `timeout-minutes` + 5 fires (sektorapp/monorepo#1739).

Once a minute this script checks for that wedge and, when every condition holds (single worker, no children, log ends on a spawn, log silent ≥ 5 min), samples the worker's stacks, then sends SIGTERM and, after 10 s, SIGKILL. The Listener is never touched. It also logs once a day if the worker binary is the x86_64 build, which runs under Rosetta 2 and causes the wedge (sektorapp/monorepo#3606).

Node ≥ 22 built-ins only. The runner install is `FACTORY_RUNNER_DIR`, default `~/SeKtor/actions-runner`.

```sh
node packages/runner-watchdog/src/runner-watchdog.mjs --dry-run   # report, signal nothing
```

## Install

User-domain launchd, no sudo. The plist points at this checkout (`~/OGCC/monorepo`), so the script must be on disk there first.

```sh
cp ~/OGCC/monorepo/packages/runner-watchdog/launchd/com.oakgreencc.runner-watchdog.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.oakgreencc.runner-watchdog.plist
```

## Uninstall

```sh
launchctl bootout gui/$(id -u)/com.oakgreencc.runner-watchdog
rm ~/Library/LaunchAgents/com.oakgreencc.runner-watchdog.plist
```

## Logs

All under `$FACTORY_RUNNER_DIR`:

- `runner-watchdog.log`: one line per verdict or signal (`wedged`, `ambiguous`, `captured`, `SIGTERM`, `freed`, `x86_64`, …). Quiet is normal; healthy ticks write nothing.
- `runner-watchdog.launchd.log`: stdout/stderr from launchd, for anything that stopped the script first (missing node, missing file).
- `wedge-<iso>-<pid>.sample.txt`: the `sample` capture taken before each kill.

```sh
launchctl print gui/$(id -u)/com.oakgreencc.runner-watchdog | grep -E 'state|last exit'
```
