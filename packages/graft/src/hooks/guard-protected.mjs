// @ts-check
/**
 * PreToolUse hook — refuse to WRITE a protected path unless a human granted it.
 *
 *   graft hook guard-protected      (matchers: Bash, and Write|Edit|MultiEdit|NotebookEdit)
 *
 * "Protected" is whatever CODEOWNERS says a human must approve (plus
 * `.graft.json`'s `protected.extra`, plus the files that define the protection
 * itself) — see src/protected.mjs. The grant is maintainer mode's `protected`
 * scope — see src/maintainer.mjs.
 *
 * ---------------------------------------------------------------------------
 * WHY, WHEN CODEOWNERS ALREADY GATES THE MERGE.
 *
 * CODEOWNERS catches it at review, which is the right place for enforcement
 * and the wrong place for discovery. An agent that rewrote the CI gate while
 * doing something else has spent the session's effort by then, and the human
 * first learns of it from a diff they did not expect. This hook moves that to
 * the first keystroke: the edit is refused, the agent asks, and the human
 * decides before the work rather than after it.
 *
 * It does not try to be unbypassable. The boundary is CODEOWNERS on GitHub;
 * this is the tripwire in front of it. `graft publish` checks the same policy
 * again, read from the BASE branch, as a second tripwire for writes this hook
 * cannot see.
 *
 * ---------------------------------------------------------------------------
 * THE BASH HALF.
 *
 * A guard wired only to the file tools guards against `Edit` and not against
 * `sed -i`. That is not a hostile-agent problem — it is DRIFT: the tripwire's
 * value is that every deliberate protected edit stays an explicit, granted
 * act. So `writeTargets` matches WRITE SHAPES — redirection, `sed -i`, `tee`,
 * `cp`/`mv`/`install`, `rm`, `dd of=`, in-place `perl`/`ruby`, a scripting
 * one-liner's `open(path, 'w')` — and asks the policy about the paths they
 * name. It does not parse shell; an obfuscated write gets through, as an
 * obfuscated anything does.
 *
 * The cases that must NOT fire matter more. Running, reading, grepping or
 * `git log`-ing a protected file is the most common thing anyone does with
 * one, and a guard that blocks those gets disabled within the hour. In the
 * harness graft was ported from that happened anyway, once: an unanchored
 * `-[A-Za-z]*i` matched inside filenames, so `sed -n 1,40p` was refused on the
 * very files the guard protects. Hence: quoted text is DATA (masked before any
 * shape is matched), and a flag is a TOKEN starting with `-`, never a
 * substring of a filename.
 *
 * ---------------------------------------------------------------------------
 * WHAT ONLY A HUMAN MAY DO, WITH OR WITHOUT A GRANT.
 *
 *   - run `graft maintainer grant` — a grant the agent issues itself is not a
 *     human's decision. The human types it with Claude Code's `!` prefix,
 *     which is not a tool call and never reaches this hook.
 *   - write into `.git/graft/` — the grants and their log live there.
 *   - write an `impossible` path — the App cannot, so no grant can help.
 *
 * WHERE A FILE IS. Each path is resolved against the event's `cwd` and judged
 * by its position in its OWN checkout (the nearest `.git`), so a file in any
 * worktree, wherever the harness put it, is judged correctly. The harness graft
 * was ported from stripped one hard-coded worktree prefix, and the guard was
 * silently off for every session whose worktree lived anywhere else.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { contextForPath } from '../context.mjs'
import { currentSession, grantAdvice } from '../maintainer.mjs'
import { judge, keyDiffers, normalise } from '../protected.mjs'
import { executedCommands, segments, statements, tokens } from './shell-text.mjs'

/** Tools whose `file_path` (or `notebook_path`) input is a write. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit'])

/** Strip one layer of surrounding quotes from a shell token. */
const unquote = (t) => t.replace(/^['"]|['"]$/g, '')

/**
 * Could be a path: not empty, not a flag, not an operator. A bare name —
 * `CODEOWNERS`, `Makefile`, `Dockerfile` — IS a path; a shape filter that
 * wanted a `/` or `.` let `rm CODEOWNERS` through unjudged. Whether it
 * matters is the policy's question, not the tokenizer's.
 */
const pathish = (t) => !!t && !t.startsWith('-') && !/^[|&;<>]+$/.test(t)

/** A token is a FLAG only if it starts with `-`. */
const isFlag = (t) => t.startsWith('-')

/** The in-place flag of `sed`/`perl`/`ruby`: a short cluster with `i`, or GNU's long form. */
const IN_PLACE_FLAG = /^-[A-Za-z]*i|^--in-place\b/

/** The unquoted expression argument of `sed -i 's/…/…/' file` — not a path. */
const SED_EXPRESSION = /^s[/|,#]/

const verb = (words) => new RegExp(`^(?:[\\w./~-]*/)?(?:${words})$`)
const verbIndex = (toks, re) => toks.findIndex((t) => re.test(t.masked))
const EDITOR = verb('sed|perl|ruby')
const MOVER = verb('cp|mv|install')
const REMOVER = verb('rm|unlink|truncate')

/**
 * Paths a command WRITES, as named by well-known write shapes. A path merely
 * mentioned — an argument to `node`, `cat`, `grep`, `git log` — is not
 * returned. Shapes are matched on the MASKED command; the path is read back
 * from the RAW command at the same offset, so a quoted path is still a path.
 *
 * Every command the line executes is scanned — nested `sh -c` payloads to
 * any depth (`executedCommands`) — and each target is listed once.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function writeTargets(command) {
  return [...new Set(writeTargetsIn(command).map((t) => t.path))]
}

/**
 * Like `writeTargets`, each with the directory a preceding `cd <dir>` in the
 * same command moved to (`dir`, as typed: relative to the event's `cwd`, or
 * absolute), or `null` for none. `cd packages/x && sed -i … package.json`
 * writes `packages/x/package.json`, not the root `package.json`. A `cd` whose
 * target cannot be read (`cd`, `cd -`, `cd "$D"`) leaves the paths after it
 * judged from `cwd`, as before. Nested `sh -c` payloads start from `cwd`.
 *
 * @param {string} command
 * @returns {{ path: string, dir: string | null }[]}
 */
export function writeTargetsIn(command) {
  const seen = new Set()
  const out = []
  for (const t of executedCommands(command).flatMap(targetsOf)) {
    const k = `${t.dir ?? ''}\0${t.path}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

/** A `cd` target that can be read as typed: no expansion, not `-`, not `~`. */
const PLAIN_DIR = /^[\w./@+-]+$/

/**
 * Where each statement of ONE command runs, by offset: the `cd <dir>`
 * statements before it, chained. A `cd` inside a pipeline runs in a subshell
 * and moves nothing.
 *
 * @param {{ raw: string, masked: string }} one
 * @returns {(offset: number) => string | null}
 */
function dirsOf({ raw, masked }) {
  /** @type {{ start: number, dir: string | null }[]} */
  const moves = []
  let dir = /** @type {string | null} */ (null)
  for (const st of statements(masked)) {
    const toks = tokens(st, raw)
    if (toks[0]?.masked !== 'cd') continue
    if (segments(st.text).length > 1) continue
    const arg = toks.length === 2 ? unquote(toks[1].raw) : null
    const to = arg && PLAIN_DIR.test(arg) && arg !== '-' ? arg : null
    dir = to === null ? null : isAbsolute(to) || dir === null ? to : `${dir}/${to}`
    moves.push({ start: st.start + st.text.length, dir })
  }
  return (offset) => {
    let at = null
    for (const m of moves) if (m.start <= offset) at = m.dir
    return at
  }
}

/**
 * The write targets of ONE command, nested payloads not included.
 *
 * @param {{ raw: string, masked: string }} one
 * @returns {{ path: string, dir: string | null }[]}
 */
function targetsOf(one) {
  const { raw: command, masked } = one
  const dirAt = dirsOf(one)
  /** @type {{ path: string, dir: string | null }[]} */
  const out = []
  const add = (t, offset) => {
    const p = unquote(t ?? '')
    if (pathish(p)) out.push({ path: p, dir: dirAt(offset) })
  }
  const rawAt = (m, group) => command.slice(m.index + m[0].length - m[group].length, m.index + m[0].length)

  // `> path`, `>> path`, `2> path`, `&> path`.
  for (const m of masked.matchAll(/(?:^|[^0-9<>&])(?:[0-9]|&)?>>?\s*(['"]?[^\s;|&<>()]+['"]?)/g))
    add(rawAt(m, 1), m.index)

  // `dd of=path`
  for (const m of masked.matchAll(/\bdd\b[^\n;|&]*?\bof=(['"]?[^\s;|&]+['"]?)/g)) add(rawAt(m, 1), m.index)

  // `tee path`, `tee -a path`
  for (const m of masked.matchAll(/\btee\b\s+(?:-\S+\s+)*(['"]?[^\s;|&<>()]+['"]?)/g)) add(rawAt(m, 1), m.index)

  for (const seg of segments(masked)) {
    const toks = tokens(seg, command)

    // In-place editors rewrite each file they are handed. The flag must be a
    // FLAG TOKEN after the verb, never a substring of a filename.
    const editor = verbIndex(toks, EDITOR)
    if (editor >= 0) {
      const args = toks.slice(editor + 1)
      if (args.some((t) => isFlag(t.masked) && IN_PLACE_FLAG.test(t.masked))) {
        for (const t of args) if (!isFlag(t.masked) && !SED_EXPRESSION.test(t.masked)) add(t.raw, seg.start)
      }
    }

    // `cp src dst` / `install … dst`: the last path is written. `mv` (and
    // `git mv`) writes BOTH: the source is destroyed.
    const mover = verbIndex(toks, MOVER)
    if (mover >= 0) {
      const args = toks.slice(mover + 1).filter((t) => !isFlag(t.masked))
      if (toks[mover].masked.endsWith('mv')) for (const t of args) add(t.raw, seg.start)
      else if (args.length >= 2) add(args[args.length - 1].raw, seg.start)
    }

    // Removal is a write.
    const remover = verbIndex(toks, REMOVER)
    if (remover >= 0) for (const t of toks.slice(remover + 1)) if (!isFlag(t.masked)) add(t.raw, seg.start)
  }

  // Scripting one-liners that open a file for writing. Scanned RAW — the path
  // is the quoted string. A read (`open(path).read()`) is not matched.
  for (const m of command.matchAll(/\bopen\(\s*(['"])([^'"\n]+)\1\s*,\s*(?:mode\s*=\s*)?['"][wax]/g)) add(m[2], m.index)
  for (const m of command.matchAll(/\bPath\(\s*(['"])([^'"\n]+)\1\s*\)\.write_(?:text|bytes)\(/g)) add(m[2], m.index)
  for (const m of command.matchAll(/\b(?:writeFile|appendFile)(?:Sync)?\(\s*(['"])([^'"\n]+)\1/g)) add(m[2], m.index)

  return out
}

/** `graft` as a command word — bare, by path, or `node …/graft.mjs`. */
const GRAFT_WORD = /^(?:[\w./~-]*\/)?(?:graft|agit)(?:\.mjs)?$/

/** Maintainer subcommands an agent may run: reading and giving up a grant. */
const AGENT_MAINTAINER_OK = new Set(['status', 'revoke', 'help', '--help', '-h'])

/**
 * Does this command run `graft maintainer <something other than status/revoke>`?
 * Masked-quote aware, and nested `sh -c` payloads are scanned to any depth:
 * `echo "graft maintainer grant"` is text, `bash -c "sh -c 'graft maintainer
 * grant x'"` is a grant.
 *
 * @param {string} command
 */
export function grantsItself(command) {
  return executedCommands(command).some(({ raw, masked }) => {
    for (const seg of segments(masked)) {
      const toks = tokens(seg, raw)
      for (let i = 0; i < toks.length; i++) {
        if (!GRAFT_WORD.test(toks[i].masked)) continue
        const rest = toks.slice(i + 1).map((t) => unquote(t.raw))
        // `graft [-C dir] maintainer …` — the subcommand is the word after it.
        const at = rest.indexOf('maintainer')
        if (at < 0 || at > 2) continue
        const sub = rest[at + 1] ?? 'status'
        if (!AGENT_MAINTAINER_OK.has(sub)) return true
      }
    }
    return false
  })
}

/** Inside a clone's `.git/graft/` — the grants and their log. */
const GRAFT_STATE = /(?:^|\/)\.git\/(?:graft|agit)(?:\/|$)/
export const isGraftState = (path) => GRAFT_STATE.test(String(path).replace(/\\/g, '/'))

/**
 * @typedef {{ rel: string, policy: import('../protected.mjs').Policy, grant: import('../maintainer.mjs').GrantView }} Lookup
 * @typedef {(path: string, cwd: string) => Lookup | null} LookupFn
 */

/** The one description of an impossible refusal. */
function impossibleReason(hit, how = '') {
  return (
    `\`${hit.path}\` ${hit.why}${how}.\n\n` +
    'No grant unlocks this: the App does not hold the permission to write it (for\n' +
    '`.github/workflows/**`, the Workflows permission is withheld on purpose), so GitHub\n' +
    'would refuse the publish regardless. Describe the exact patch and hand it to the\n' +
    'human to apply.'
  )
}

const STATE_REASON =
  '`.git/graft/` holds the maintainer grants and their log. Only a human writes there, through\n' +
  '`graft maintainer grant` — a grant an agent writes for itself is not a decision anyone made.'

/**
 * What a file tool would leave in the file, or `null` when it cannot be told.
 * An Edit whose `old_string` is not in the file changes nothing (it fails).
 *
 * @param {string} tool
 * @param {any} input   the tool's `tool_input`
 * @param {string | null} before
 * @returns {string | null}
 */
export function textAfter(tool, input, before) {
  if (tool === 'Write') return typeof input?.content === 'string' ? input.content : null
  const apply = (text, e) => {
    if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') return null
    if (!text.includes(e.old_string)) return text
    return e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string)
  }
  if (before === null) return null
  if (tool === 'Edit') return apply(before, input)
  if (tool === 'MultiEdit' && Array.isArray(input?.edits)) {
    let text = before
    for (const e of input.edits) {
      const next = apply(text, e)
      if (next === null) return null
      text = next
    }
    return text
  }
  return null
}

/**
 * `null` to allow, or a reason to deny, for one written path.
 *
 * `keyChanged` judges a key-protected file (KEYED) by its key. A shell write's
 * result cannot be told in advance, so the Bash half passes one that says
 * "unchanged" and leaves the key to `graft publish`, which judges the tree as
 * built; refusing every `npm pkg set` would teach agents to route around this.
 *
 * @param {{ path: string, cwd: string, lookup: LookupFn, how?: string, keyChanged?: ((abs: string, key: string) => boolean | null) | null }} input
 */
function judgePath({ path, cwd, lookup, how = '', keyChanged = null }) {
  const abs = isAbsolute(path) ? path : resolve(cwd, path)
  if (isGraftState(abs) || isGraftState(path)) return STATE_REASON
  const found = lookup(path, cwd)
  if (!found) return null // outside any checkout: not ours to judge
  const v = judge({
    paths: [found.rel],
    policies: [found.policy],
    grant: found.grant,
    keyChanged: keyChanged ? (_rel, key) => keyChanged(abs, key) : null,
  })
  if (v.impossible.length) return impossibleReason(v.impossible[0], how)
  if (v.ok) return null
  const hit = v.protected[0]
  return (
    `\`${hit.path}\` is protected — ${hit.why}${how}. It decides what the gates catch, what an\n` +
    'agent may do, or what reaches production, so a human decides when it changes.\n\n' +
    'Reading or running it is always fine; writing it is the granted act.\n' +
    `${grantAdvice(found.grant, 'protected')}\n` +
    'The grant lets you write the change, not land it: CODEOWNERS still requires the\n' +
    "owner's review on the PR. Do not route around this with a different shell shape; if\n" +
    'the refusal is wrong — the path is not really written — say so instead.'
  )
}

/**
 * `null` to allow, or a reason to deny, for a file tool.
 *
 * @param {{ tool: string, filePath?: string, cwd: string, lookup: LookupFn, toolInput?: any }} input
 */
export function verdict({ tool, filePath, cwd, lookup, toolInput = null }) {
  if (!WRITE_TOOLS.has(tool) || !filePath) return null
  const keyChanged = (/** @type {string} */ abs, /** @type {string} */ key) => {
    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null
    const after = textAfter(tool, toolInput, before)
    return after === null ? null : keyDiffers(before, after, key)
  }
  return judgePath({ path: filePath, cwd, lookup, keyChanged })
}

/**
 * `null` to allow, or a reason to deny, for a Bash command.
 *
 * @param {{ command?: string, cwd: string, lookup: LookupFn }} input
 */
export function bashVerdict({ command, cwd, lookup }) {
  if (!command) return null
  if (grantsItself(command))
    return (
      'Only a human grants maintainer mode. Ask them to run it — they type it, with the\n' +
      '`!` prefix in Claude Code, which is not a tool call:\n\n' +
      '    ! graft maintainer grant "<why this session needs it>" --scope <scope>\n\n' +
      'Say which scope you need (protected, no-verify, merge) and why.'
    )
  for (const { path, dir } of writeTargetsIn(command)) {
    const at = dir === null ? cwd : resolve(cwd, dir)
    const reason = judgePath({ path, cwd: at, lookup, how: ' (named by a shell write)', keyChanged: () => false })
    if (reason) return reason
  }
  return null
}

/**
 * The real lookup: the Context of the checkout the path sits in, its policy
 * from disk, its grant as `session` sees it. Memoised per checkout for the
 * life of one hook call.
 *
 * @param {string | null | undefined} session
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {LookupFn}
 */
export function makeLookup(session, { env = process.env } = {}) {
  const at = contextForPath({ env })
  const cache = new Map()
  return (path, cwd) => {
    const found = at(path, cwd)
    if (!found) return null
    const { ctx, rel } = found
    let entry = cache.get(ctx)
    if (!entry) {
      // An unreadable .graft.json is judged by the defaults, which still
      // self-protect (see policyFrom).
      const policy = ctx.localPolicy()
      let grant = /** @type {import('../maintainer.mjs').GrantView} */ ({ state: 'none' })
      try {
        grant = ctx.grant(session ?? null)
      } catch {
        // No grant readable is no grant.
      }
      entry = { policy, grant }
      cache.set(ctx, entry)
    }
    return { rel: normalise(rel), ...entry }
  }
}

/** A PreToolUse guard (see hooks/index.mjs): its message denies the call. */
export const event = 'PreToolUse'

/** @param {any} input  @param {{ env: NodeJS.ProcessEnv }} opts */
export function decide(input, { env }) {
  const cwd = input.cwd ?? process.cwd()
  // Judged as the session making THIS tool call.
  const lookup = makeLookup(currentSession(env, input), { env })
  const tool = input.tool_name
  return tool === 'Bash'
    ? bashVerdict({ command: input.tool_input?.command, cwd, lookup })
    : verdict({
        tool,
        filePath: input.tool_input?.file_path ?? input.tool_input?.notebook_path,
        cwd,
        lookup,
        toolInput: input.tool_input,
      })
}
