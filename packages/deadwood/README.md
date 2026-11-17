# deadwood

The prose gate. Two checks over the files `git ls-files` reports, so ignored and generated files never count:

- **Markdown allowlist.** A tracked `.md`/`.mdx` file outside `markdown.allow` fails.
- **Comment-density ceiling.** A tracked JS/TS file (`.js .mjs .cjs .jsx .ts .mts .cts .tsx`) fails when its comment lines exceed `comments.maxDensity` of its non-blank lines.

Existing offenders can be frozen in a baseline that may only shrink.

Zero dependencies, Node ≥ 22.

```sh
npm install -D @oakgreencc/deadwood
npx deadwood            # exit 0 clean, 1 offenders, 2 usage/config error
npx deadwood --json     # { ok, checked, offenders, tolerated, stale }
```

```
docs/notes.md	markdown	markdown file outside markdown.allow
src/a.mjs	comments	comment density 0.231 > 0.150 (3/13 lines)
```

## Configuration

`deadwood.json` at the repo root, or the same object under a `"deadwood"` key in the root `package.json` (both present is refused). Every field is optional; these are the defaults:

```json
{
  "include": ["**"],
  "exclude": [],
  "markdown": { "allow": ["**/README.md", "AGENTS.md", "CLAUDE.md"] },
  "comments": { "maxDensity": 0.15, "minLines": 10 },
  "overrides": [],
  "baseline": "deadwood.baseline.json"
}
```

- Globs match the whole repo-relative path: `README.md` is the root file only, `**/README.md` is any. `*`, `?`, `**`, `{a,b}`.
- `include`/`exclude` apply to both checks.
- `comments.minLines`: files with fewer non-blank lines are not measured.
- `overrides`: `{ "files": [globs], "comments": { "maxDensity"?, "minLines"? } | false }`, applied in order; `false` turns the density check off for those files.

## What counts as a comment line

Density is comment lines ÷ non-blank lines. A line counts when any part of a `//`, `/* */` or JSDoc comment sits on it, trailing comments included. The scanner tracks strings, template literals (with nested `${}`) and regex literals, so `'http://…'`, `` `/* … */` `` and `/\/\//` are code.

Never counted:

- the shebang;
- directives: `@ts-check`, `@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`, `biome-ignore`, `eslint-disable`/`enable`, `prettier-ignore`, `istanbul`/`c8`/`v8 ignore`, `@vitest-environment`, `@jest-environment`, `@jsx*`, `#region`, `/// <reference>`;
- JSDoc rows that carry only types (`@param {T} name`, `@returns {T}`, `@type`, `@typedef`, `@template`, multi-line `{ … }` types). A row with a description (`@param {T} name - why`) is prose and counts.

## Baseline (ratchet)

```sh
deadwood --init     # write deadwood.baseline.json from today's offenders; refused if one exists
deadwood            # baselined offenders pass; new ones, or a baselined file whose density grew, fail
deadwood --update   # rewrite the baseline from the current state; it can only shrink
```

The baseline lists markdown paths and each file's density (rounded up to 4 places). When an entry is fixed or improved, a plain run says so on stderr; `--update` drops or lowers it. `--update` never adds an entry or raises one: if anything new fails, it exits 1 and writes nothing. Own the baseline file in CODEOWNERS so growing it takes a human.

## Wiring it into Nx

deadwood is repo-wide, so it runs as a target on a root project that depends on every project. Any change anywhere marks it affected, and Nx caches it on the whole tree. In the root `package.json`:

```json
{
  "devDependencies": { "@oakgreencc/deadwood": "^0.1.0" },
  "nx": {
    "name": "workspace",
    "implicitDependencies": ["*"],
    "targets": {
      "deadwood": { "command": "deadwood", "cache": true }
    }
  },
  "scripts": {
    "verify": "nx run-many -t lint test deadwood"
  }
}
```

In this monorepo, use `"workspace:*"` for the dependency.

## Tests

```sh
npm test
```

The CLI is tested with injected file listing and I/O, plus one run of the bin against a real temporary git repo.

## License

AGPL-3.0-only.
