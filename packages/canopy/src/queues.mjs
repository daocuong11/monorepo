// @ts-check

export const COLUMNS = /** @type {const} */ (['intake', 'task', 'running', 'human', 'promote'])
const QUEUE_LABEL = { intake: 'q:intake', task: 'q:task', human: 'q:human', promote: 'q:promote' }
const RUNNING = 'running'
const LABELS = [...Object.values(QUEUE_LABEL), RUNNING]

/** One query per repo: the queued issues and the open PRs with their check rollup. */
export const QUEUES_QUERY = `query($owner: String!, $name: String!, $labels: [String!]) {
  repository(owner: $owner, name: $name) {
    issues(labels: $labels, states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes { number title url createdAt updatedAt labels(first: 30) { nodes { name } } }
    }
    pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url headRefName isDraft isInMergeQueue updatedAt
        autoMergeRequest { enabledAt }
        closingIssuesReferences(first: 5) { nodes { number } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
    closed: pullRequests(states: CLOSED, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url headRefName closedAt
        closingIssuesReferences(first: 5) {
          nodes { number title url state createdAt updatedAt labels(first: 30) { nodes { name } } }
        }
      }
    }
  }
}`

export const queryVars = (/** @type {string} */ slug) => {
  const [owner, name] = slug.split('/')
  return { owner, name, labels: LABELS }
}

/**
 * @typedef {{ repo: string, number: number, title: string, url: string, createdAt: string | null,
 *   updatedAt: string | null, labels: string[], why: string | null, priority: string | null }} Item
 * @typedef {{ repo: string, number: number, title: string, url: string, branch: string, draft: boolean,
 *   checks: string | null, inMergeQueue: boolean, autoMerge: boolean, closes: number[], updatedAt: string | null }} Pr
 * @typedef {{ intake: Item[], task: Item[], running: Item[], human: Item[], promote: Item[] }} Columns
 * @typedef {Item & { pr: { number: number, title: string, url: string, branch: string, closedAt: string | null } }} Stranded
 *   An open issue with no queue label whose `agent/*` PR was closed unmerged and nothing open replaces it:
 *   it left the Release Queue, and cambium will not pick it up again.
 * @typedef {{ columns: Columns, prs: Pr[], stranded: Stranded[] }} Queues
 */

export const emptyColumns = () => /** @type {Columns} */ ({ intake: [], task: [], running: [], human: [], promote: [] })

/** The column an issue belongs in, by cambium's labels: `running` wins over `q:task`. */
export function columnOf(/** @type {string[]} */ labels) {
  if (labels.includes(RUNNING)) return 'running'
  for (const c of /** @type {const} */ (['human', 'task', 'promote', 'intake']))
    if (labels.includes(QUEUE_LABEL[c])) return c
  return null
}

/**
 * GraphQL answer (`data`, or `{ data }`) → columns and `agent/*` PRs.
 *
 * @param {any} answer
 * @param {string} repo
 * @returns {Queues}
 */
export function group(answer, repo) {
  const r = (answer?.data ?? answer)?.repository
  if (!r) throw new Error(`${repo}: no repository in the GraphQL answer`)
  const columns = emptyColumns()
  for (const n of r.issues?.nodes ?? []) {
    const labels = (n?.labels?.nodes ?? []).map((/** @type {any} */ l) => l.name)
    const col = columnOf(labels)
    if (!col) continue
    columns[col].push({
      repo,
      number: n.number,
      title: n.title ?? '',
      url: n.url ?? `https://github.com/${repo}/issues/${n.number}`,
      createdAt: n.createdAt ?? null,
      updatedAt: n.updatedAt ?? null,
      labels,
      why: labels.find((/** @type {string} */ l) => l.startsWith('why:'))?.slice(4) ?? null,
      priority: labels.find((/** @type {string} */ l) => l.startsWith('priority:'))?.slice(9) ?? null,
    })
  }
  /** @type {Pr[]} */
  const prs = (r.pullRequests?.nodes ?? [])
    .filter((/** @type {any} */ p) => p?.headRefName?.startsWith('agent/'))
    .map((/** @type {any} */ p) => ({
      repo,
      number: p.number,
      title: p.title ?? '',
      url: p.url ?? `https://github.com/${repo}/pull/${p.number}`,
      branch: p.headRefName,
      draft: Boolean(p.isDraft),
      checks: p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
      inMergeQueue: Boolean(p.isInMergeQueue),
      autoMerge: Boolean(p.autoMergeRequest),
      closes: (p.closingIssuesReferences?.nodes ?? []).map((/** @type {any} */ i) => i.number),
      updatedAt: p.updatedAt ?? null,
    }))
  return { columns, prs, stranded: strandedOf(r.closed?.nodes ?? [], prs, repo) }
}

/**
 * Closed unmerged `agent/*` PRs (newest first) → the open, unqueued issues they would have closed,
 * once each, skipping any an open agent PR still closes.
 *
 * @param {any[]} closed
 * @param {Pr[]} open
 * @param {string} repo
 * @returns {Stranded[]}
 */
export function strandedOf(closed, open, repo) {
  const covered = new Set(open.flatMap((p) => p.closes))
  /** @type {Stranded[]} */
  const out = []
  for (const p of closed) {
    if (!p?.headRefName?.startsWith('agent/')) continue
    for (const n of p.closingIssuesReferences?.nodes ?? []) {
      if (!n || n.state !== 'OPEN' || covered.has(n.number)) continue
      const labels = (n.labels?.nodes ?? []).map((/** @type {any} */ l) => l.name)
      if (columnOf(labels)) continue
      covered.add(n.number)
      out.push({
        repo,
        number: n.number,
        title: n.title ?? '',
        url: n.url ?? `https://github.com/${repo}/issues/${n.number}`,
        createdAt: n.createdAt ?? null,
        updatedAt: n.updatedAt ?? null,
        labels,
        why: null,
        priority: labels.find((/** @type {string} */ l) => l.startsWith('priority:'))?.slice(9) ?? null,
        pr: {
          number: p.number,
          title: p.title ?? '',
          url: p.url ?? `https://github.com/${repo}/pull/${p.number}`,
          branch: p.headRefName,
          closedAt: p.closedAt ?? null,
        },
      })
    }
  }
  return out
}

/**
 * @typedef {{ slug: string, ok: boolean, error: string | null, fetchedAt: string | null } & Queues} RepoQueues
 * @typedef {{ repos: { slug: string, ok: boolean, error: string | null, fetchedAt: string | null }[], columns: Columns, prs: Pr[], stranded: Stranded[], fetchedAt: string | null, cached: boolean }} QueueView
 */

/**
 * Merge per-repo results into one set of columns, keeping each repo's status.
 *
 * @param {RepoQueues[]} repos
 * @returns {QueueView}
 */
export function combine(repos, cached = false) {
  const columns = emptyColumns()
  for (const r of repos) for (const c of COLUMNS) columns[c].push(...r.columns[c])
  const times = repos
    .map((r) => r.fetchedAt)
    .filter(Boolean)
    .sort()
  return {
    repos: repos.map(({ slug, ok, error, fetchedAt }) => ({ slug, ok, error, fetchedAt })),
    columns,
    prs: repos.flatMap((r) => r.prs),
    stranded: repos.flatMap((r) => r.stranded ?? []),
    fetchedAt: times[0] ?? null,
    cached,
  }
}
