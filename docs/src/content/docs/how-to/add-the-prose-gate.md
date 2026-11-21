---
title: Add the prose gate
description: Limit stray Markdown files and comment-heavy source files with deadwood.
sidebar:
  order: 15
---

1. Install it:

   ```sh
   pnpm add -D @oakgreencc/deadwood
   ```

2. Add `deadwood.json` at the repository root. `{}` uses the defaults; to allow more Markdown, list it:

   ```json
   {
     "markdown": { "allow": ["**/README.md", "AGENTS.md", "CLAUDE.md", "docs/**"] }
   }
   ```

   Setting `allow` replaces the default list, so keep the defaults you want.

3. Run it:

   ```sh
   npx deadwood
   ```

   Exit 0 is clean, 1 lists offenders, 2 is a usage or config error.

## Adopt it with existing offenders

```sh
deadwood --init      # freeze today's offenders in deadwood.baseline.json
```

Commit the baseline and own it in CODEOWNERS, so growing it takes a person. When offenders are fixed, run `deadwood --update`: it only shrinks the baseline.

## Exempt some files from the comment check

```json
{
  "overrides": [{ "files": ["scripts/**"], "comments": false }]
}
```

Or give them their own ceiling: `"comments": { "maxDensity": 0.3 }`.

## Run it in Nx

deadwood checks the whole repository, so run it from a root project that depends on every project. In the root `package.json`:

```json
"nx": {
  "name": "workspace",
  "implicitDependencies": ["*"],
  "targets": { "deadwood": { "command": "deadwood", "cache": true } }
}
```

Then add `deadwood` to the verify command, e.g. `nx run-many -t lint test deadwood`.

Every key: [deadwood reference](/reference/deadwood/). Why: [Quality ratchets](/explanation/quality-ratchets/).
