# oakgreencc monorepo

Tooling for any software project: graft (agent writes to GitHub), cambium (the scheduler), mycelium (intake connectors), canopy (the queue UI), canker (CRAP check) and deadwood (prose gate).

| Package                            | What                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| [`packages/graft`](packages/graft) | Work a GitHub project as a GitHub App (formerly agit). Published as `@oakgreencc/graft`. |

```sh
pnpm install
pnpm verify          # lint + test, every project, from the Nx cache when unchanged
```

AGPL-3.0-only.
