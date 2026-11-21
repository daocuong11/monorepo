---
title: Manage services
description: Start, stop, restart, reload and update the stack's background services.
sidebar:
  order: 12
---

The services are launchd user agents (macOS): `otelcol`, `cambium`, `mycelium` and `canopy`. Each command takes service names; with none, it acts on all of them.

| To | Run |
| --- | --- |
| see what runs | `oakgreen services` |
| start (installing the agent the first time) | `oakgreen start [service…]` |
| stop, and keep it stopped across logins | `oakgreen stop [service…]` |
| get a new process on the same definition | `oakgreen restart [service…]` |
| pick up a changed plist (env, Node path) | `oakgreen reload [service…]` |
| update every tool and restart what runs | `oakgreen update` |
| only check for an update | `oakgreen update --check` |

Restarting cambium is safe mid-work: it finishes its current tick, and running workers are adopted by the new process.

## After editing the cambium config

Most keys apply on the next tick. `host`, `engine`, `paths`, `logs` and `graft` need `oakgreen restart cambium`; the log says `restart cambium to apply` until you do.

## Pause scheduling

```sh
cambium drain     # finish what runs, start nothing new
cambium pause     # read and heartbeat only; no label moves, no starts
cambium resume
```

## Serve canopy on another port

```sh
canopy install --port 4400
oakgreen reload canopy
```

`canopy install --dry-run` prints the agent first. The same applies to any other canopy flag.

## Use a cambium config outside the default path

`oakgreen start` installs cambium's agent without `--config`. Write the agent yourself first:

```sh
cambium install --config ~/path/config.json
oakgreen start cambium
```

## Find the logs

| Service | Log |
| --- | --- |
| cambium | `~/.cambium/logs/cambium.log`, launchd errors in `~/.cambium/logs/cambium.launchd.err.log` |
| cambium workers | `~/.cambium/logs/<owner>__<name>/issue-<n>/` |
| mycelium | `~/.mycelium/logs/mycelium.log` |
| canopy | `~/.canopy/logs/canopy.log` |
| otelcol | `~/.cambium/otel/otelcol.log` |

Every command and flag: [oakgreen CLI](/reference/oakgreen-cli/).
