// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  bashVerdict,
  grantsItself,
  isGraftState,
  makeLookup,
  verdict,
  writeTargets,
} from '../src/hooks/guard-protected.mjs'
import { createPolicy } from '../src/protected.mjs'

const ROOT = '/repo'
const CODEOWNERS = `
# The gate, the publish tooling, the agent's own constraints.
/ci/            @alice
/tools/publish/ @alice
/infra/lib/     @alice
/.github/       @alice
`
const policy = createPolicy({ codeowners: { path: '.github/CODEOWNERS', text: CODEOWNERS } })

const GRANT = {
  reason: 'test grant',
  scopes: ['protected'],
  grantedAt: '2026-01-01T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
  session: 'sess-a',
  via: 'claude-session',
}
/** @type {Record<string, any>} */
const G = {
  none: { state: 'none' },
  on: { state: 'active', grant: GRANT, session: 'sess-a' },
  expired: { state: 'expired', grant: { ...GRANT, expiresAt: '2020-01-01T00:00:00Z' } },
  theirs: { state: 'mismatch', grants: [GRANT], session: 'sess-b' },
  wrongScope: { state: 'active', grant: { ...GRANT, scopes: ['no-verify'] }, session: 'sess-a' },
}

/** A lookup over the fake checkout at /repo, with a fixed grant. */
const lookupWith = (grant) => (path, cwd) => {
  const abs = resolve(cwd, path)
  if (abs !== ROOT && !abs.startsWith(`${ROOT}/`)) return null
  return { rel: abs.slice(ROOT.length + 1), policy, grant }
}

/** @type {[string, { tool: string, filePath?: string }, boolean, any?][]} */
const fileCases = [
  ['ordinary file, no grant', { tool: 'Edit', filePath: 'src/app.ts' }, false],
  ['protected file, no grant', { tool: 'Edit', filePath: 'ci/run.mjs' }, true],
  ['protected file, active grant', { tool: 'Edit', filePath: 'ci/run.mjs' }, false, G.on],
  ['protected file, expired grant', { tool: 'Write', filePath: 'ci/run.mjs' }, true, G.expired],
  ["protected file, another session's grant", { tool: 'Edit', filePath: 'ci/run.mjs' }, true, G.theirs],
  ['protected file, grant without the protected scope', { tool: 'Edit', filePath: 'ci/run.mjs' }, true, G.wrongScope],
  ['absolute path inside the checkout', { tool: 'Edit', filePath: '/repo/tools/publish/x.mjs' }, true],
  ['relative dressing does not help', { tool: 'Edit', filePath: 'docs/../ci/run.mjs' }, true],
  ['self-protected: .graft.json', { tool: 'Write', filePath: '.graft.json' }, true],
  ['self-protected: .claude/settings.json', { tool: 'Edit', filePath: '.claude/settings.json' }, true],
  ['workflow is denied even WITH a grant', { tool: 'Edit', filePath: '.github/workflows/ci.yml' }, true, G.on],
  ['reads are not writes', { tool: 'Read', filePath: 'ci/run.mjs' }, false],
  ['Bash is bashVerdict’s call', { tool: 'Bash' }, false],
  ['outside any checkout', { tool: 'Write', filePath: '/tmp/scratch.txt' }, false],
  ['the grant file is human-only', { tool: 'Write', filePath: '/repo/.git/graft/maintainer/sess-a.json' }, true, G.on],
  ['the legacy grant file is human-only', { tool: 'Write', filePath: '/repo/.git/graft/maintainer.json' }, true, G.on],
  ['the grant log is human-only', { tool: 'Edit', filePath: '.git/graft/maintainer.log' }, true, G.on],
]
for (const [label, input, deny, grant = G.none] of fileCases) {
  test(`file tool: ${label}`, () => {
    const got = verdict({ ...input, cwd: ROOT, lookup: lookupWith(grant) })
    assert.equal(got !== null, deny, got ?? 'allowed')
  })
}

