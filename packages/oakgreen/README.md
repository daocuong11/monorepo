# oakgreen

One command for the stack: `oakgreen doctor` checks a machine and repository, `oakgreen setup` creates what is missing, and `oakgreen <tool>` runs any of the stack's tools.

Zero third-party dependencies, Node ≥ 22.13 (cambium needs `node:sqlite`). GitHub access goes through [`graft api`](../graft).

## Usage

```sh
npm install -g oakgreen
oakgreen setup --repo owner/name    # labels + cambium config skeleton, then the human steps
oakgreen doctor                     # one checklist, exit 1 if a required check fails
oakgreen graft status               # any tool, args passed through
```

| Command                                                     | What                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `oakgreen <tool> [args...]`                                 | Run `graft`, `canker`, `deadwood`, `cambium`, `mycelium` or `canopy`; stdio inherited, its exit code returned. |
| `oakgreen doctor [--json] [--repo o/n] [--config <file>]`   | The checklist below, `✓`/`✗` with a fix per failing line; `--json` prints `{ ok, checks }`.                    |
| `oakgreen setup [--dry-run] [--repo o/n] [--config <file>]` | Idempotent bootstrap; `--dry-run` prints what it would do and writes nothing.                                  |

A tool runs from its installed package's `bin` (resolved from `oakgreen`'s own `node_modules`) with the current Node; if the package is not installed, the bare name is looked up on `PATH`. A tool found in neither exits 127 with the install command.

`--config` is cambium's config file; the default is `$CAMBIUM_CONFIG`, then `~/.cambium/config.json`.

## Doctor

| Check                 | Passes when                                                                                                                                                  | Required |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `node`                | `process.versions.node` satisfies this package's `engines.node`                                                                                              | yes      |
| `graft doctor`        | `graft doctor` exits 0 (its last line is shown)                                                                                                              | yes      |
| `claude on PATH`      | a `claude` executable is on `PATH`                                                                                                                           | yes      |
| `cambium config`      | the config file exists and parses                                                                                                                            | yes      |
| `cambium status`      | `cambium status --json --config <file>` exits 0 and reports a heartbeat; not run without a config, since it would create its database                        | yes      |
| `cambium heartbeat`   | the heartbeat's `tick.finishedAt` is within 3 × `daemon.tickSeconds` (file: `paths.heartbeat`, else `<paths.home>/state.json`, else `~/.cambium/state.json`) | yes      |
| `queue labels <repo>` | `q:intake q:task q:human q:promote running why:budget why:reject why:approve` all exist                                                                      | yes      |
| `mycelium <source>`   | per enabled source (any of its `MYCELIUM_*` vars set): every var it needs, plus `MYCELIUM_REPO`                                                              | yes      |
| `canker config`       | `canker.json` or `package.json` `"canker"` at the git root of the current directory                                                                          | no       |
| `deadwood config`     | `deadwood.json` or `package.json` `"deadwood"` at the git root                                                                                               | no       |

The repositories checked are `--repo`, else every `repos[].slug` in the cambium config, else `$MYCELIUM_REPO`.

## Setup

1. Writes a cambium config skeleton if the file is absent: one repo (`--repo`, else `$MYCELIUM_REPO`, else the `origin` remote; `OWNER/NAME` if none), its path the current git root. An existing file is never touched.
2. Creates each missing queue label on each configured repository with `graft api POST /repos/<repo>/labels`.
3. Prints the steps only a human can do: create and install the GitHub Apps (`graft setup app`), fill in `graft.app`/`graft.botLogin`/`worker.graftApp`, install the launchd agent (`cambium install`, then the `launchctl bootstrap` it prints), and optionally the mycelium env vars.

Running it again creates nothing.

## Tests

```sh
npm test
```

The GitHub client, command runner, spawner and `PATH` lookup are injected; nothing touches the network, GitHub or `claude`.

## License

AGPL-3.0-only
