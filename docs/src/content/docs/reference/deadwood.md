---
title: deadwood
description: deadwood's two checks, configuration, comment-counting rules, baseline and exit codes.
sidebar:
  order: 8
---

deadwood is a prose gate over the files `git ls-files` reports. Package: `@oakgreencc/deadwood`. No dependencies. Node ≥ 22.

## Checks

| Check | Fails when |
| --- | --- |
| Markdown allowlist | A tracked `.md` or `.mdx` file is outside `markdown.allow`. |
| Comment density | A tracked `.js .mjs .cjs .jsx .ts .mts .cts .tsx` file's comment lines exceed `comments.maxDensity` of its non-blank lines. |

## Commands

```
deadwood [--json] [--update | --init] [-C <dir>]
```

| Flag | Behaviour |
| --- | --- |
| `--json` | `{ ok, checked, offenders, tolerated, stale }` on stdout |
| `--init` | Writes the baseline from today's offenders. Refused if one exists. |
| `--update` | Rewrites the baseline. It may only shrink; if anything new fails, exits 1 and writes nothing. |
| `-C <dir>` | Repository root. Default: current directory. |

| Exit | Meaning |
| --- | --- |
| 0 | Clean |
| 1 | Offenders |
| 2 | Usage or configuration error |

```
docs/notes.md	markdown	markdown file outside markdown.allow
src/a.mjs	comments	comment density 0.231 > 0.150 (3/13 lines)
```

## Configuration

`deadwood.json` at the repository root, or a `"deadwood"` key in the root `package.json`. Both present is refused. Every field is optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `include` | `["**"]` | Files both checks consider. |
| `exclude` | `[]` | Files both checks skip. |
| `markdown.allow` | `["**/README.md", "AGENTS.md", "CLAUDE.md"]` | Markdown files allowed. |
| `comments.maxDensity` | `0.15` | Ceiling on comment lines ÷ non-blank lines. |
| `comments.minLines` | `10` | Files with fewer non-blank lines are not measured. |
| `overrides` | `[]` | `{ "files": [globs], "comments": { "maxDensity"?, "minLines"? } \| false }`, applied in order. `false` turns the density check off. |
| `baseline` | `"deadwood.baseline.json"` | Baseline file. |

Globs match the whole repo-relative path: `README.md` is the root file only; `**/README.md` is any.

## Comment lines

A line counts when any part of a `//`, `/* */` or JSDoc comment is on it, trailing comments included. Strings, template literals and regex literals are code.

Never counted:

- the shebang;
- directives: `@ts-check`, `@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`, `biome-ignore`, `eslint-disable`/`enable`, `prettier-ignore`, `istanbul`/`c8`/`v8 ignore`, `@vitest-environment`, `@jest-environment`, `@jsx*`, `#region`, `/// <reference>`;
- JSDoc rows carrying only types (`@param {T} name`, `@returns {T}`, `@type`, `@typedef`, `@template`). A row with a description counts.

## Baseline

Lists markdown paths and each file's density, rounded up to 4 places. Baselined offenders pass; new offenders, or a baselined file whose density grew, fail. A fixed or improved entry is reported on stderr.

## Nx target

Repo-wide, on a root project depending on every project:

```json
{
  "nx": {
    "name": "workspace",
    "implicitDependencies": ["*"],
    "targets": { "deadwood": { "command": "deadwood", "cache": true } }
  }
}
```
