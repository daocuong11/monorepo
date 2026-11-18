# mycelium

Intake connectors. An external event (a Discord post, an App Store review, a Google Play review) is normalized into an **envelope**, fingerprinted, and either opens one `q:intake` intent issue or, when an open intent already has that fingerprint, becomes a comment on it.

Node ≥ 22; the only dependencies are OpenTelemetry's (see [Tracing](#tracing)). GitHub access goes through [`graft api`](../graft), so `graft` must be on `PATH` and set up for the target repository.

## Usage

```sh
mycelium poll <discord|asc|play> [--dry-run]   # one pass over one source
mycelium run [--dry-run]                       # every configured source, each on its own interval
```

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

## State

One cursor per source in `$MYCELIUM_STATE`, else `$XDG_STATE_HOME/mycelium/state.json`, else `~/.local/state/mycelium/state.json`. The cursor moves after each envelope is filed, so a crash re-reads at most the one in flight. With no cursor, a source starts `MYCELIUM_BACKFILL_HOURS` (default 24) back.

## Configuration

All from the environment. A source with missing settings is skipped by `run` and refused by `poll`.

| variable                                            | meaning                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `MYCELIUM_REPO`                                     | `owner/name` that receives intents (or `--repo`)                                               |
| `MYCELIUM_STATE`                                    | cursor file (or `--state`)                                                                     |
| `MYCELIUM_BACKFILL_HOURS`                           | first-run window, default 24                                                                   |
| `MYCELIUM_<SOURCE>_INTERVAL_S`                      | `run` interval; defaults discord 60, asc 900, play 1800                                        |
| `MYCELIUM_DISCORD_TOKEN`                            | bot token (needs View Channel + Read Message History)                                          |
| `MYCELIUM_DISCORD_CHANNELS`                         | comma list of channel ids; `forum:<id>` for a forum channel                                    |
| `MYCELIUM_DISCORD_GUILD`                            | guild id; required for forum channels, used for message links                                  |
| `MYCELIUM_ASC_KEY_ID`, `MYCELIUM_ASC_ISSUER_ID`     | App Store Connect API key                                                                      |
| `MYCELIUM_ASC_KEY_P8`                               | the `.p8` PEM, or its base64                                                                   |
| `MYCELIUM_ASC_APP_ID`                               | the app's numeric App Store Connect id                                                         |
| `MYCELIUM_PLAY_PACKAGE`                             | Android package name                                                                           |
| `MYCELIUM_PLAY_KEY_JSON` / `MYCELIUM_PLAY_KEY_PATH` | service-account key JSON, inline or as a path (Play Console: reply to reviews / view app info) |

The connectors only read: Discord, App Store Connect and Play are sent GETs (plus Google's OAuth token exchange). Play's reviews API returns only reviews created or edited in the last week.
