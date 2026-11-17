// @ts-check
/**
 * Color for the setup commands' output — off unless a person is reading it.
 *
 * On when the stream is a terminal, or FORCE_COLOR asks for it; off for
 * NO_COLOR, TERM=dumb, pipes, agents' shells and tests. Decided here, not by
 * `styleText`'s own check, because that check only exists from Node 22.13 and
 * graft runs on any 22.
 */

import { styleText } from 'node:util'

/**
 * @param {{ isTTY?: boolean }} [stream]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function colorOn(stream = process.stdout, env = process.env) {
  if (env.NO_COLOR) return false
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false'
  return Boolean(stream?.isTTY) && env.TERM !== 'dumb'
}

/** @typedef {ReturnType<typeof palette>} Palette */

/** Styling functions; each is the identity when color is off. */
export function palette(on = colorOn()) {
  /** @param {Parameters<typeof styleText>[0]} fmt */
  const s = (fmt) => (/** @type {unknown} */ t) =>
    on ? styleText(fmt, String(t), { validateStream: false }) : String(t)
  const p = {
    on,
    bold: s('bold'),
    dim: s('dim'),
    code: s('cyan'),
    green: s('green'),
    yellow: s('yellow'),
    red: s('red'),
    heading: s(['bold', 'cyan']),
  }
  return {
    ...p,
    /** `✓ text` — already right, nothing to do. */
    ok: (/** @type {string} */ t) => `${p.green('✓')} ${t}`,
    /** `! text` — needs the reader's attention. */
    warn: (/** @type {string} */ t) => `${p.yellow('!')} ${t}`,
    /** `→ text` — something setup just changed. */
    done: (/** @type {string} */ t) => `  ${p.green('→')} ${t}`,
    /** `· text` — something setup left as it was. */
    skip: (/** @type {string} */ t) => `  ${p.dim(`· ${t}`)}`,
    /** A section title, with a blank line before it. */
    section: (/** @type {string} */ t) => `\n${p.heading(t)}`,
    /** One `lineDiff` line: `+` green, `-` red. */
    diff: (/** @type {string} */ l) => (l.startsWith('+') ? p.green(l) : l.startsWith('-') ? p.red(l) : l),
  }
}
