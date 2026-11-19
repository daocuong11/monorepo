// @ts-check

/**
 * One issue, for the Inbox reading pane: its body and its thread. The thread is read from both ends because
 * cambium's state comment is posted early and then edited in place, while the discussion that matters is the
 * newest: the first 50 comments find the former, the last 20 the latter.
 */
export const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number title url state body createdAt updatedAt
      author { login }
      labels(first: 30) { nodes { name } }
      head: comments(first: 50) { totalCount nodes { ...c } }
      tail: comments(last: 20) { nodes { ...c } }
    }
  }
}
fragment c on IssueComment { url body createdAt updatedAt author { login } }`

/** cambium's state comment carries this hidden marker; GitHub (and the pane) render only the text around it. */
const STATE_MARKER = '<!-- cambium:state '

/** Comments shown below the body; older ones are left to GitHub. */
export const RECENT_COMMENTS = 10

/**
 * @typedef {{ author: string | null, body: string, createdAt: string | null, updatedAt: string | null, url: string }} Comment
 * @typedef {{ repo: string, number: number, title: string, url: string, state: string, author: string | null,
 *   body: string, createdAt: string | null, updatedAt: string | null, labels: string[],
 *   status: Comment | null, comments: Comment[], earlier: number }} IssueDetail
 *   `status` is cambium's state comment, `comments` the newest others (oldest first), `earlier` how many
 *   others are not included.
 */

export const issueVars = (/** @type {string} */ slug, /** @type {number} */ number) => {
  const [owner, name] = slug.split('/')
  return { owner, name, number }
}

/** @returns {Comment} */
const comment = (/** @type {any} */ c) => ({
  author: c.author?.login ?? null,
  body: c.body ?? '',
  createdAt: c.createdAt ?? null,
  updatedAt: c.updatedAt ?? null,
  url: c.url ?? '',
})

/**
 * GraphQL answer (`data`, or `{ data }`) → the issue, or `null` when GitHub has no such issue.
 *
 * @param {any} answer
 * @param {string} repo
 * @param {number} number
 * @returns {IssueDetail | null}
 */
export function issueDetail(answer, repo, number) {
  const r = (answer?.data ?? answer)?.repository
  if (!r) throw new Error(`${repo}: no repository in the GraphQL answer`)
  const i = r.issue
  if (!i) return null
  const seen = new Set()
  /** @type {Comment[]} */
  const thread = []
  for (const c of [...(i.head?.nodes ?? []), ...(i.tail?.nodes ?? [])]) {
    if (!c || seen.has(c.url)) continue
    seen.add(c.url)
    thread.push(comment(c))
  }
  const status = thread.find((c) => c.body.includes(STATE_MARKER)) ?? null
  const others = thread.filter((c) => c !== status)
  const total = Math.max(i.head?.totalCount ?? thread.length, thread.length) - (status ? 1 : 0)
  const comments = others.slice(-RECENT_COMMENTS)
  return {
    repo,
    number: i.number ?? number,
    title: i.title ?? '',
    url: i.url ?? `https://github.com/${repo}/issues/${number}`,
    state: i.state ?? 'OPEN',
    author: i.author?.login ?? null,
    body: i.body ?? '',
    createdAt: i.createdAt ?? null,
    updatedAt: i.updatedAt ?? null,
    labels: (i.labels?.nodes ?? []).map((/** @type {any} */ l) => l.name),
    status,
    comments,
    earlier: Math.max(0, total - comments.length),
  }
}
