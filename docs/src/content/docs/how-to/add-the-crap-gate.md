---
title: Add the CRAP gate
description: Fail the build when a function is both complex and untested, with canker.
sidebar:
  order: 14
---

canker reads a coverage report, so the tests must write one first.

1. Install it:

   ```sh
   pnpm add -D @oakgreencc/canker
   ```

2. Make the tests write coverage. With Node's test runner:

   ```sh
   mkdir -p coverage && node --test --experimental-test-coverage \
     --test-reporter=spec --test-reporter-destination=stdout \
     --test-reporter=lcov --test-reporter-destination=coverage/lcov.info 'test/*.test.mjs'
   ```

   The reporter does not create the directory. With vitest, run `vitest run --coverage` with `json` among `coverage.reporter`.

3. Add `canker.json` at the project root:

   ```json
   { "maxCrap": 30 }
   ```

4. Run the tests, then:

   ```sh
   npx canker
   ```

   Exit 0 is clean, 1 lists offenders, 2 is a usage or input error.

## Adopt it with existing offenders

```sh
canker --init        # freeze today's offenders in canker-baseline.json
```

Commit the baseline. New offenders, and baselined functions that get worse, still fail. When scores improve, run `canker --update` and commit: it only ever lowers or removes entries.

## Run it in Nx

Give `test` its coverage output and add a cached `crap` target that depends on it, in the project's `package.json`:

```json
"nx": {
  "targets": {
    "test": { "outputs": ["{projectRoot}/coverage"] },
    "crap": {
      "command": "canker",
      "options": { "cwd": "{projectRoot}" },
      "dependsOn": ["test"],
      "cache": true,
      "inputs": ["default", "^production", { "externalDependencies": ["@oakgreencc/canker"] }]
    }
  }
}
```

Then add `crap` to the verify command, e.g. `nx affected -t lint test crap`. To cover every project, define the target once in `nx.json` `targetDefaults` instead.

Config keys and scoring: [canker reference](/reference/canker/). Why: [Quality ratchets](/explanation/quality-ratchets/).
