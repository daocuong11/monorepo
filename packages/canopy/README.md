# canopy

A local, read-only page over [cambium](../cambium)'s heartbeat and the GitHub queues: mode, last tick and its staleness, step results, counts and caps, workers (attempt, elapsed against the wall-clock cap, log paths), recent events, the `q:human` items with their `why:*`, and one swim lane per queue (`q:intake`, `q:task`, `running`, `q:promote`) next to the open `agent/*` PRs and their checks.

The page has three tabs under a header that always shows mode and tick: **Inbox** (`q:human`, what needs you), **Queue** (the swim lanes and agent PRs) and **Health** (last tick, workers, events). Tab badges carry the inbox count, the queued-issue count and a health dot whose tooltip names the problem, and the browser tab title is prefixed with the inbox count. The tab is kept in the URL hash (`#inbox`, `#queue`, `#health`).

Zero runtime dependencies, Node ≥ 22. GitHub is read through [`graft`](../graft) (`graft graphql`), which must be on `PATH`; canopy holds no credentials and writes nothing.

## Quick start

```sh
npm install -g @oakgreencc/canopy @oakgreencc/graft
canopy                       # http://127.0.0.1:4317/
```

## Flags

| Flag                  | Default                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `--port <n>`          | `4317`                                                                                          |
| `--host <addr>`       | `127.0.0.1`. canopy never binds a public address unless told to.                                |
| `--state <file>`      | cambium config's `paths.heartbeat` (or `paths.home`/`state.json`), else `~/.cambium/state.json` |
| `--config <file>`     | `$CAMBIUM_CONFIG`, else `~/.cambium/config.json`                                                |
| `--repo <owner/name>` | repeatable; else the config's `repos[].slug`, else the heartbeat's repos                        |
| `--cache <seconds>`   | `15`, also the minimum                                                                          |
| `--graft <cmd>`       | `graft`                                                                                         |

## What it serves

- `GET /`: one self-contained HTML page (inline CSS and JS, no external requests, light and dark by `prefers-color-scheme`). It polls `/api/state` every 5 s.
- `GET /api/state`: `{ now, pollMs, cacheMs, notes, heartbeat, github }`.
  - `heartbeat`: `{ status, path, message, stale, ageMs, staleAfterMs, data }`. `status` is `ok`, `missing`, `unreadable` or `unknown-version`; anything but `ok` has `data: null` and a `message` the page shows. `stale` once the last tick finished more than 3 × `tickSeconds` ago.
  - `github`: `{ repos: [{ slug, ok, error, fetchedAt }], columns: { intake, task, running, human, promote }, prs, fetchedAt, cached }`.

Only `GET`/`HEAD` are answered, and only for a loopback `Host` (or the `--host` given), so another site cannot read the page through DNS rebinding.

## Contract with cambium

canopy reads the heartbeat file as documented in cambium's README (shape `version: 1`) and nothing else of cambium's; it does not import cambium. A heartbeat with any other `version` is reported, not guessed at.

Queues come from labels, as cambium writes them: an open issue with `running` is in **Running** (it also carries `q:task`); otherwise its `q:*` label places it. `why:*` and `priority:*` are shown on the item.

## Cache

Each repo's GitHub answer is reused for `--cache` seconds (at least 15) however many tabs poll; one fetch per repo is in flight at a time, and a failed refresh keeps the last good answer next to the error.

## Tests

```sh
npm test
```

Heartbeat parsing (fresh, stale, missing, unreadable, unknown version), queue grouping, the cache, settings resolution, the JSON endpoint and the HTML page, all against fixtures and an injected GitHub client on an ephemeral loopback port. Nothing touches the network or `graft`.

## License

AGPL-3.0-only
