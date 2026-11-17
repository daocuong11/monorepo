// @ts-check
// What `node --test --experimental-test-coverage --test-reporter=lcov` writes: SF relative to cwd.
export const NODE_LCOV = `TN:
SF:src/m.mjs
FN:1,f
FN:7,g
FNDA:1,f
FNDA:0,g
FNF:2
FNH:1
BRDA:1,0,0,1
BRF:1
BRH:1
DA:1,1
DA:2,1
DA:3,1
DA:4,1
DA:5,0
DA:6,1
DA:7,1
DA:8,0
DA:9,0
LH:6
LF:9
end_of_record
`

// Trimmed vitest/jest coverage-final.json: absolute keys, statements with columns.
export const ISTANBUL = {
  '/repo/pkg/src/m.ts': {
    path: '/repo/pkg/src/m.ts',
    statementMap: {
      0: { start: { line: 2, column: 2 }, end: { line: 4, column: 3 } },
      1: { start: { line: 3, column: 4 }, end: { line: 3, column: 13 } },
      2: { start: { line: 5, column: 2 }, end: { line: 5, column: 10 } },
    },
    s: { 0: 3, 1: 0, 2: 3 },
    fnMap: { 0: { name: 'f', decl: { start: { line: 1, column: 16 } }, loc: { start: { line: 1, column: 0 } } } },
    f: { 0: 3 },
    branchMap: {},
    b: {},
  },
}
