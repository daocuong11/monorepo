// @ts-check
/**
 * The GitHub seam. The tick sees only {@link GitHub}; the default
 * implementation shells out to `graft` so the App identity, token cache and
 * auth are graft's (set `graft.app` in the config to act as the Clock's own
 * App via `GRAFT_APP`).
 */
import { spawn } from 'node:child_process'
import { parseMarker } from './marker.mjs'
import { Q, QUEUE_LABELS } from './labels.mjs'

/**
 * @typedef {{
 *   number: number, title: string, url: string, state: 'OPEN' | 'CLOSED', createdAt: string, body: string,
 *   labels: string[], stateComment: { id: number, marker: import('./marker.mjs').Marker } | null,
 * }} Issue
 * @typedef {{ name: string, url: string | null, summary: string }} FailingCheck
 * @typedef {{
 *   number: number, url: string, branch: string, state: 'OPEN' | 'MERGED' | 'CLOSED', headSha: string | null,
 *   branchExists: boolean, inMergeQueue: boolean, autoMerge: boolean,
 *   checks: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null, failing: FailingCheck[], closes: number[],
 * }} PullRequest
 * @typedef {{
 *   number: number, url: string, title: string, state: 'OPEN' | 'MERGED' | 'CLOSED', createdAt: string,
 *   head: string, base: string, headSha: string | null, labels: string[], approved: boolean, autoMerge: boolean,
 *   stateComment: { id: number, marker: import('./marker.mjs').Marker } | null,
 * }} PromotionPr
 *   A promotion PR (`from` → `to`, or labelled `q:promote`). Its state comment is a PR (issue) comment, so it
 *   goes through the same marker read/write path as an issue's. `approved`: `reviewDecision` is APPROVED, or
 *   (no decision against it) a latest review approves and none requests changes.
 * @typedef {{
 *   from: string, to: string, aheadBy: number | null, merged: { number: number, title: string }[],
 *   prs: PromotionPr[],
 * }} Release
 *   The repo's promotion state (when its `release` is on): how far `from` is ahead of `to` (null: `to` does not
 *   exist), the PRs merged into `from` since `to` (oldest first, from the last 100 commits ahead), and the
 *   promotion PRs: open ones from `from` to `to` plus any (open, merged or closed) still labelled `q:promote`.
 * @typedef {{ issues: Map<number, Issue>, prs: PullRequest[], release?: Release | null }} Snapshot
 * @typedef {{
 *   read(slug: string): Promise<Snapshot>,
 *   label(slug: string, number: number, change: { add: string[], remove: string[] }): Promise<void>,
 *   writeState(slug: string, number: number, commentId: number | null, body: string): Promise<number>,
 *   close(slug: string, number: number, body: string, opts?: { reason?: 'completed' | 'not_planned' | 'duplicate' }): Promise<void>,
 *   comment(slug: string, number: number, body: string): Promise<void>,
 *   deleteBranch(slug: string, branch: string): Promise<void>,
 *   openPull(slug: string, pr: { head: string, base: string, title: string, body: string }): Promise<{ number: number, url: string }>,
 *   editPull(slug: string, number: number, change: { title: string, body: string }): Promise<void>,
 *   closePull(slug: string, number: number, comment: string): Promise<void>,
 *   mergePull(slug: string, number: number): Promise<void>,
 * }} GitHub
 */

const PR_FIELDS = `number url headRefName state headRefOid isInMergeQueue
  headRef { id }
  autoMergeRequest { enabledAt }
  closingIssuesReferences(first: 5) { nodes { ...I } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes {
    __typename
    ... on CheckRun { name conclusion detailsUrl title summary }
    ... on StatusContext { context state targetUrl description }
  } } } } } }`

/**
 * One query per repo per tick: the queued issues and the agent PRs with their checks; with `$release`, also the
 * promotion PRs and how far `$from` is ahead of `$to` (see {@link Release}).
 */
export const SNAPSHOT_QUERY = `query($owner: String!, $name: String!, $labels: [String!], $release: Boolean!, $from: String!, $to: String!) {
  repository(owner: $owner, name: $name) {
    issues(labels: $labels, states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: ASC }) { nodes { ...I } }
    open: pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
    merged: pullRequests(states: MERGED, first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
    promoteRef: pullRequests(headRefName: $from, baseRefName: $to, states: OPEN, first: 10) @include(if: $release) { nodes { ...P } }
    promoteLabelled: pullRequests(labels: ["${Q.promote}"], first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) @include(if: $release) { nodes { ...P } }
    awaiting: issues(labels: ["${Q.promote}"], states: CLOSED, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) @include(if: $release) { nodes { ...I } }
    toRef: ref(qualifiedName: $to) @include(if: $release) {
      compare(headRef: $from) {
        aheadBy
        commits(last: 100) { nodes { associatedPullRequests(first: 3) { nodes { number title baseRefName state } } } }
      }
    }
  }
}
fragment I on Issue {
  number title url state createdAt body
  labels(first: 30) { nodes { name } }
  comments(first: 100) { nodes { databaseId body author { login } } }
}
fragment P on PullRequest {
  number url title state createdAt headRefName baseRefName headRefOid reviewDecision
  autoMergeRequest { enabledAt }
  latestReviews(first: 20) { nodes { state } }
  labels(first: 30) { nodes { name } }
  comments(first: 100) { nodes { databaseId body author { login } } }
}`

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

