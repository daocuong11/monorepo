// @ts-check
// Per-issue cost from cambium's heartbeat (`repos[].cost`), joined onto the GitHub view the page draws: each
// queued or Inbox item gets its `cost`, issues over cambium's `costFlagUsd` become Inbox session candidates, and
// the per-repo daily ledger is summed into one cost-by-phase series.

/**
 * @typedef {{ usd: number, triage: number, task: number, rescue: number, runs: number, flagged: boolean }} ItemCost
 *   What an issue's workers have cost so far, in US dollars, per phase. `flagged`: task spend over `costFlagUsd`
 *   with no merged PR.
 * @typedef {{ day: string, triage: number, task: number, rescue: number, total: number }} CostDay
 * @typedef {import('./queues.mjs').Item & { cost: ItemCost }} CostItem
 */

const DAY = 86_400_000
const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const key = (/** @type {string} */ repo, /** @type {number} */ n) => `${repo}#${n}`

/** @param {any} c a heartbeat issue's `cost` @param {boolean} flagged @returns {ItemCost} */
const itemCost = (c, flagged) => ({
  usd: num(c?.total?.usd),
  triage: num(c?.triage?.usd),
  task: num(c?.task?.usd),
  rescue: num(c?.rescue?.usd),
  runs: num(c?.total?.runs),
  flagged,
})

/**
 * Every issue cambium reports a cost for, by `owner/name#n`.
 * @param {any} data the judged heartbeat's `data`, or null
 * @returns {Map<string, { repo: string, issue: any, cost: ItemCost }>}
 */
export function costIndex(data) {
  const out = new Map()
  for (const r of data?.repos ?? [])
    for (const i of r?.cost?.issues ?? [])
      if (r.slug && Number.isInteger(i?.number))
        out.set(key(r.slug, i.number), { repo: r.slug, issue: i, cost: itemCost(i.cost, i.flagged === true) })
  return out
}

/**
 * The GitHub view with costs: each column item and stranded issue gains `cost` (null when cambium reports none),
 * and `flagged` lists the session candidates that are not already in the Inbox (`q:human` or stranded), as items
 * built from the heartbeat.
 *
 * @template {{ columns: Record<string, any[]>, stranded?: any[] }} G
 * @param {G} github @param {any} data the judged heartbeat's `data`, or null
 * @returns {G & { flagged: CostItem[] }}
 */
export function withCosts(github, data) {
  const idx = costIndex(data)
  const add = (/** @type {any} */ i) => ({ ...i, cost: idx.get(key(i.repo, i.number))?.cost ?? null })
  const columns = Object.fromEntries(Object.entries(github.columns).map(([k, xs]) => [k, (xs ?? []).map(add)]))
  const stranded = (github.stranded ?? []).map(add)
  const inbox = new Set([...(columns.human ?? []), ...stranded].map((i) => key(i.repo, i.number)))
  /** @type {CostItem[]} */
  const flagged = []
  for (const [k, { repo, issue, cost }] of idx) {
    if (!cost.flagged || inbox.has(k)) continue
    const labels = Array.isArray(issue.labels)
      ? issue.labels.filter((/** @type {unknown} */ l) => typeof l === 'string')
      : []
    flagged.push({
      repo,
      number: issue.number,
      title: typeof issue.title === 'string' ? issue.title : '',
      url: typeof issue.url === 'string' ? issue.url : `https://github.com/${repo}/issues/${issue.number}`,
      createdAt: null,
      updatedAt: null,
      labels,
      why: null,
      priority: labels.find((/** @type {string} */ l) => l.startsWith('priority:'))?.slice(9) ?? null,
      cost,
    })
  }
  return { ...github, columns, stranded, flagged }
}

/**
 * The last `days` UTC days (oldest first, today last), each phase's spend summed over every repo. Days with no
 * spend are zeros, so the series has no gaps.
 * @param {any} data the judged heartbeat's `data`, or null @param {number} now @param {number} [days]
 * @returns {CostDay[]}
 */
export function costByDay(data, now, days = 7) {
  /** @type {Map<string, CostDay>} */
  const out = new Map()
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * DAY).toISOString().slice(0, 10)
    out.set(day, { day, triage: 0, task: 0, rescue: 0, total: 0 })
  }
  for (const r of data?.repos ?? [])
    for (const d of r?.cost?.days ?? []) {
      const into = out.get(d?.day)
      if (!into) continue
      for (const p of /** @type {const} */ (['triage', 'task', 'rescue'])) into[p] = round(into[p] + num(d[p]))
      into.total = round(into.triage + into.task + into.rescue)
    }
  return [...out.values()]
}

const round = (/** @type {number} */ n) => Math.round(n * 1e6) / 1e6
