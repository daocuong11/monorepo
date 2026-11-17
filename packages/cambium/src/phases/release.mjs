// @ts-check
/** @typedef {(input: { repo: import('../config.mjs').Repo, now: number }) => Promise<{ done: boolean, note: string }>} Release */

/** @param {number} now @param {number | null} lastRun @param {string} time host-local HH:MM */
export function releaseDue(now, lastRun, time) {
  const [h, m] = time.split(':').map(Number)
  const slot = new Date(now)
  slot.setHours(h, m, 0, 0)
  return now >= slot.getTime() && (lastRun === null || lastRun < slot.getTime())
}

/** @type {Release} */
export async function releaseNotBuilt() {
  return { done: false, note: 'release phase is not built yet' }
}
