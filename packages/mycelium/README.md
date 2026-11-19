# mycelium

Intake connectors. An external event (a Discord post, an App Store review, a Google Play review) is normalized into an **envelope**, fingerprinted, and either opens one `q:intake` intent issue or, when an open intent already has that fingerprint, becomes a comment on it.

Node ≥ 22; the only dependencies are OpenTelemetry's (see [Tracing](#tracing)). GitHub access goes through [`graft api`](../graft), so `graft` must be on `PATH` and set up for the target repository.

## Usage

```sh
mycelium poll <discord|asc|play> [--dry-run]   # one pass over one source
mycelium run [--dry-run]                       # every configured source, each on its own interval, then the notifier
mycelium notify [--dry-run]                    # one notifier pass (see Notify)
mycelium install [--dry-run]                   # write the launchd agent for `run`
```

As a service: write the settings to `~/.mycelium/env` (see [Configuration](#configuration)), check them with `mycelium poll <source> --dry-run`, then `oakgreen start mycelium`. That writes the agent on first use (`com.oakgreencc.mycelium`, `KeepAlive`, `mycelium run`) and starts it; `oakgreen stop|restart mycelium` and `oakgreen services` manage it from there. `mycelium install` refuses when no source is configured or `MYCELIUM_REPO` is missing, since launchd would restart a process that exits at once. The plist holds only `PATH` (captured at install; `graft` must be on it), `HOME` and an explicit `MYCELIUM_ENV`, never credentials. Its log is `~/.mycelium/logs/mycelium.log`: a `mycelium up:` line at start (repository, sources, notify channels), then one timestamped tally line per pass and one JSON line per issue filed or reporter answered.

`--dry-run` prints one JSON line per envelope with the planned action (`create` with title/body/labels, or `comment` with the issue number) and writes nothing: no GitHub writes, no cursor moves. Without a repository it plans against no open intents.

## Envelope and fingerprint

```js
{
  source, externalId, receivedAt, author, title, body, url, meta
}
```

The fingerprint is the first 24 hex chars of `sha256("<source>:<identity>")`, lowercased and trimmed. Only the identity counts; text, author and time do not.

| source  | identity                                                                                     |
| ------- | -------------------------------------------------------------------------------------------- |
| discord | `<channelId>/<rootId>`: the forum thread, the message a reply answers, or the message itself |
| asc     | `<appId>/<reviewId>`                                                                         |
| play    | `<packageName>/<reviewId>`; an edited review keeps its id, so the edit lands as a comment    |

## Issues

A new intent's body is a fixed template: the marker `<!-- mycelium:fingerprint=<fp> -->` on the **first line** (the only place it is read), an `## Intake` table (source, fingerprint, external id, author, received, url, `meta.*`), and `## Report` holding the reporter's text in a fence, so it cannot mention anyone or inject markup. Label: `q:intake`.

Dedupe reads every open `q:intake` issue once per pass (`GET /repos/<repo>/issues?state=open&labels=q:intake`, paginated), so it never depends on the search index.

## Tracing

Each filed envelope records one short `mycelium.intake` span (`service.name=mycelium`), the root of its own trace, with attributes `mycelium.source`, `mycelium.external_id`, `mycelium.fingerprint`, `mycelium.action` (`create` or `comment`) and `mycelium.issue.number`.

- **Create:** the span starts before the issue is written, and its W3C traceparent goes into the first-line marker: `<!-- mycelium:fingerprint=<fp> traceparent=00-<trace-id>-<span-id>-<flags> -->`. The issue number is set on the span once GitHub returns it. Bodies without a traceparent (filed before tracing, or with tracing off) still parse.
- **Comment** (a duplicate): a new trace whose span has a **link** (not a parent) to the issue's traceparent, when it has one.

`parseTraceparent(body)` (exported from `@oakgreencc/mycelium`) returns that span context, `{ traceId, spanId, traceFlags, isRemote, traceparent }`, or null; like the fingerprint, only the first line counts.

Configuration is the standard `OTEL_*` environment only. Spans export over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set (headers, timeout etc. from `OTEL_EXPORTER_OTLP_*`; `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` override the resource). With no endpoint, or `OTEL_SDK_DISABLED=true`, or `OTEL_TRACES_EXPORTER=none`, tracing is a no-op: the SDK is not loaded and no traceparent is written. Spans are batched and flushed before the CLI exits; `--dry-run` never records or exports.

## Notify

The notifier answers reporters where they reported: one acknowledgement while the intent is open (`Filed as #N <url>. You'll get one more message here when it closes.`), and one outcome note when it closes, keyed on `state_reason` (`completed` → **Fixed.**, `duplicate` (or `not_planned` + `duplicate` label) → **Closed as a duplicate.**, anything else or an `invalid` label → **Closed without a fix.**). An intent closed before it was acknowledged gets only the outcome note.

Each pass reads `GET /repos/<repo>/issues?state=all&since=<cursor>` (any label: triage moves intents off `q:intake`), keeps bodies with the first-line marker, reads the source and url from the `## Intake` table, and hands each to that source's channel. What was posted is recorded per issue under `notify` in the state file before the cursor moves, so a restart never posts twice; a failed post is reported in the tally line and holds the cursor, so it is retried next pass. The first pass reads back `MYCELIUM_BACKFILL_HOURS`. `run` runs it after the sources every `MYCELIUM_NOTIFY_INTERVAL_S` (default 60).

Channels are opt-in per source:

| source  | setting                      | posts                                                                                                                                                          |
| ------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| discord | `MYCELIUM_DISCORD_NOTIFY=true` | in the forum post's thread, or as a reply to the channel message; mentions never parsed. The bot needs Send Messages (and Send Messages in Threads for forums). |

asc and play have no channel: their reviews are answered (or not) in the store consoles.

## State

One cursor per source in `$MYCELIUM_STATE`, else `$XDG_STATE_HOME/mycelium/state.json`, else `~/.local/state/mycelium/state.json`. The cursor moves after each envelope is filed, so a crash re-reads at most the one in flight. With no cursor, a source starts `MYCELIUM_BACKFILL_HOURS` (default 24) back.

## Configuration

From the environment, over the settings file `$MYCELIUM_ENV` (default `~/.mycelium/env`): `KEY=value` lines with the same keys, `#` comments, values bare or quoted. A variable set in the environment wins. Keep the file `0600`. A source with missing settings is skipped by `run` and refused by `poll`.

| variable                                            | meaning                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `MYCELIUM_ENV`                                      | the settings file; environment only, default `~/.mycelium/env`                                 |
| `MYCELIUM_REPO`                                     | `owner/name` that receives intents (or `--repo`)                                               |
| `MYCELIUM_STATE`                                    | cursor file (or `--state`)                                                                     |
| `MYCELIUM_BACKFILL_HOURS`                           | first-run window, default 24                                                                   |
| `MYCELIUM_<SOURCE>_INTERVAL_S`                      | `run` interval; defaults discord 60, asc 900, play 1800                                        |
| `MYCELIUM_DISCORD_TOKEN`                            | bot token (needs View Channel + Read Message History)                                          |
| `MYCELIUM_DISCORD_CHANNELS`                         | comma list of channel ids; `forum:<id>` for a forum channel                                    |
| `MYCELIUM_DISCORD_GUILD`                            | guild id; required for forum channels, used for message links                                  |
| `MYCELIUM_DISCORD_NOTIFY`                           | `true` answers Discord reporters ([Notify](#notify)); the token then needs Send Messages       |
| `MYCELIUM_NOTIFY_INTERVAL_S`                        | notifier interval in `run`, default 60                                                         |
| `MYCELIUM_ASC_KEY_ID`, `MYCELIUM_ASC_ISSUER_ID`     | App Store Connect API key                                                                      |
| `MYCELIUM_ASC_KEY_P8`                               | the `.p8` PEM, or its base64                                                                   |
| `MYCELIUM_ASC_APP_ID`                               | the app's numeric App Store Connect id                                                         |
| `MYCELIUM_PLAY_PACKAGE`                             | Android package name                                                                           |
| `MYCELIUM_PLAY_KEY_JSON` / `MYCELIUM_PLAY_KEY_PATH` | service-account key JSON, inline or as a path (Play Console: reply to reviews / view app info) |

The connectors only read: Discord, App Store Connect and Play are sent GETs (plus Google's OAuth token exchange). The only writes outside GitHub are the [notifier](#notify)'s, and only for channels turned on. Play's reviews API returns only reviews created or edited in the last week.
