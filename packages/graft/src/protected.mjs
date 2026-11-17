// @ts-check
/**
 * Which paths an agent may not change without a human.
 *
 * Three tiers, checked in this order:
 *
 *   IMPOSSIBLE   no grant unlocks it, because the App cannot write it at all
 *                (`.github/workflows/**` without the Workflows permission).
 *                Saying so up front stops an agent hunting for a switch.
 *   PROTECTED    CODEOWNERS says a human must approve it, or `.graft.json`
 *                lists it in `protected.extra`, or it is one of the files that
 *                define the protection itself (below). Editing or publishing
 *                it needs a maintainer grant with the `protected` scope, and
 *                the PR still needs the code owner's review on GitHub.
 *   ordinary     everything else. CI is the gate.
 *
 * WHAT THIS IS NOT. An agent has a shell and can write any file on disk. The
 * boundary is CODEOWNERS enforced by a ruleset on GitHub, where the agent
 * cannot reach. What this buys locally is intent: a protected path is never
 * edited by accident, and every deliberate edit is preceded by a grant the
 * human made with a reason and an expiry.
 *
 * SELF-PROTECTION. The files that DEFINE the protection are protected whether
 * or not CODEOWNERS lists them — CODEOWNERS itself, `.graft.json`, and the
 * Claude settings that wire the hooks. A policy an agent could quietly edit is
 * decorative. `graft doctor` warns when CODEOWNERS does not also own them,
 * because locally-protected-but-unowned merges with no review.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODEOWNERS_LOCATIONS, findCodeowners, ownersOf, parseCodeowners, patternToRegExp } from './codeowners.mjs'
import {
  DEFAULTS,
  LEGACY_PACKAGE_KEY,
  LEGACY_PROJECT_FILE,
  PACKAGE_FILE,
  PACKAGE_KEY,
  PROJECT_FILE,
  locateProjectConfig,
  parseProjectConfig,
} from './config.mjs'
import { allows } from './maintainer.mjs'

/** Protected regardless of CODEOWNERS: the files that define the protection. */
export const SELF_PROTECTED = [
  ...CODEOWNERS_LOCATIONS.map((p) => `/${p}`),
  `/${PROJECT_FILE}`,
  `/${LEGACY_PROJECT_FILE}`,
  '/.claude/settings.json',
]

/**
 * Protected by KEY, not by path: the root `package.json` may hold the policy
 * under `graft`, and protecting the whole file would make every dependency
 * bump in a single-package repo a granted act. So a change to that key is
 * protected, wherever the policy currently lives (adding the key creates a
 * policy), and the rest of the file is ordinary unless CODEOWNERS owns it.
 *
 * `check(path)` cannot see contents, so it reports the file with `key` set;
 * a caller that can see before and after passes `keyChanged` to `judge`,
 * which drops the hit when the key did not change. A caller that cannot see
 * contents keeps it: unknown is protected.
 */
export const KEYED = Object.freeze([{ path: PACKAGE_FILE, key: PACKAGE_KEY }])

/** Stable text of a JSON value: object keys sorted, so reordering is not a change. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v) ?? 'undefined'
}

/**
 * Does `key` differ between two texts of a JSON file? Absent text or key is
 * `undefined`. Text that does not parse is a change: what it holds is unknown.
 *
 * @param {string | null | undefined} before
 * @param {string | null | undefined} after
 * @param {string} key
 */
export function keyDiffers(before, after, key) {
  const pick = (text, k) => {
    if (text === null || text === undefined) return { ok: true, v: undefined }
    try {
      const o = JSON.parse(text)
      return { ok: true, v: o && typeof o === 'object' && !Array.isArray(o) ? o[k] : undefined }
    } catch {
      return { ok: false, v: undefined }
    }
  }
  // The policy key covers its old name too: editing `agit` is editing the policy.
  const keys = key === PACKAGE_KEY ? [PACKAGE_KEY, LEGACY_PACKAGE_KEY] : [key]
  return keys.some((k) => {
    const a = pick(before, k)
    const b = pick(after, k)
    return !a.ok || !b.ok || canonical(a.v) !== canonical(b.v)
  })
}

/**
 * `key` set: only a change to that key of the file is protected (see KEYED).
 *
 * @typedef {{ tier: 'impossible' | 'protected', path: string, why: string, owners: string[], key?: string }} Protection
 */

