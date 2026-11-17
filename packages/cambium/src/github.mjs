// @ts-check
/**
 * The GitHub seam. The tick sees only {@link GitHub}; the default
 * implementation shells out to `graft` so the App identity, token cache and
 * auth are graft's (set `graft.app` in the config to act as the Clock's own
 * App via `GRAFT_APP`).
 */
import { spawn } from 'node:child_process'
import { parseMarker } from './marker.mjs'
import { QUEUE_LABELS } from './labels.mjs'

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
 * @typedef {{ issues: Map<number, Issue>, prs: PullRequest[] }} Snapshot
 * @typedef {{
 *   read(slug: string): Promise<Snapshot>,
 *   label(slug: string, number: number, change: { add: string[], remove: string[] }): Promise<void>,
 *   writeState(slug: string, number: number, commentId: number | null, body: string): Promise<number>,
 *   close(slug: string, number: number, body: string): Promise<void>,
 *   deleteBranch(slug: string, branch: string): Promise<void>,
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

/** One query per repo per tick: the queued issues and the agent PRs with their checks. */
export const SNAPSHOT_QUERY = `query($owner: String!, $name: String!, $labels: [String!]) {
  repository(owner: $owner, name: $name) {
    issues(labels: $labels, states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: ASC }) { nodes { ...I } }
    open: pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
    merged: pullRequests(states: MERGED, first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
  }
}
fragment I on Issue {
  number title url state createdAt body
  labels(first: 30) { nodes { name } }
  comments(first: 100) { nodes { databaseId body author { login } } }
}`

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

/**
 * GraphQL `data` → {@link Snapshot}. Only `agent/*` PRs are kept.
 *
 * @param {any} data
 * @param {{ botLogin?: string | null }} [opts] when set, only that login's markers count
 * @returns {Snapshot}
 */
export function normalize(data, { botLogin = null } = {}) {
  const repo = (data?.data ?? data)?.repository
  if (!repo) throw new Error('snapshot: no repository in the answer')
  /** @type {Map<number, Issue>} */
  const issues = new Map()
  const addIssue = (/** @type {any} */ n) => {
    if (!issues.has(n.number)) {
      const comment = (n.comments?.nodes ?? []).find(
        (/** @type {any} */ c) => parseMarker(c.body) && (!botLogin || c.author?.login === botLogin),
      )
      issues.set(n.number, {
        number: n.number,
        title: n.title ?? '',
        url: n.url ?? '',
        state: n.state,
        createdAt: n.createdAt,
        body: n.body ?? '',
        labels: (n.labels?.nodes ?? []).map((/** @type {any} */ l) => l.name),
        stateComment: comment
          ? { id: comment.databaseId, marker: /** @type {any} */ (parseMarker(comment.body)) }
          : null,
      })
    }
    return n.number
  }
  for (const n of repo.issues?.nodes ?? []) addIssue(n)
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
  return { issues, prs }
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
      const vars = JSON.stringify({ owner, name, labels: QUEUE_LABELS })
      const data = await json(graft(slug, ['graphql', SNAPSHOT_QUERY, '--vars', vars]))
      return normalize(data, { botLogin: config.graft.botLogin })
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
    async close(slug, number, body) {
      await graft(slug, ['issue', 'close', String(number), '--body-file', '-'], body)
    },
    async deleteBranch(slug, branch) {
      await graft(slug, ['api', 'DELETE', `/repos/${slug}/git/refs/heads/${branch}`])
    },
  }
}