/** @type {[string, string, boolean, any?][]} */
const bashCases = [
  // MUST NOT FIRE. Reading and running a protected file is the normal thing.
  ['running the gate', 'node ci/run.mjs', false],
  ['reading it', 'cat ci/run.mjs', false],
  ['grepping it', 'grep -n maintainer ci/run.mjs', false],
  ['git log on it', 'git log --oneline ci/run.mjs', false],
  ['diffing it', 'git diff origin/main -- ci/run.mjs', false],
  ['head/tail', 'sed -n "1,40p" ci/run.mjs', false],
  ['listing', 'ls -la ci/', false],
  ['writing an ordinary file', 'echo hi > src/note.txt', false],
  ['redirecting to /tmp', 'node ci/run.mjs > /tmp/ci.log', false],
  ['stderr to /dev/null', 'node ci/run.mjs 2>/dev/null', false],
  ['ordinary sed -i', 'sed -i "" "s/a/b/" src/app.ts', false],
  // `sed -n` is a READ, whatever `-…i` the filename contains.
  ['sed -n on a file with -i in its name', 'sed -n "1,40p" tools/publish/bin/graft-cli.mjs', false],
  ['sed -n on a hook file', 'sed -n 1,40p tools/publish/block-credentials.mjs', false],
  ['sed -n, unquoted range', 'sed -n 1,5p ci/run.mjs', false],
  ['sed -n with a -…i inside the quoted expression', "sed -n 's/--include//p' ci/run.mjs", false],
  ['sed -n on a workflow', 'sed -n 80,100p .github/workflows/deploy-infra.yml', false],
  ['cat on a workflow', 'cat .github/workflows/native-build.yml', false],
  ['sed -e with an unquoted expression, no -i', 'sed -e s/a/b/ tools/publish/x.mjs', false],
  // Quoted text is data.
  ['redirect inside quotes', 'echo "see > ci/run.mjs"', false],
  ['grep for a sed -i', 'grep -n "sed -i" ci/run.mjs', false],
  ['heredoc body naming a protected file', "python3 - <<'EOF'\nopen('ci/run.mjs').read()\nEOF", false],
  ['python read, no mode', 'python3 -c "print(open(\'ci/run.mjs\').read())"', false],
  // The agent may read and give up a grant.
  ['maintainer status', 'graft maintainer status', false],
  ['maintainer revoke', 'graft maintainer revoke', false],
  ['a grant named in quoted text', 'echo "run graft maintainer grant to unlock"', false],

  // MUST FIRE.
  ['redirect overwrite', 'echo x > ci/run.mjs', true],
  ['redirect append', 'echo x >> ci/run.mjs', true],
  ['redirect to a quoted path', 'echo x > "ci/run.mjs"', true],
  ['redirect both streams', 'node x.mjs &> ci/run.mjs', true],
  ['heredoc into a protected file', "cat > ci/run.mjs <<'EOF'\nx\nEOF", true],
  ['sed -i', 'sed -i "" "s/a/b/" tools/publish/x.mjs', true],
  ['sed -i on a quoted path', 'sed -i "" "s/a/b/" "tools/publish/x.mjs"', true],
  ['sed -i, unquoted expression', 'sed -i "" s/a/b/ tools/publish/x.mjs', true],
  ['sed --in-place', 'sed --in-place "s/a/b/" ci/run.mjs', true],
  ['sed -i after a pipe', 'cat /tmp/x | sed -i "" "s/a/b/" ci/run.mjs', true],
  ['perl -i', 'perl -pi -e "s/a/b/" ci/run.mjs', true],
  ['tee', 'echo x | tee ci/run.mjs', true],
  ['tee -a on settings', 'echo x | tee -a .claude/settings.json', true],
  ['cp destination', 'cp /tmp/patched.mjs ci/run.mjs', true],
  ['mv destination', 'mv /tmp/patched.mjs tools/publish/x.mjs', true],
  ['mv source is destroyed', 'mv ci/run.mjs x.bak', true],
  ['git mv source', 'git mv ci/run.mjs ci/old.mjs', true],
  ['rm', 'rm infra/lib/stack.ts', true],
  ['git rm', 'git rm infra/lib/stack.ts', true],
  ['dd of=', 'dd if=/tmp/x of=ci/run.mjs', true],
  ['absolute path', 'sed -i "" "s/a/b/" /repo/ci/run.mjs', true],
  ['chained after an innocent command', 'npm test && echo x > ci/run.mjs', true],
  ['bash -c payload', "bash -c \"sed -i '' 's/a/b/' ci/run.mjs\"", true],
  ['sh -c redirect', "sh -c 'echo x > ci/run.mjs'", true],
  ['shell heredoc body', "bash <<'EOF'\necho x > ci/run.mjs\nEOF", true],
  ['python open for write', "python3 -c \"open('ci/run.mjs','w').write('x')\"", true],
  ['python open, mode kwarg', "python3 -c \"open('ci/run.mjs', mode='a').write('x')\"", true],
  ['python pathlib write', "python3 -c \"from pathlib import Path; Path('ci/run.mjs').write_text('x')\"", true],
  ['node writeFileSync', "node -e \"require('fs').writeFileSync('ci/run.mjs', 'x')\"", true],
  ['writing the grant file', 'echo {} > .git/graft/maintainer.json', true, G.on],
  ['removing the grant log', 'rm .git/graft/maintainer.log', true, G.on],

  // Self-granting is a human's act.
  ['graft maintainer grant', 'graft maintainer grant "need to fix ci" --scope protected', true, G.on],
  ['node …/graft.mjs maintainer grant', 'node ~/src/graft/bin/graft.mjs maintainer grant "x y"', true],
  ['graft -C dir maintainer grant', 'graft -C /repo maintainer grant "x y"', true],
  ['grant in a sh -c payload', 'bash -c \'graft maintainer grant "x y"\'', true],
  ['grant chained after a read', 'graft maintainer status && graft maintainer grant "x y"', true],

  // A grant lets the write through — only this session's, only with the scope.
  ['granted write is allowed', 'echo x > ci/run.mjs', false, G.on],
  ["another session's grant", 'echo x > ci/run.mjs', true, G.theirs],
  ['grant without the scope', 'echo x > ci/run.mjs', true, G.wrongScope],

  // Workflows are refused even with a grant.
  ['workflow write, granted', 'echo x > .github/workflows/ci.yml', true, G.on],
  ['workflow sed -i, granted', "sed -i '' s/a/b/ .github/workflows/x.yml", true, G.on],
]
for (const [label, command, deny, grant = G.none] of bashCases) {
  test(`bash: ${label}`, () => {
    const got = bashVerdict({ command, cwd: ROOT, lookup: lookupWith(grant) })
    assert.equal(got !== null, deny, got ?? 'allowed')
  })
}

