---
title: Connect intake sources
description: Turn Discord posts, store reviews and crash reports into q:intake issues with mycelium.
sidebar:
  order: 10
---

mycelium needs graft set up for the receiving repository, and that repository needs the queue labels (`oakgreen setup --repo owner/name`).

1. Create credentials for each source in its own console:

   | Source | You need |
   | --- | --- |
   | Discord | a bot with View Channel and Read Message History (plus Send Messages, and Send Messages in Threads for forums, to answer reporters), invited to the server; its token and the channel ids |
   | App Store and TestFlight (`asc`, `testflight`) | an App Store Connect API key (key id, issuer id, `.p8`) and the app's numeric id |
   | Google Play reviews and vitals (`play`, `vitals`) | a service account with access in Play Console, its key JSON, the package name |

   For vitals, also enable the Google Play Developer Reporting API in the Cloud project and give the account **View app information (read-only)** in Play Console.

2. Write `~/.mycelium/env`, one `KEY=value` per line:

   ```sh
   MYCELIUM_REPO=owner/name
   MYCELIUM_DISCORD_TOKEN=...
   MYCELIUM_DISCORD_CHANNELS=123456,forum:789012
   MYCELIUM_DISCORD_GUILD=345678
   ```

   `forum:<id>` marks a forum channel, which also needs `MYCELIUM_DISCORD_GUILD`. Every variable: [mycelium reference](/reference/mycelium/).

3. Make it private:

   ```sh
   chmod 600 ~/.mycelium/env
   ```

4. Preview each source. This plans issues and writes nothing:

   ```sh
   mycelium poll discord --dry-run
   ```

5. Start the service:

   ```sh
   oakgreen start mycelium
   ```

6. Check: `oakgreen doctor` shows a passing `mycelium <source>` line per source, and `~/.mycelium/logs/mycelium.log` starts with a `mycelium up:` line naming the repository and sources.

## Answer reporters on Discord

Set `MYCELIUM_DISCORD_NOTIFY=true`, then `oakgreen restart mycelium`. Reporters get one message when their issue is filed and one when it closes.

## Collect test-track feedback from Play

Play has no API for it. Set each test track's feedback URL in Play Console to a Discord forum mycelium already reads.
