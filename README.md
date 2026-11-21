# oakgreencc monorepo

Tooling for any software project: graft (agent writes to GitHub), cambium (the scheduler), mycelium (intake connectors), canopy (the queue UI), canker (CRAP check) and deadwood (prose gate).

| Package                              | What                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [`packages/graft`](packages/graft)   | Work a GitHub project as a GitHub App (formerly agit). Published as `@oakgreencc/graft`.       |
| [`packages/plugin`](packages/plugin) | The `oakgreen` agent plugin (Claude Code and Kiro): a guided setup wizard for the whole stack. |

```sh
pnpm install
pnpm start           # the stack from source: canopy (restarts on edits), cambium unless one already runs, mycelium if configured
pnpm verify          # lint + test, every project, from the Nx cache when unchanged
```

User documentation (tutorials, how-to guides, reference, explanation) lives in [`docs/`](docs), a Starlight site.

AGPL-3.0-only.
