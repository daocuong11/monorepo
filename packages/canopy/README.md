# canopy

A local, read-only page over [cambium](../cambium)'s heartbeat and the GitHub queues: mode, last tick and its staleness, step results, counts and caps, workers (attempt, elapsed against the wall-clock cap, log paths), recent events, the `q:human` items with their `why:*`, issues stranded when their agent PR closed unmerged, and one swim lane per queue (`q:intake`, `q:task`, `running`, `q:promote`, which also lists closed issues merged but not yet promoted) next to the open `agent/*` PRs and their checks.

The page has four tabs under a header that always shows mode and tick: **Inbox** (what needs you: `q:human`, and stranded issues), **Queue** (the swim lanes and agent PRs), **Traces** (workflow runs, see [Traces](#traces)) and **Health** (last tick, workers, events). Tab badges carry the inbox count, the queued-issue count, the traced-run count (amber when a run has a failed span) and a health dot whose tooltip names the problem, and the browser tab title is prefixed with the inbox count. The tab is kept in the URL hash (`#inbox`, `#inbox/<owner>/<name>/<n>`, `#queue`, `#traces`, `#traces/<trace id>`, `#health`).

## Inbox

The Inbox is a list beside a reading pane, so an item can be read without opening GitHub.

- **List.** `q:human` items and stranded issues together, each with its `why:*` (or **PR closed**), `priority:*`, repo and age. Sort by **Newest**, **Oldest** or **Priority** (`critical`, `high`, `medium`, `low`, then anything else, then none; newest first within each). Filter with tag chips: `q:human` / `stranded`, each `why:*`, each `priority:*`, each repo and any other label. Tags in one group widen the list (any of them), tags in different groups narrow it (all groups). Only tags that would change the list are offered. Sort and filters are remembered in this browser.
- **Pane.** The selected issue: cambium's state comment (its readable part; the hidden marker is dropped), the description, and the newest 10 other comments, rendered from Markdown in the page. Images become links, since the page loads nothing from elsewhere. A stranded issue says which PR closed and how to send it back. The pane is not redrawn while nothing in it changed, so text can be selected and `<details>` stay open across polls.
- **Keys.** `j` / `k` (or the arrow keys in the list) move, `Enter` reads, `o` opens the item on GitHub, `Escape` goes back to the list on narrow screens, where the list and the pane take turns.
- **Reading.** The selected issue is read first, then the rest of the list one at a time; each is re-read when its `updatedAt` changes or after a minute.

## Traces

The **Traces** tab shows cambium's OpenTelemetry spans (see cambium's README, [Tracing](../cambium/README.md#tracing)) without Jaeger: canopy reads the JSON-lines file that cambium's local collector (`packages/cambium/otel/otelcol.yaml`) writes, `~/.cambium/otel/traces.jsonl` by default, plus its rotated backups (`traces-<time>.jsonl`, newest first, up to 64 MB in all).

- **Runs.** One row per trace, newest first: one workflow run of an issue through cambium's graphs (the `cambium.issue` root and every `cambium.node` / `cambium.wait` / `claude.*` span under it, across ticks), or a mycelium intake. Each row shows the issue, graph, the last node to finish and its `cambium.outcome`, start, duration, span and failed-span counts and the summed `claude.cost_usd`.
- **One run** (`#traces/<id>`): a waterfall of its spans, parents above children; waits are grey, failed spans red. Click a span for its attributes, status and events.
- **Stranded.** An open issue with no queue label whose `agent/*` PR was closed unmerged (and no open agent PR closes it) has left the Release Queue and cambium won't pick it up again. The Inbox lists it under **PR closed, issue stranded** with the closed PR; it counts toward the inbox badge. Read from the 50 most recently updated closed PRs per repo.
- **Links.** Inbox and Queue items and the Workers table link to the newest trace for their issue.

Nothing is traced until cambium runs with `OTEL_EXPORTER_OTLP_ENDPOINT` pointing at that collector; until then the tab says so. Files are re-parsed only when one changes size or mtime.

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
| `--traces <file>`     | `<paths.home>/otel/traces.jsonl` from the cambium config, else `~/.cambium/otel/traces.jsonl`   |
| `--config <file>`     | `$CAMBIUM_CONFIG`, else `~/.cambium/config.json`                                                |
| `--repo <owner/name>` | repeatable; else the config's `repos[].slug`, else the heartbeat's repos                        |
| `--cache <seconds>`   | `15`, also the minimum                                                                          |
| `--graft <cmd>`       | `graft`                                                                                         |

## What it serves

- `GET /`: one self-contained HTML page (inline CSS and JS, no external requests, light and dark by `prefers-color-scheme`). It polls `/api/state` every 5 s.
- `GET /api/state`: `{ now, pollMs, cacheMs, notes, heartbeat, github, traces }`.
  - `traces`: `{ status, path, message, files, malformed, total, errored, byIssue }`. `status` is `ok`, `missing` or `unreadable`; `byIssue` maps `owner/name#n` to that issue's newest trace id.
  - `heartbeat`: `{ status, path, message, stale, ageMs, staleAfterMs, data }`. `status` is `ok`, `missing`, `unreadable` or `unknown-version`; anything but `ok` has `data: null` and a `message` the page shows. `stale` once the last tick finished more than 3 × `tickSeconds` ago.
  - `github`: `{ repos: [{ slug, ok, error, fetchedAt }], columns: { intake, task, running, human, promote }, prs, fetchedAt, cached }`.

- `GET /api/traces`: the same file fields plus `traces` (the newest 200 runs: `{ id, start, end, durationMs, spans, errors, root, services, repo, issue, graph, node, outcome, costUsd }`, times in epoch ms).
- `GET /api/traces/<trace id>`: `{ summary, spans }`, spans in tree order with a `depth`; 404 for an unknown id.
- `GET /api/issue/<owner>/<name>/<n>`: `{ issue, fetchedAt, error }` for an issue in a watched repo, `issue` being `{ repo, number, title, url, state, author, body, createdAt, updatedAt, labels, status, comments, earlier }`: `status` is cambium's state comment, `comments` the newest 10 others (oldest first), `earlier` how many others are left to GitHub. Cached like the queues; `error` beside an `issue` means the last refresh failed. 404 for another repo or a missing issue.

Only `GET`/`HEAD` are answered, and only for a loopback `Host` (or the `--host` given), so another site cannot read the page through DNS rebinding.

## Contract with cambium

canopy reads the heartbeat file as documented in cambium's README (shape `version: 1`) and, for traces, the collector's OTLP/JSON output with the span names and attributes listed there; it does not import cambium. A heartbeat with any other `version` is reported, not guessed at.

Queues come from labels, as cambium writes them: an open issue with `running` is in **Running** (it also carries `q:task`); otherwise its `q:*` label places it. `why:*` and `priority:*` are shown on the item.

## Cache

Each repo's GitHub answer is reused for `--cache` seconds (at least 15) however many tabs poll; one fetch per repo is in flight at a time, and a failed refresh keeps the last good answer next to the error.

## Tests

```sh
npm test
```

Heartbeat parsing (fresh, stale, missing, unreadable, unknown version), queue grouping, the Inbox's sorting and tag filters, the Markdown renderer, issue reading and its cache, the cache, settings resolution, trace parsing (OTLP/JSON values, grouping, summaries, span tree order, rotated files, the read cache), the JSON endpoint and the HTML page, all against fixtures and an injected GitHub client on an ephemeral loopback port. Nothing touches the network or `graft`.

## License

AGPL-3.0-only
