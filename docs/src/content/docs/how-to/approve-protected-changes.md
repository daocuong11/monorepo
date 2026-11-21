---
title: Approve protected changes
description: Let an agent edit, publish or merge something only a person may approve.
sidebar:
  order: 3
---

An agent that hits a protected path stops and asks you for a grant. A grant lifts one kind of check, for one session, until it expires.

## Grant access for a session

1. Read the agent's reason. Decide which scope it needs:

   | Scope | Lets the session |
   | --- | --- |
   | `protected` | edit and publish paths CODEOWNERS owns (the PR still needs code-owner review) |
   | `no-verify` | publish without running the repository's git hooks |
   | `merge` | run `graft pr merge` past the local merge policy (base, protected paths, red base) |

2. In that Claude Code session, type:

   ```sh
   ! graft maintainer grant "why this session needs it" --scope protected
   ```

   From another terminal, name the session: `--session <id>`. The refusal the agent showed you prints the id.

3. If the default 4 hours is wrong, add `--hours N` (at most 24).

A grant the agent runs itself is refused. Every grant is logged in `.git/graft/maintainer.log`.

## Check or end a grant

```sh
graft maintainer status            # every session's grant
graft maintainer revoke            # this session's
graft maintainer revoke --session <id>
```

## Approve a PR that touches protected paths

1. Review the PR on GitHub and approve it as an individual code owner of every protected path in it.
2. The agent's `graft pr merge` then goes through, naming you as approver. No grant needed.

If the paths are owned only by a team, or protected only by `protected.extra` in `.graft.json`, merge the PR yourself.

## Apply a workflow change

The App cannot write `.github/workflows/**`, and no grant changes that. Apply the patch the agent describes yourself and commit it the normal way.

## Protect another path

Add it to CODEOWNERS with an owner, or to `protected.extra` in `.graft.json`. Both files are themselves protected. Check what is protected and why:

```sh
graft protected path/to/file
```

Background: [The boundary and the tripwires](/explanation/boundary-and-tripwires/).
