# canker

A per-function CRAP gate for JavaScript and TypeScript.

```
CRAP(m) = comp(m)² × (1 − cov(m))³ + comp(m)
```

`comp` is the function's cyclomatic complexity, `cov` the share of its statements (Istanbul) or lines (lcov) that the tests ran. A complex function is fine when it is tested. An untested one is fine when it is simple. canker fails when a function is both complex and untested.

One runtime dependency, `@babel/parser`. Node ≥ 22.

## Use

```sh
npm install -D @oakgreencc/canker
# run your tests with coverage first, then:
canker            # table of offenders, exit 1 if any
canker --json     # the same verdict for machines
```

| exit | meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| 0    | no function over `maxCrap`, and no baselined function above its baseline                      |
| 1    | at least one offender                                                                         |
| 2    | usage or input error: bad flag or config, no coverage file, a source file that does not parse |

```
location     function  complexity  coverage   crap  baseline
-----------  --------  ----------  --------  -----  --------
src/b.mjs:1  branchy            6      0.0%  42.00       new
canker: 1 of 2 functions over CRAP 30
```

## What it measures

**Functions:** declarations, expressions, arrows, object methods, class methods (including getters, setters, `#private`), and arrows assigned to class fields. Files: `.js .mjs .cjs .jsx .ts .mts .cts .tsx`. Overload signatures, abstract members and `declare`d functions have no body and are skipped.

**Complexity:** 1, plus one for each `if`, `?:`, `for`, `for…in`, `for…of`, `while`, `do…while`, `case` (not `default`), `catch`, `&&`, `||`, `??`, `&&=`, `||=` and `??=`. Branches inside a nested function count toward the nested function only.

**Coverage:** canker parses the source and joins coverage to each function by file and location. Each statement (Istanbul) or line (lcov) belongs to the innermost function that contains it. A function with no statements uses its call count. A source file absent from every coverage report counts as 0% covered.

- **Istanbul** `coverage-final.json`, from vitest (`coverage.reporter: ['json']`), jest, nyc or c8.
- **lcov**, from `node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info`, or any other lcov writer. Relative `SF:` paths resolve from the project root.

When several reports cover one file, the first report in `coverage` order wins it.

## Config

Config goes in the consuming project, as `canker.json` or a `canker` key in `package.json`. When both exist, `canker.json` wins. Every key is optional:

```json
{
  "canker": {
    "maxCrap": 30,
    "include": ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    "exclude": [
      "**/node_modules/**",
      "**/coverage/**",
      "**/dist/**",
      "**/build/**",
      "**/test/**",
      "**/tests/**",
      "**/__tests__/**",
      "**/*.{test,spec}.*",
      "**/*.d.ts"
    ],
    "coverage": ["coverage/coverage-final.json", "coverage/lcov.info"],
    "baseline": "canker-baseline.json"
  }
}
```

Globs (`**`, `*`, `?`, `{a,b}`) match paths relative to the project root. Setting `include` or `exclude` replaces that default list. Coverage paths that don't exist are skipped. If none of them exists, canker exits 2.

`-C <dir>` sets the project root. The default is the current directory.

## Ratchet

To adopt canker in a codebase that already has offenders, record them in a baseline:

```sh
canker --init     # writes canker-baseline.json with today's offenders; refuses if it exists
```

```json
{ "src/legacy.ts": { "parseAll": 212.4, "Parser.next": 48 } }
```

Entries are keyed by file and function name, not by line, so an edit above a function does not orphan its entry. Same-named functions in one file get `#2`, `#3` and so on. With a baseline:

- A function over `maxCrap` that is not in the baseline fails.
- A baselined function whose score rose above its entry fails.
- A baselined function at or below its entry passes, and is counted in the summary.

`canker --update` lowers each entry to the function's current score and removes entries for functions that are gone or back under `maxCrap`. It never adds an entry and never raises one. To ratchet, commit the baseline and run `--update` whenever scores improve.

## Nx

Add a `crap` target next to `test`. It depends on `test`, reads the coverage that `test` writes, and caches on the same inputs, so a cache hit on `test` restores the coverage and `crap` replays from cache too.

`test` has to declare the coverage directory as an output so that Nx restores it on a cache hit. In the project's `package.json`:

```json
{
  "scripts": {
    "test": "mkdir -p coverage && node --test --experimental-test-coverage --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=coverage/lcov.info 'test/*.test.mjs'"
  },
  "nx": {
    "targets": {
      "test": {
        "outputs": ["{projectRoot}/coverage"]
      },
      "crap": {
        "command": "canker",
        "options": { "cwd": "{projectRoot}" },
        "dependsOn": ["test"],
        "cache": true,
        "inputs": ["default", "^production", { "externalDependencies": ["@oakgreencc/canker"] }]
      }
    }
  }
}
```

With vitest, use `"test": "vitest run --coverage"`, set `coverage.reporter` to include `json`, and keep the same `outputs`. canker reads `coverage/coverage-final.json`.

To give every project the check, define the target once in `nx.json` `targetDefaults` and add `crap` to the verify command (`nx affected -t lint test crap`):

```json
{
  "targetDefaults": {
    "test": { "cache": true, "inputs": ["default", "^production"], "outputs": ["{projectRoot}/coverage"] },
    "crap": {
      "executor": "nx:run-commands",
      "options": { "command": "canker", "cwd": "{projectRoot}" },
      "dependsOn": ["test"],
      "cache": true,
      "inputs": ["default", "^production", { "externalDependencies": ["@oakgreencc/canker"] }]
    }
  }
}
```