test('refusals say why and how to get a grant, naming this session', () => {
  const text = String(verdict({ tool: 'Edit', filePath: 'ci/run.mjs', cwd: ROOT, lookup: lookupWith(G.theirs) }))
  assert.match(text, /owned by @alice in \.github\/CODEOWNERS/)
  assert.match(text, /graft maintainer grant/)
  assert.match(text, /--session sess-b/)
  assert.match(text, /sess-a/)
})

test('a mismatch refusal names every grantee', () => {
  const other = { ...GRANT, session: 'sess-c', scopes: ['merge'], reason: 'merging the release' }
  const lookup = lookupWith({ state: 'mismatch', grants: [GRANT, other], session: 'sess-b' })
  const text = String(verdict({ tool: 'Edit', filePath: 'ci/run.mjs', cwd: ROOT, lookup }))
  assert.match(text, /session sess-a \[protected\] until 2099-01-01T00:00:00Z — "test grant"/)
  assert.match(text, /session sess-c \[merge\] until 2099-01-01T00:00:00Z — "merging the release"/)
  assert.match(text, /--session sess-b/)
})

test('a write resolved against the event cwd', () => {
  assert.notEqual(bashVerdict({ command: 'echo x > run.mjs', cwd: '/repo/ci', lookup: lookupWith(G.none) }), null)
  assert.equal(bashVerdict({ command: 'echo x > run.mjs', cwd: '/repo/src', lookup: lookupWith(G.none) }), null)
})

test('helpers', () => {
  assert.equal(isGraftState('/a/b/.git/graft/maintainer.json'), true)
  assert.equal(isGraftState('.git/graft'), true)
  assert.equal(isGraftState('src/graft/x.mjs'), false)
  assert.equal(grantsItself('graft maintainer'), false)
  assert.deepEqual(writeTargets('echo x > a/b.txt'), ['a/b.txt'])
})

