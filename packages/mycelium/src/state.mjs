// @ts-check
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** @param {Record<string, string | undefined>} env */
export function defaultStatePath(env = process.env) {
  if (env.MYCELIUM_STATE) return env.MYCELIUM_STATE
  const root = env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(root, 'mycelium', 'state.json')
}

/**
 * Per-connector cursors in one JSON file, written atomically after every
 * advance so a crash re-reads at most the envelope in flight.
 *
 * @param {string} path
 */
export function fileState(path) {
  /** @type {{ cursors: Record<string, unknown> }} */
  const data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { cursors: {} }
  data.cursors ??= {}
  return {
    get: (/** @type {string} */ key) => data.cursors[key] ?? null,
    set: (/** @type {string} */ key, /** @type {unknown} */ cursor) => {
      data.cursors[key] = cursor
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
      renameSync(tmp, path)
    },
  }
}

/** In memory: dry runs and tests. */
export function memoryState(/** @type {Record<string, unknown>} */ initial = {}) {
  const cursors = { ...initial }
  return {
    get: (/** @type {string} */ key) => cursors[key] ?? null,
    set: (/** @type {string} */ key, /** @type {unknown} */ cursor) => {
      cursors[key] = cursor
    },
  }
}

/**
 * A timestamp cursor that also remembers the ids seen at exactly that
 * instant, so a restart between two same-second events loses neither.
 *
 * @typedef {{ at: number, ids: string[] }} TimeCursor
 */

/**
 * @param {TimeCursor | null} cursor
 * @param {number} at
 * @param {string} id
 */
export function isNew(cursor, at, id) {
  if (!cursor) return true
  return at > cursor.at || (at === cursor.at && !cursor.ids.includes(id))
}

/**
 * @param {TimeCursor | null} cursor
 * @param {number} at
 * @param {string} id
 * @returns {TimeCursor}
 */
export function advance(cursor, at, id) {
  if (!cursor || at > cursor.at) return { at, ids: [id] }
  if (at === cursor.at && !cursor.ids.includes(id)) return { at, ids: [...cursor.ids, id] }
  return cursor
}

/**
 * Oldest first, each paired with the cursor that holds once it is filed.
 *
 * @param {{ at: number, envelope: import('./envelope.mjs').Envelope }[]} found
 * @param {TimeCursor} from
 */
export function ordered(found, from) {
  found.sort((a, b) => a.at - b.at || a.envelope.externalId.localeCompare(b.envelope.externalId))
  let c = from
  return found.map((f) => {
    c = advance(c, f.at, f.envelope.externalId)
    return { envelope: f.envelope, cursor: c }
  })
}