/**
 * A policy over repo-relative paths, from the project config and CODEOWNERS text.
 *
 * `configSource` is where the config was read, for callers that report it.
 *
 * @param {{ config?: import('./config.mjs').ProjectConfig, codeowners?: { path: string | null, text: string }, configSource?: import('./config.mjs').ConfigSource }} input
 */
export function createPolicy({
  config = /** @type {any} */ (DEFAULTS),
  codeowners = { path: null, text: '' },
  configSource = null,
} = {}) {
  const prot = config.protected ?? DEFAULTS.protected
  const rules = prot.codeowners === false ? [] : parseCodeowners(codeowners.text)
  const compile = (list) =>
    (list ?? []).map((pattern) => ({ pattern, re: patternToRegExp(pattern) })).filter((x) => x.re)
  const impossible = compile(prot.impossible)
  const extra = compile(prot.extra)
  const self = compile(SELF_PROTECTED)

  /**
   * @param {string} path repo-relative POSIX path
   * @returns {Protection | null}
   */
  function check(path) {
    const p = normalise(path)
    if (!p) return null
    const imp = impossible.find((x) => x.re?.test(p))
    if (imp)
      return { tier: 'impossible', path: p, why: `matches \`${imp.pattern}\` (protected.impossible)`, owners: [] }
    const owners = ownersOf(rules, p, prot.owners ?? [])
    if (owners.length)
      return { tier: 'protected', path: p, why: `owned by ${owners.join(' ')} in ${codeowners.path}`, owners }
    const ex = extra.find((x) => x.re?.test(p))
    if (ex) return { tier: 'protected', path: p, why: `matches \`${ex.pattern}\` (protected.extra)`, owners: [] }
    const s = self.find((x) => x.re?.test(p))
    if (s) return { tier: 'protected', path: p, why: 'defines the protection itself', owners: [] }
    const k = KEYED.find((x) => x.path === p)
    if (k)
      return {
        tier: 'protected',
        path: p,
        why: `its "${k.key}" key defines the protection itself`,
        owners: [],
        key: k.key,
      }
    return null
  }

  /** Every protected or impossible path in a list, deduplicated, in order. */
  function checkAll(paths) {
    const seen = new Set()
    const out = []
    for (const path of paths ?? []) {
      const hit = check(path)
      if (hit && !seen.has(hit.path)) {
        seen.add(hit.path)
        out.push(hit)
      }
    }
    return out
  }

  return {
    check,
    checkAll,
    config,
    codeowners,
    codeownersPath: codeowners.path,
    configSource,
    unsupported: rules.filter((r) => r.unsupported).map((r) => /** @type {string} */ (r.unsupported)),
  }
}

/** @typedef {ReturnType<typeof createPolicy>} Policy */

/** Repo-relative POSIX form: `./a`, `a/../a` and `a` agree; a path climbing out is `''`. */
export function normalise(path) {
  const out = []
  for (const seg of String(path ?? '')
    .replace(/\\/g, '/')
    .split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (!out.length) return ''
      out.pop()
    } else out.push(seg)
  }
  return out.join('/')
}

// ---------------------------------------------------------------------------
// Where a policy is read from
// ---------------------------------------------------------------------------

/** The files a policy is made of. */
export const POLICY_FILES = [...CODEOWNERS_LOCATIONS, PROJECT_FILE, LEGACY_PROJECT_FILE, PACKAGE_FILE]

/**
 * A reader: a repo-relative path's text at SOME place — a worktree, a git
 * ref, a branch on GitHub — or `null` when it is absent there.
 *
 * @typedef {(path: string) => string | null} Reader
 */

/**
 * The policy as `read` sees it: CODEOWNERS and the config from the same
 * place, never mixed with another source.
 *
 * ONE rule for the config, wherever it is read: absent is the defaults; an
 * `.graft.json` that does not parse is ALSO judged by the defaults — which
 * still honour CODEOWNERS and self-protect, so nothing falls open — and is
 * reported as `configProblem`, so each caller decides whether a policy nobody
 * wrote is fatal (`pr merge` refuses on it) or a note.
 *
 * @param {Reader} read
 */
