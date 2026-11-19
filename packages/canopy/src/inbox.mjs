// @ts-check
// The Inbox list's model: which items, which filter tags they carry, and the order they are shown in.
// The functions use nothing but each other (no imports, no module state) because page.mjs embeds their source
// in the page with `toString()`; tests call them directly.

/**
 * @typedef {import('./queues.mjs').Item & { kind: 'human' | 'stranded', key: string, at: string | null,
 *   tags: string[], pr?: import('./queues.mjs').Stranded['pr'] }} InboxItem
 *   `at` is the time the list sorts by: last update for `q:human`, the PR's close for a stranded issue.
 *   `tags` are filter ids, `<facet>:<value>`.
 * @typedef {{ id: string, value: string, n: number, on: boolean }} Tag
 * @typedef {{ facet: string, tags: Tag[] }} Facet
 * @typedef {'newest' | 'oldest' | 'priority'} Sort
 */

/**
 * `q:human` items and stranded issues as one list, each with its filter tags. Facets: `kind`, `why`,
 * `priority`, `repo`, and `label` for any other label cambium's vocabulary doesn't already cover.
 *
 * @param {{ columns: { human: import('./queues.mjs').Item[] }, stranded?: import('./queues.mjs').Stranded[] }} gh
 * @returns {InboxItem[]}
 */
export function inboxItems(gh) {
  const own = /^(q:|why:|priority:)|^running$/
  const tagsOf = (/** @type {any} */ i, /** @type {string} */ kind) => [
    `kind:${kind}`,
    ...(i.why ? [`why:${i.why}`] : []),
    ...(i.priority ? [`priority:${i.priority}`] : []),
    `repo:${i.repo}`,
    ...i.labels.filter((/** @type {string} */ l) => !own.test(l)).map((/** @type {string} */ l) => `label:${l}`),
  ]
  return [
    ...gh.columns.human.map((i) => ({
      ...i,
      kind: /** @type {const} */ ('human'),
      key: `${i.repo}#${i.number}`,
      at: i.updatedAt || i.createdAt,
      tags: tagsOf(i, 'human'),
    })),
    ...(gh.stranded || []).map((i) => ({
      ...i,
      kind: /** @type {const} */ ('stranded'),
      key: `${i.repo}#${i.number}`,
      at: i.pr.closedAt || i.updatedAt || i.createdAt,
      tags: tagsOf(i, 'stranded'),
    })),
  ]
}

/** cambium's priorities, most urgent first; anything else sorts after them, and no priority last. */
export function priorityRank(/** @type {string | null | undefined} */ p) {
  const i = ['critical', 'high', 'medium', 'low'].indexOf(p || '')
  return i >= 0 ? i : p ? 4 : 5
}

/**
 * The tags worth offering: those that would narrow the list (a tag every item carries filters nothing), plus
 * any selected tag, kept even at zero matches so it can be cleared. Facets with nothing to offer are left out.
 *
 * @param {InboxItem[]} items
 * @param {Set<string>} selected
 * @returns {Facet[]}
 */
export function facetsOf(items, selected) {
  const order = ['kind', 'why', 'priority', 'repo', 'label']
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const it of items) for (const t of it.tags) counts.set(t, (counts.get(t) || 0) + 1)
  for (const t of selected) if (!counts.has(t)) counts.set(t, 0)
  /** @type {Facet[]} */
  const out = []
  for (const facet of order) {
    const tags = [...counts]
      .filter(([id, n]) => id.startsWith(`${facet}:`) && (selected.has(id) || n < items.length))
      .map(([id, n]) => ({ id, value: id.slice(facet.length + 1), n, on: selected.has(id) }))
    if (facet === 'priority') tags.sort((a, b) => priorityRank(a.value) - priorityRank(b.value))
    else if (facet !== 'kind') tags.sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))
    if (tags.length) out.push({ facet, tags })
  }
  return out
}

/**
 * Filter, then sort. Selected tags in one facet widen (any of them); across facets they narrow (all facets).
 *
 * @param {InboxItem[]} items
 * @param {{ sort: Sort, tags: Set<string> }} view
 * @returns {InboxItem[]}
 */
export function viewOf(items, { sort, tags }) {
  /** @type {Map<string, string[]>} */
  const byFacet = new Map()
  for (const t of tags) {
    const f = t.slice(0, t.indexOf(':'))
    byFacet.set(f, [...(byFacet.get(f) || []), t])
  }
  const kept = items.filter((it) => [...byFacet.values()].every((any) => any.some((t) => it.tags.includes(t))))
  const time = (/** @type {InboxItem} */ it) => (it.at ? Date.parse(it.at) : 0) || 0
  const byTime = (/** @type {InboxItem} */ a, /** @type {InboxItem} */ b) => time(b) - time(a) || b.number - a.number
  return kept.sort(
    sort === 'oldest'
      ? (a, b) => -byTime(a, b)
      : sort === 'priority'
        ? (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || byTime(a, b)
        : byTime,
  )
}
