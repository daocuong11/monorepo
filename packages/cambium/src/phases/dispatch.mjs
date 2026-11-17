// @ts-check
/**
 * @typedef {{ repo: string, intake: import('../github.mjs').Issue[], capacity: number, now: number }} DispatchInput
 * @typedef {(input: DispatchInput) => Promise<{ started: number[] }>} Dispatch
 */

/** @type {Dispatch} */
export async function dispatchNotBuilt() {
  return { started: [] }
}

export const DISPATCH_NOT_BUILT = 'dispatch phase is not built yet; q:intake issues wait'
