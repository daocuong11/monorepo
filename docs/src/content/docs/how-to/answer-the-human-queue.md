---
title: Answer the human queue
description: Clear what cambium has handed to you in q:human.
sidebar:
  order: 7
---

1. Open canopy (`http://127.0.0.1:4317/`) on the **Inbox** tab. It lists `q:human` issues and issues stranded when their PR closed unmerged, grouped by what answering takes. `j`/`k` move, `Enter` reads, `o` opens the issue on GitHub.
2. Pick a group to suit where you are:
   - **Needs a session**: open the code and work it through.
   - **Answer in a comment**: the state comment lists the options and a recommendation; reply with your choice.
   - **Offline chores**: checks and chores away from the keyboard; comment when each is done.
   - **Approvals**: review and merge.
3. Read the reason: the `why:*` label, the ask, and the last failure in cambium's state comment.
4. Act on it:

   | Label | Meaning | What to do |
   | --- | --- | --- |
   | `why:triage` | triage could not decide, or needs an answer | reply on the issue |
   | `why:budget` | attempts or reworks ran out | fix the cause, then reply or requeue |
   | `why:approve` | the PR needs a merge only a person may make | review and approve or merge the PR |
   | `why:rescue` | the rescue graph could not unstick it | read rescue's report comment, fix by hand |
   | **PR closed** | the agent PR closed unmerged; no queue holds the issue | requeue it, or close it |

## Reply to send it back

With the graph engine and triage on, comment on the issue. A comment from a person (not a bot, not the App) wakes it: cambium moves it back to `q:intake`, and triage reads your reply with the original question. This works for every `why:*` except `why:approve`.

The same applies to issues parked as deferred or blocked: a reply gets them triaged now.

## Requeue by hand

Move the issue's label from `q:human` to `q:task` (straight to work) or `q:intake` (triage again), and remove its `why:*` and `ask:*` labels.

## Re-triage the whole queue daily

```json
{ "retriage": { "enabled": true, "time": "05:00" } }
```

Every `q:human` issue except `why:approve` goes back to `q:intake` once a day. `time` is local.

Label meanings in full: [Labels and state](/reference/cambium/labels-and-state/).
