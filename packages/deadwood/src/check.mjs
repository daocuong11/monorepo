// @ts-check
import { commentDensity, SOURCE_FILE } from './comments.mjs'
import { commentRulesFor } from './config.mjs'
import { matcher } from './glob.mjs'

export const MARKDOWN_FILE = /\.mdx?$/i

/**
 * @typedef {{ path: string, rule: 'markdown' }} MarkdownOffender
 * @typedef {{ path: string, rule: 'comments', density: number, ceiling: number,
 *   commentLines: number, lines: number }} CommentOffender
 * @typedef {MarkdownOffender | CommentOffender} Offender
 */

/**
 * @param {{ files: string[], config: import('./config.mjs').Config, read: (path: string) => string | null }} input
 * @returns {{ checked: number, offenders: Offender[] }}
 */
export function check({ files, config, read }) {
  const included = matcher(config.include)
  const excluded = matcher(config.exclude)
  const allowed = matcher(config.markdown.allow)
  const rulesFor = commentRulesFor(config, matcher)
  /** @type {Offender[]} */
  const offenders = []
  let checked = 0
  for (const path of files) {
    if (!included(path) || excluded(path)) continue
    if (MARKDOWN_FILE.test(path)) {
      checked++
      if (!allowed(path)) offenders.push({ path, rule: 'markdown' })
      continue
    }
    if (!SOURCE_FILE.test(path)) continue
    const rules = rulesFor(path)
    if (!rules) continue
    const text = read(path)
    if (text == null) continue
    checked++
    const { lines, commentLines, density } = commentDensity(text)
    if (lines < rules.minLines || density <= rules.maxDensity) continue
    offenders.push({ path, rule: 'comments', density, ceiling: rules.maxDensity, commentLines, lines })
  }
  return { checked, offenders }
}

/** @param {Offender} o */
export function describe(o) {
  if (o.rule === 'markdown') return 'markdown file outside markdown.allow'
  return `comment density ${o.density.toFixed(3)} > ${o.ceiling.toFixed(3)} (${o.commentLines}/${o.lines} lines)`
}
