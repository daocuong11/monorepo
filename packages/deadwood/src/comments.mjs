// @ts-check

export const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i

const EXPRESSION_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'extends',
])

const DIRECTIVE =
  /^(?:@ts-(?:check|nocheck|ignore|expect-error)\b|biome-ignore|eslint-(?:disable|enable)|prettier-ignore|(?:istanbul|c8|v8) ignore|@(?:vitest|jest)-environment\b|@jsx(?:ImportSource|Runtime|Frag)?\b|#(?:region|endregion)\b|<reference\b)/

const TYPE_TAG =
  /@(?:(?:param|arg|argument|property|prop)\s+\[?[\w$.]*(?:=[^\]\s]*)?\]?|(?:typedef|callback)(?:\s+[\w$.]+)?|template(?:\s+[\w$]+(?:\s*,\s*[\w$]+)*)?|(?:returns?|type|satisfies|enum|this|extends|augments|implements|override|private|protected|public|readonly)\b)/g

const IDENT = /[\w$\u0080-￿]/

/**
 * @param {string} text
 * @returns {{ start: number, end: number, text: string, directive: boolean }[]}
 */
export function scanComments(text) {
  const comments = []
  const n = text.length
  const templateDepths = []
  let i = 0
  let depth = 0
  let inTemplate = false
  let prev = 'op'

  if (text.startsWith('#!')) i = endOfLine(text, 0)

  const comment = (start, end, body, block) => {
    const stripped = body.replace(/^[\s/*!]+/, '').trimEnd()
    const directive = DIRECTIVE.test(stripped)
    comments.push({ start, end, text: body, directive, typeLines: block && !directive ? typeOnlyRows(body) : [] })
  }

  while (i < n) {
    const c = text[i]
    if (inTemplate) {
      if (c === '\\') i += 2
      else if (c === '`') {
        inTemplate = false
        prev = 'value'
        i++
      } else if (c === '$' && text[i + 1] === '{') {
        templateDepths.push(depth++)
        inTemplate = false
        prev = 'op'
        i += 2
      } else i++
      continue
    }
    if (/\s/.test(c)) {
      i++
    } else if (c === '/' && text[i + 1] === '/') {
      const end = endOfLine(text, i)
      comment(i, end, text.slice(i + 2, end), false)
      i = end
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      comment(i, end, text.slice(i + 2, close === -1 ? n : close), true)
      i = end
    } else if (c === '/' && prev === 'op') {
      i = skipRegex(text, i)
      prev = 'value'
    } else if (c === '"' || c === "'") {
      i = skipString(text, i, c)
      prev = 'value'
    } else if (c === '`') {
      inTemplate = true
      i++
    } else if (c === '{') {
      depth++
      prev = 'op'
      i++
    } else if (c === '}') {
      depth--
      if (templateDepths.length && templateDepths.at(-1) === depth) {
        templateDepths.pop()
        inTemplate = true
      } else prev = 'value'
      i++
    } else if (IDENT.test(c)) {
      let j = i + 1
      while (j < n && (IDENT.test(text[j]) || (/\d/.test(c) && text[j] === '.'))) j++
      prev = EXPRESSION_KEYWORDS.has(text.slice(i, j)) ? 'op' : 'value'
      i = j
    } else if ((c === '+' || c === '-') && text[i + 1] === c && prev === 'value') {
      i += 2
    } else {
      prev = c === ')' || c === ']' ? 'value' : 'op'
      i++
    }
  }
  return comments
}

/**
 * @param {string} text
 * @returns {{ lines: number, commentLines: number, density: number }}
 */
export function commentDensity(text) {
  const rows = text.split('\n')
  const lineStarts = [0]
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') lineStarts.push(k + 1)
  const lineOf = (pos) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const nonBlank = (row) => /\S/.test(rows[row])
  const marked = new Set()
  for (const c of scanComments(text)) {
    if (c.directive) continue
    const first = lineOf(c.start)
    const last = lineOf(Math.max(c.start, c.end - 1))
    if (c.typeLines.length && c.typeLines.length + delimiterRows(c.text) >= last - first + 1) continue
    for (let row = first; row <= last; row++) {
      if (nonBlank(row) && !c.typeLines.includes(row - first)) marked.add(row)
    }
  }
  const lines = rows.filter((row) => /\S/.test(row)).length
  return { lines, commentLines: marked.size, density: lines ? marked.size / lines : 0 }
}

/**
 * @param {string} body
 * @returns {number[]}
 */
function typeOnlyRows(body) {
  if (!body.startsWith('*')) return []
  let depth = 0
  let masked = ''
  for (const ch of body) {
    if (ch === '{') depth++
    masked += depth > 0 && ch !== '\n' ? ' ' : ch
    if (ch === '}' && depth > 0) depth--
  }
  const original = body.split('\n')
  return masked.split('\n').flatMap((row, k) => {
    const closesType = row !== original[k]
    const typed = closesType || TYPE_TAG.test(row)
    TYPE_TAG.lastIndex = 0
    const rest = row.replace(TYPE_TAG, '').replace(/[*/-]/g, '').trim()
    return typed && (rest === '' || (closesType && /^[\w$.]+$/.test(rest))) ? [k] : []
  })
}

function delimiterRows(body) {
  return body.split('\n').filter((row) => row.replace(/[\s*/]/g, '') === '').length
}

function endOfLine(text, i) {
  const end = text.indexOf('\n', i)
  return end === -1 ? text.length : end
}

function skipString(text, i, quote) {
  let j = i + 1
  while (j < text.length) {
    const c = text[j]
    if (c === '\\') j += 2
    else if (c === quote) return j + 1
    else if (c === '\n') return j
    else j++
  }
  return text.length
}

function skipRegex(text, i) {
  let j = i + 1
  let inClass = false
  while (j < text.length) {
    const c = text[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '\n') return j
    if (inClass) {
      if (c === ']') inClass = false
    } else if (c === '[') inClass = true
    else if (c === '/') {
      j++
      break
    }
    j++
  }
  while (j < text.length && /[a-z]/i.test(text[j])) j++
  return j
}
