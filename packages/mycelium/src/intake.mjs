// @ts-check
import { fingerprint } from './envelope.mjs'

export const LABEL = 'q:intake'

const MARKER = /^<!-- mycelium:fingerprint=([0-9a-f]{8,64}) -->/
const TITLE_MAX = 120
const TEXT_MAX = 50_000

/**
 * @typedef {import('./envelope.mjs').Envelope} Envelope
 * @typedef {{ number: number, body?: string | null }} Intent
 * @typedef {{
 *   openIntents: () => Promise<Intent[]>,
 *   createIssue: (issue: { title: string, body: string, labels: string[] }) => Promise<{ number: number, html_url?: string }>,
 *   comment: (number: number, body: string) => Promise<{ html_url?: string }>,
 * }} GithubClient
 * @typedef {{ action: 'create', fingerprint: string, title: string, body: string, labels: string[] }
 *   | { action: 'comment', fingerprint: string, issue: number, body: string }} Action
 */

export const marker = (/** @type {string} */ fp) => `<!-- mycelium:fingerprint=${fp} -->`

/**
 * Only a marker on the body's first line counts: reporter text further down
 * cannot claim another intent's fingerprint.
 *
 * @param {string | null | undefined} body
 */
export function fingerprintOf(body) {
  return MARKER.exec(String(body ?? ''))?.[1] ?? null
}

/** A cell value that cannot break the table, mention anyone, or open HTML. */
const cell = (/** @type {unknown} */ v) => {
  const s = String(v ?? '')
    .replace(/[\s|]+/g, ' ')
    .replace(/`/g, "'")
    .trim()
  return s ? `\`${s}\`` : ''
}

/** Free text inside a fence longer than any backtick run in it, so it renders inert. */
export function fence(/** @type {string} */ text) {
  const clipped = text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}\n[truncated]` : text
  const longest = Math.max(2, ...(clipped.match(/`+/g) ?? []).map((r) => r.length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}text\n${clipped}\n${ticks}`
}

/** @param {Envelope} e */
function rows(e, fp) {
  const fixed = [
    ['source', cell(e.source)],
    ['fingerprint', cell(fp)],
    ['external id', cell(e.externalId)],
    ['author', cell(e.author)],
    ['received', cell(e.receivedAt)],
    ['url', /^https:\/\/[^\s<>|]+$/.test(e.url ?? '') ? `<${e.url}>` : cell(e.url)],
  ]
  const meta = Object.entries(e.meta)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [`meta.${k}`, cell(typeof v === 'object' ? JSON.stringify(v) : v)])
  return [...fixed, ...meta].map(([k, v]) => `| ${k} | ${v} |`).join('\n')
}

export function issueTitle(/** @type {Envelope} */ e) {
  const t = (e.title || e.body || '(no text)').replace(/\s+/g, ' ').trim()
  const head = `[${e.source}] `
  const room = TITLE_MAX - head.length
  return head + (t.length > room ? `${t.slice(0, room - 1)}…` : t)
}

/**
 * @param {Envelope} e
 * @param {string} fp
 */
export function issueBody(e, fp) {
  return [
    marker(fp),
    '## Intake',
    '',
    '| field | value |',
    '|---|---|',
    rows(e, fp),
    '',
    '## Report',
    '',
    fence([e.title, e.body].filter(Boolean).join('\n\n')),
    '',
  ].join('\n')
}

/**
 * @param {Envelope} e
 * @param {string} fp
 */
export function commentBody(e, fp) {
  return [
    `Another report for intake \`${fp}\`.`,
    '',
    '| field | value |',
    '|---|---|',
    rows(e, fp),
    '',
    fence([e.title, e.body].filter(Boolean).join('\n\n')),
    '',
  ].join('\n')
}

/**
 * Dedupe against open intents. Reads open `q:intake` issues once, then keeps
 * the index current as it files, so two envelopes for one fingerprint in a
 * pass make one issue and one comment.
 *
 * @param {GithubClient} github
 */
export function createIntake(github) {
  /** @type {Map<string, number> | null} */
  let index = null
  const load = async () => {
    if (index) return index
    index = new Map()
    for (const i of await github.openIntents()) {
      const fp = fingerprintOf(i.body)
      if (fp && !index.has(fp)) index.set(fp, i.number)
    }
    return index
  }

  /**
   * @param {Envelope} e
   * @returns {Promise<Action>}
   */
  const plan = async (e) => {
    const fp = fingerprint(e)
    const open = (await load()).get(fp)
    if (open !== undefined) return { action: 'comment', fingerprint: fp, issue: open, body: commentBody(e, fp) }
    return { action: 'create', fingerprint: fp, title: issueTitle(e), body: issueBody(e, fp), labels: [LABEL] }
  }

  /**
   * @param {Action} a
   * @returns {Promise<{ issue: number, url: string | null }>}
   */
  const apply = async (a) => {
    if (a.action === 'comment') {
      const res = await github.comment(a.issue, a.body)
      return { issue: a.issue, url: res?.html_url ?? null }
    }
    const res = await github.createIssue({ title: a.title, body: a.body, labels: a.labels })
    ;(await load()).set(a.fingerprint, res.number)
    return { issue: res.number, url: res.html_url ?? null }
  }

  return {
    plan,
    apply,
    /** Dry run: treat a planned create as filed (issue 0) so later plans in the pass comment on it. */
    assume: async (/** @type {string} */ fp) => {
      ;(await load()).set(fp, 0)
    },
    /** Forget the index; the next plan re-reads open intents. */
    reset: () => {
      index = null
    },
  }
}