/**
 * The first comment holding a marker (from `botLogin` only, when set). Issues and PRs alike.
 * @param {any} n an issue or PR node with `comments` @param {string | null} botLogin
 * @returns {{ id: number, marker: import('./marker.mjs').Marker } | null}
 */
function stateCommentOf(n, botLogin) {
  const comment = (n.comments?.nodes ?? []).find(
    (/** @type {any} */ c) => parseMarker(c.body) && (!botLogin || c.author?.login === botLogin),
  )
  return comment ? { id: comment.databaseId, marker: /** @type {any} */ (parseMarker(comment.body)) } : null
}

/** @param {any} n @returns {string[]} */
const labelsOf = (n) => (n.labels?.nodes ?? []).map((/** @type {any} */ l) => l.name)

/**
 * The `$release` part of the answer → {@link Release}.
 * @param {any} repo @param {{ from: string, to: string }} branches @param {string | null} botLogin
 * @returns {Release}
 */
function normalizeRelease(repo, { from, to }, botLogin) {
  /** @type {Map<number, PromotionPr>} */
  const prs = new Map()
  for (const p of [...(repo.promoteRef?.nodes ?? []), ...(repo.promoteLabelled?.nodes ?? [])]) {
    if (!p || prs.has(p.number)) continue
    const reviews = (p.latestReviews?.nodes ?? []).map((/** @type {any} */ r) => r.state)
    prs.set(p.number, {
      number: p.number,
      url: p.url ?? '',
      title: p.title ?? '',
      state: p.state,
      createdAt: p.createdAt,
      head: p.headRefName,
      base: p.baseRefName,
      headSha: p.headRefOid ?? null,
      labels: labelsOf(p),
      approved:
        p.reviewDecision === 'APPROVED' ||
        (p.reviewDecision !== 'CHANGES_REQUESTED' &&
          reviews.includes('APPROVED') &&
          !reviews.includes('CHANGES_REQUESTED')),
      autoMerge: Boolean(p.autoMergeRequest),
      stateComment: stateCommentOf(p, botLogin),
    })
  }
  const compare = repo.toRef?.compare ?? null
  /** @type {Map<number, { number: number, title: string }>} */
  const merged = new Map()
  for (const c of compare?.commits?.nodes ?? [])
    for (const p of c?.associatedPullRequests?.nodes ?? [])
      if (p.baseRefName === from && p.state === 'MERGED' && !merged.has(p.number))
        merged.set(p.number, { number: p.number, title: p.title ?? '' })
  return {
    from,
    to,
    aheadBy: compare ? (compare.aheadBy ?? 0) : null,
    merged: [...merged.values()],
    prs: [...prs.values()],
  }
}

/**
 * GraphQL `data` → {@link Snapshot}. Only `agent/*` PRs are kept.
 *
 * @param {any} data
 * @param {{ botLogin?: string | null, release?: { from: string, to: string } | null }} [opts]
 *   `botLogin`: when set, only that login's markers count. `release`: the branches the query asked about.
 * @returns {Snapshot}
 */
export function normalize(data, { botLogin = null, release = null } = {}) {
  const repo = (data?.data ?? data)?.repository
  if (!repo) throw new Error('snapshot: no repository in the answer')
  /** @type {Map<number, Issue>} */
  const issues = new Map()
  const addIssue = (/** @type {any} */ n) => {
    if (!issues.has(n.number)) {
      issues.set(n.number, {
        number: n.number,
        title: n.title ?? '',
        url: n.url ?? '',
        state: n.state,
        createdAt: n.createdAt,
        body: n.body ?? '',
        labels: labelsOf(n),
        stateComment: stateCommentOf(n, botLogin),
      })
    }
    return n.number
  }
  for (const n of [...(repo.issues?.nodes ?? []), ...(repo.awaiting?.nodes ?? [])]) addIssue(n)
  /** @type {PullRequest[]} */
  const prs = []
  for (const p of [...(repo.open?.nodes ?? []), ...(repo.merged?.nodes ?? [])]) {
    if (!p?.headRefName?.startsWith('agent/')) continue
    const rollup = p.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null
    const failing = (rollup?.contexts?.nodes ?? [])
      .filter((/** @type {any} */ c) => FAILED.has(c.__typename === 'StatusContext' ? c.state : c.conclusion))
      .map((/** @type {any} */ c) => ({
        name: c.name ?? c.context,
        url: c.detailsUrl ?? c.targetUrl ?? null,
        summary: String(c.title ?? c.description ?? '') + (c.summary ? `\n${String(c.summary).slice(0, 800)}` : ''),
      }))
    prs.push({
      number: p.number,
      url: p.url,
      branch: p.headRefName,
      state: p.state,
      headSha: p.headRefOid ?? null,
      branchExists: Boolean(p.headRef),
      inMergeQueue: Boolean(p.isInMergeQueue),
      autoMerge: Boolean(p.autoMergeRequest),
      checks: rollup?.state ?? null,
      failing,
      closes: (p.closingIssuesReferences?.nodes ?? []).map(addIssue),
    })
  }
  return { issues, prs, ...(release ? { release: normalizeRelease(repo, release, botLogin) } : {}) }
}

