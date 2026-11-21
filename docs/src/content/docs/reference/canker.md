---
title: canker
description: canker's CRAP formula, measurement rules, configuration, baseline and exit codes.
sidebar:
  order: 7
---

canker is a per-function CRAP gate for JavaScript and TypeScript. Package: `@oakgreencc/canker`. One runtime dependency, `@babel/parser`. Node ≥ 22.

## Formula

```
CRAP(m) = comp(m)² × (1 − cov(m))³ + comp(m)
```

`comp` is cyclomatic complexity. `cov` is the share of the function's statements (Istanbul) or lines (lcov) the tests ran.

## Commands

| Command | Behaviour |
| --- | --- |
| `canker` | Table of offenders. |
| `canker --json` | The same verdict as JSON. |
| `canker --init` | Writes the baseline from today's offenders. Refused if one exists. |
| `canker --update` | Lowers each baseline entry to its current score; removes entries for functions gone or back under `maxCrap`. Never adds or raises. |
| `-C <dir>` | Project root. Default: current directory. |

| Exit | Meaning |
| --- | --- |
| 0 | No function over `maxCrap`, no baselined function above its entry |
| 1 | At least one offender |
| 2 | Usage or input error: bad flag or config, no coverage file, a source file that does not parse |

```
location     function  complexity  coverage   crap  baseline
-----------  --------  ----------  --------  -----  --------
src/b.mjs:1  branchy            6      0.0%  42.00       new
canker: 1 of 2 functions over CRAP 30
```

## Measurement

| Aspect | Rule |
| --- | --- |
| Functions | Declarations, expressions, arrows, object methods, class methods (getters, setters, `#private`), arrows assigned to class fields. Bodiless signatures skipped. |
| Files | `.js .mjs .cjs .jsx .ts .mts .cts .tsx` |
| Complexity | 1, plus one per `if`, `?:`, `for`, `for…in`, `for…of`, `while`, `do…while`, `case` (not `default`), `catch`, `&&`, `\|\|`, `??`, `&&=`, `\|\|=`, `??=`. Nested functions count separately. |
| Coverage | Each statement or line belongs to the innermost containing function. A function with no statements uses its call count. A file absent from every report is 0% covered. |
| Reports | Istanbul `coverage-final.json` (vitest, jest, nyc, c8) or lcov. Relative `SF:` paths resolve from the project root. The first report in `coverage` order wins a file. |

## Configuration

`canker.json`, or a `"canker"` key in `package.json`. `canker.json` wins if both exist. Every key is optional.

| Key | Default |
| --- | --- |
| `maxCrap` | `30` |
| `include` | `["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"]` |
| `exclude` | `node_modules`, `coverage`, `dist`, `build`, `test`, `tests`, `__tests__` directories; `*.{test,spec}.*`; `*.d.ts` |
| `coverage` | `["coverage/coverage-final.json", "coverage/lcov.info"]` |
| `baseline` | `"canker-baseline.json"` |

Globs (`**`, `*`, `?`, `{a,b}`) match paths relative to the project root. Setting `include` or `exclude` replaces the default list. Missing coverage paths are skipped; if none exists, exit 2.

## Baseline

```json
{ "src/legacy.ts": { "parseAll": 212.4, "Parser.next": 48 } }
```

Keyed by file and function name, not line. Same-named functions in one file get `#2`, `#3`, ….

| Function | Result |
| --- | --- |
| Over `maxCrap`, not in the baseline | fails |
| Baselined, score above its entry | fails |
| Baselined, at or below its entry | passes, counted in the summary |

## Nx target

```json
{
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
}
```

`test` must declare the coverage directory as an output so a cache hit restores it.
