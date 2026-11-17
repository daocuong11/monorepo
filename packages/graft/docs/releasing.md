# Releasing

graft is released from `oakgreencc/monorepo` with [Nx release](https://nx.dev/features/manage-releases). Every push to `main` runs `.github/workflows/release.yml`, which tests graft and then runs `nx release --yes`:

1. reads the Conventional Commits that touched `packages/graft` since the last `graft@*` tag;
2. bumps from the version currently on npm (`currentVersionResolver: registry`);
3. publishes `@oakgreencc/graft` with provenance through npm trusted publishing (OIDC, no stored token);
4. pushes the `graft@X.Y.Z` tag and creates the GitHub release.

Nothing is committed back to `main`; the version lives in the tag and the published package.

| Commit                         | Release |
| ------------------------------ | ------- |
| `fix: …`, `perf: …`            | patch   |
| `feat: …`                      | minor   |
| `BREAKING CHANGE:` in the body | major   |
| anything else                  | none    |

## Configuration

| File                            | Holds                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `nx.json` → `release`           | projects, `graft@{version}` tags, conventional commits, registry version, GitHub release |
| `.github/workflows/release.yml` | test, then release; runs in the `npm` environment with `id-token: write`                 |

## One-time setup

Trusted publishing can only be configured for a package that already exists, so the first version of `@oakgreencc/graft` (0.2.0) is published by hand from `packages/graft` (`npm publish --access public`). Then:

```sh
npm trust github @oakgreencc/graft --repo oakgreencc/monorepo --file release.yml --env npm --allow-publish
```

(npm ≥ 11.15, 2FA on the account.) Until this runs, a release attempt fails at publish.