export function policyFrom(read) {
  let config = parseProjectConfig(null)
  /** @type {string | null} */
  let configProblem = null
  /** @type {import('./config.mjs').ConfigSource} */
  let configSource = null
  const safeRead = (/** @type {string} */ path) => {
    try {
      return read(path)
    } catch {
      return null
    }
  }
  try {
    const found = locateProjectConfig(safeRead)
    configSource = found.source
    config = parseProjectConfig(found.text, found.source ?? PROJECT_FILE)
  } catch (err) {
    configProblem = /** @type {Error} */ (err).message
  }
  return { ...createPolicy({ config, codeowners: findCodeowners(read), configSource }), configProblem }
}

/** The working tree at `root`: what the editor hooks judge, since that is what an edit changes. */
export const readAtRoot = (/** @type {string} */ root) => (/** @type {string} */ path) => {
  const f = join(root, path)
  return existsSync(f) ? readFileSync(f, 'utf8') : null
}

/**
 * A git ref (`origin/<base>`): the policy as GitHub will enforce it, not as
 * the worktree has it — a worktree's copy is exactly what an agent could have
 * edited.
 *
 * @param {(args: string[]) => string} git
 * @param {string} ref
 */
export const readAtRef = (git, ref) => (/** @type {string} */ path) => {
  try {
    return git(['show', `${ref}:${path}`])
  } catch {
    return null
  }
}

/**
 * A reader over an async source — a branch on GitHub, through the contents
 * API — made synchronous by fetching the policy files once, up front.
 *
 * @param {(path: string) => Promise<string | null>} fetchText
 * @returns {Promise<Reader>}
 */
export async function snapshot(fetchText) {
  const texts = new Map()
  for (const p of POLICY_FILES) texts.set(p, await fetchText(p))
  return (path) => texts.get(path) ?? null
}

// ---------------------------------------------------------------------------
// Judging paths
// ---------------------------------------------------------------------------

/**
 * The protection verdict on a set of paths, under one or more policies.
 *
 * A path any policy protects is protected; the first policy to name it gives
 * the reason (callers list the authoritative one — the base's — first).
 * `impossible` is never lifted. `protected` is lifted when `grant` holds
 * `scope`. Rendering is the caller's: an edit, a publish and a merge each say
 * it their own way.
 *
 * `keyChanged(path, key)` answers for key-protected hits (KEYED): `false`
 * drops the hit, anything else keeps it. Without it they are kept.
 *
 * @param {{ paths: string[], policies: Policy[], grant?: import('./maintainer.mjs').GrantView | null, scope?: string, keyChanged?: ((path: string, key: string) => boolean | null) | null }} input
 * @returns {{ impossible: Protection[], protected: Protection[], lifted: boolean, ok: boolean }}
 */
export function judge({ paths, policies, grant = null, scope = 'protected', keyChanged = null }) {
  const hits = new Map()
  for (const path of paths) {
    for (const policy of policies) {
      const h = policy.check(path)
      if (h) {
        if (!hits.has(h.path)) hits.set(h.path, h)
        break
      }
    }
  }
  const all = dropUnchangedKeys([...hits.values()], keyChanged)
  const impossible = all.filter((h) => h.tier === 'impossible')
  const guarded = all.filter((h) => h.tier === 'protected')
  const lifted = guarded.length > 0 && !!grant && allows(grant, scope)
  return { impossible, protected: guarded, lifted, ok: !impossible.length && (!guarded.length || lifted) }
}

/**
 * Key-protected hits whose key did not change, dropped. `changed` returning
 * anything but `false` (or throwing) keeps the hit.
 *
 * @param {Protection[]} hits
 * @param {((path: string, key: string) => boolean | null) | null} changed
 */
export function dropUnchangedKeys(hits, changed) {
  if (!changed) return hits
  return hits.filter((h) => {
    if (!h.key) return true
    try {
      return changed(h.path, h.key) !== false
    } catch {
      return true
    }
  })
}

/**
 * The async form, for callers whose contents come over the network.
 *
 * @param {Protection[]} hits
 * @param {((path: string, key: string) => Promise<boolean | null>) | null | undefined} changed
 */
export async function dropUnchangedKeysAsync(hits, changed) {
  if (!changed) return hits
  const out = []
  for (const h of hits) {
    if (h.key) {
      let c = true
      try {
        c = (await changed(h.path, h.key)) !== false
      } catch {
        c = true
      }
      if (!c) continue
    }
    out.push(h)
  }
  return out
}
