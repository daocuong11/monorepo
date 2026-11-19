// @ts-check
export const Q = /** @type {const} */ ({
  intake: 'q:intake',
  task: 'q:task',
  human: 'q:human',
  promote: 'q:promote',
})
export const QUEUE_LABELS = Object.values(Q)
export const RUNNING = 'running'
/**
 * A parked `q:intake` issue triage already looked at, so canopy can tell it from one awaiting triage:
 * `wait:deferred` rests at the dispatch graph's `deferred` node until `deferUntil`; `wait:blocked` has open GitHub
 * `blockedBy` issues. Any queue move drops them unless it names one again.
 */
export const WAIT = /** @type {const} */ ({ deferred: 'wait:deferred', blocked: 'wait:blocked' })
export const WHY = /** @type {const} */ ({
  budget: 'why:budget',
  reject: 'why:reject',
  approve: 'why:approve',
  triage: 'why:triage',
})

/** @param {string[]} labels */
export const queueOf = (labels) => labels.find((l) => l.startsWith('q:')) ?? null

/**
 * @param {string[]} labels @param {string | null} target `null` leaves every queue
 * @param {{ running?: boolean, extra?: string[] }} [opts] @returns {{ add: string[], remove: string[] }}
 */
export function move(labels, target, { running = false, extra = [] } = {}) {
  const want = new Set([...(target ? [target] : []), ...extra, ...(running ? [RUNNING] : [])])
  const leaving = (/** @type {string} */ l) =>
    !want.has(l) &&
    ((l.startsWith('q:') && l !== target) ||
      l === RUNNING ||
      (l.startsWith('why:') && target !== Q.human) ||
      l.startsWith('wait:'))
  return {
    add: [...want].filter((l) => !labels.includes(l)),
    remove: labels.filter(leaving),
  }
}

/** @param {string[]} labels @param {{ add: string[], remove: string[] }} change */
export const apply = (labels, { add, remove }) => [...labels.filter((l) => !remove.includes(l)), ...add]

/** @typedef {{ labels: string[], createdAt: string }} Sortable */
/** @param {string[]} priorityLabels @returns {(a: Sortable, b: Sortable) => number} */
export function byPriorityThenAge(priorityLabels) {
  const rank = (/** @type {string[]} */ labels) => {
    const i = priorityLabels.findIndex((p) => labels.includes(p))
    return i === -1 ? priorityLabels.length : i
  }
  return (a, b) => rank(a.labels) - rank(b.labels) || Date.parse(a.createdAt) - Date.parse(b.createdAt)
}