// Real files: a checkout and a linked worktree OUTSIDE it — the worktree is
// judged by its own position, and the grant is read from the shared .git.
test('makeLookup: a linked worktree anywhere is judged by its own checkout, grant from the common dir', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'graft-guard-')))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env, stdio: 'pipe' })
  try {
    const main = join(tmp, 'main')
    mkdirSync(join(main, '.github'), { recursive: true })
    writeFileSync(join(main, '.github/CODEOWNERS'), '/ci/ @alice\n')
    git(tmp, 'init', '-q', '-b', 'main', main)
    git(main, 'add', '.')
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init', '--no-gpg-sign')
    const wt = join(tmp, 'elsewhere', 'wt')
    git(main, 'worktree', 'add', '-q', wt)

    const denied = verdict({ tool: 'Write', filePath: join(wt, 'ci/x.mjs'), cwd: wt, lookup: makeLookup('s1') })
    assert.notEqual(denied, null)
    assert.equal(verdict({ tool: 'Write', filePath: join(wt, 'src/x.mjs'), cwd: wt, lookup: makeLookup('s1') }), null)

    mkdirSync(join(main, '.git/graft/maintainer'), { recursive: true })
    writeFileSync(join(main, '.git/graft/maintainer/s1.json'), JSON.stringify({ ...GRANT, session: 's1' }))
    assert.equal(verdict({ tool: 'Write', filePath: 'ci/x.mjs', cwd: wt, lookup: makeLookup('s1') }), null)
    assert.notEqual(verdict({ tool: 'Write', filePath: 'ci/x.mjs', cwd: wt, lookup: makeLookup('s2') }), null)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// package.json: only the "graft" key is protected
// ---------------------------------------------------------------------------

test('guard: an edit to package.json is judged by its "graft" key', async () => {
  const { verdict, bashVerdict, textAfter } = await import('../src/hooks/guard-protected.mjs')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'graft-pkgkey-')))
  try {
    const file = join(dir, 'package.json')
    const text = JSON.stringify({ name: 'x', version: '1.0.0', graft: { baseBranch: 'develop' } }, null, 2)
    writeFileSync(file, text)
    const lookup = () => ({
      rel: 'package.json',
      policy: createPolicy(),
      grant: /** @type {any} */ ({ state: 'none' }),
    })
    const v = (tool, toolInput) => verdict({ tool, filePath: file, cwd: dir, lookup, toolInput })

    assert.equal(v('Edit', { old_string: '"1.0.0"', new_string: '"1.0.1"' }), null)
    assert.match(String(v('Edit', { old_string: '"develop"', new_string: '"main"' })), /protected/)
    assert.equal(v('Edit', { old_string: 'not there', new_string: 'x' }), null)
    assert.equal(v('Write', { content: text.replace('1.0.0', '2.0.0') }), null)
    assert.match(String(v('Write', { content: JSON.stringify({ name: 'x' }) })), /protected/)
    assert.equal(
      v('MultiEdit', {
        edits: [
          { old_string: '"x"', new_string: '"y"' },
          { old_string: '1.0.0', new_string: '1.1.0' },
        ],
      }),
      null,
    )
    assert.match(
      String(
        v('MultiEdit', {
          edits: [
            { old_string: '"x"', new_string: '"y"' },
            { old_string: 'develop', new_string: 'dev' },
          ],
        }),
      ),
      /protected/,
    )
    // A shell write cannot be told in advance; graft publish judges the built tree.
    assert.equal(bashVerdict({ command: `echo '{}' > ${file}`, cwd: dir, lookup }), null)

    assert.equal(textAfter('Edit', { old_string: 'a', new_string: 'b', replace_all: true }, 'aXa'), 'bXb')
    assert.equal(textAfter('Edit', { old_string: 'a', new_string: '$&' }, 'a'), '$&')
    assert.equal(textAfter('NotebookEdit', {}, 'x'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// A package's own package.json is not the root /package.json
// ---------------------------------------------------------------------------

test('guard: packages/<x>/package.json is not the root package.json, after a `cd` too', () => {
  const owned = createPolicy({ codeowners: { path: '.github/CODEOWNERS', text: '/package.json @alice\n' } })
  const lookup = (/** @type {string} */ path, /** @type {string} */ cwd) => {
    const abs = resolve(cwd, path)
    if (abs !== ROOT && !abs.startsWith(`${ROOT}/`)) return null
    return { rel: abs.slice(ROOT.length + 1), policy: owned, grant: G.none }
  }
  const bash = (/** @type {string} */ command) => bashVerdict({ command, cwd: ROOT, lookup })
  const edit = (/** @type {string} */ filePath) => verdict({ tool: 'Edit', filePath, cwd: ROOT, lookup })

  assert.equal(edit('packages/a/package.json'), null)
  assert.equal(edit('/repo/packages/a/package.json'), null)
  assert.match(String(edit('package.json')), /`package\.json` is protected/)

  assert.equal(bash("sed -i '' 's/1.0.0/1.0.1/' packages/a/package.json"), null)
  assert.equal(bash("cd packages/a && sed -i '' 's/1.0.0/1.0.1/' package.json"), null)
  assert.equal(bash('cd packages; cd a && echo {} > package.json'), null)
  assert.equal(bash('cd /repo/packages/a && echo {} > package.json'), null)
  assert.equal(bash("cd packages/a && python3 -c \"open('package.json','w')\""), null)
  // Still the root's: no cd, a cd back up, a cd that cannot be read, a cd in a pipeline (a subshell).
  assert.notEqual(bash("sed -i '' 's/1.0.0/1.0.1/' package.json"), null)
  assert.notEqual(bash('cd packages/a && cd ../.. && echo {} > package.json'), null)
  assert.notEqual(bash('cd "$PKG" && echo {} > package.json'), null)
  assert.notEqual(bash('cd packages/a | true; echo {} > package.json'), null)
  assert.notEqual(bash('echo {} > package.json; cd packages/a'), null)
})

test('writeTargetsIn: each target with the directory a preceding cd moved to', async () => {
  const { writeTargetsIn } = await import('../src/hooks/guard-protected.mjs')
  assert.deepEqual(writeTargetsIn('echo x > a.txt && cd packages/a && rm b.txt && cd c; echo y > d.txt'), [
    { path: 'a.txt', dir: null },
    { path: 'd.txt', dir: 'packages/a/c' },
    { path: 'b.txt', dir: 'packages/a' },
  ])
})