/**
 * Run a command, resolve its stdout; reject with its stderr on a non-zero exit.
 *
 * @typedef {(cmd: string, args: string[], opts?: { input?: string, cwd?: string, env?: NodeJS.ProcessEnv }) => Promise<string>} Exec
 * @type {Exec}
 */
export function exec(cmd, args, { input, cwd, env } = {}) {
  return new Promise((resolveOut, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolveOut(out) : reject(new Error(`${cmd} ${args[0]} exited ${code}: ${err.trim() || out.trim()}`)),
    )
    child.stdin.end(input ?? '')
  })
}

/**
 * The default {@link GitHub}: every call is one `graft` invocation.
 *
 * @param {{ config: import('./config.mjs').Config, exec?: Exec }} opts
 * @returns {GitHub}
 */
export function graftGitHub({ config, exec: run = exec }) {
  const env = { ...process.env, ...(config.graft.app ? { GRAFT_APP: config.graft.app } : {}) }
  const cwdOf = (/** @type {string} */ slug) => config.repos.find((r) => r.slug === slug)?.path
  const graft = (/** @type {string} */ slug, /** @type {string[]} */ args, input = undefined) =>
    run(config.graft.command, [...args, '--repo', slug], { input, cwd: cwdOf(slug), env })
  const json = async (/** @type {Promise<string>} */ p) => JSON.parse(await p)

  return {
    async read(slug) {
      const [owner, name] = slug.split('/')
      const r = config.repos.find((x) => x.slug === slug)?.release
      // Read whenever there is a promotion (`from` ≠ `to`), on or off: the `q:promote` issues need the comparison
      // (promotion.mjs); the release graphs check `enabled` themselves.
      const release = r && r.from !== r.to ? { from: r.from, to: r.to } : null
      const branches = release ?? { from: '', to: '' }
      const vars = JSON.stringify({ owner, name, labels: QUEUE_LABELS, release: Boolean(release), ...branches })
      const data = await json(graft(slug, ['graphql', SNAPSHOT_QUERY, '--vars', vars]))
      return normalize(data, { botLogin: config.graft.botLogin, release })
    },
    async label(slug, number, { add, remove }) {
      if (!add.length && !remove.length) return
      await graft(slug, [
        'issue',
        'label',
        String(number),
        ...(add.length ? ['--add', add.join(',')] : []),
        ...(remove.length ? ['--remove', remove.join(',')] : []),
      ])
    },
    async writeState(slug, number, commentId, body) {
      if (commentId) {
        const path = `/repos/${slug}/issues/comments/${commentId}`
        await graft(slug, ['api', 'PATCH', path, '--body', JSON.stringify({ body })])
        return commentId
      }
      const made = await json(graft(slug, ['issue', 'comment', String(number), '--body-file', '-'], body))
      return made.id
    },
    async close(slug, number, body, { reason } = {}) {
      await graft(
        slug,
        ['issue', 'close', String(number), '--body-file', '-', ...(reason ? ['--reason', reason] : [])],
        body,
      )
    },
    async comment(slug, number, body) {
      await graft(slug, ['issue', 'comment', String(number), '--body-file', '-'], body)
    },
    async deleteBranch(slug, branch) {
      await graft(slug, ['api', 'DELETE', `/repos/${slug}/git/refs/heads/${branch}`])
    },
    async openPull(slug, { head, base, title, body }) {
      const path = `/repos/${slug}/pulls`
      const made = await json(graft(slug, ['api', 'POST', path, '--body', JSON.stringify({ head, base, title, body })]))
      return { number: made.number, url: made.html_url }
    },
    async editPull(slug, number, { title, body }) {
      await graft(slug, ['api', 'PATCH', `/repos/${slug}/pulls/${number}`, '--body', JSON.stringify({ title, body })])
    },
    async closePull(slug, number, comment) {
      await graft(slug, ['issue', 'comment', String(number), '--body-file', '-'], comment)
      await graft(slug, ['api', 'PATCH', `/repos/${slug}/pulls/${number}`, '--body', '{"state":"closed"}'])
    },
    // Through graft's merge policy, as an agent's merge would: auto-merge, or a merge now when the PR is clean.
    async mergePull(slug, number) {
      await graft(slug, ['pr', 'merge', String(number), '--auto'])
    },
  }
}
