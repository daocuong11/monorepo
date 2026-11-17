// @ts-check

/**
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  return new RegExp(`^${globSource(glob)}$`)
}

function globSource(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    const segmentStart = i === 0 || glob[i - 1] === '/'
    if (c === '*' && glob[i + 1] === '*' && segmentStart && glob[i + 2] === '/') {
      re += '(?:.*/)?'
      i += 2
    } else if (c === '*' && glob[i + 1] === '*' && segmentStart && i + 2 === glob.length) {
      re += '.*'
      i += 1
    } else if (c === '*') {
      re += '[^/]*'
      while (glob[i + 1] === '*') i++
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '{' && glob.indexOf('}', i) !== -1) {
      const close = glob.indexOf('}', i)
      re += `(?:${glob
        .slice(i + 1, close)
        .split(',')
        .map(globSource)
        .join('|')})`
      i = close
    } else {
      re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&')
    }
  }
  return re
}

/**
 * @param {string[]} globs
 * @returns {(path: string) => boolean}
 */
export function matcher(globs) {
  const res = globs.map(globToRegExp)
  return (path) => res.some((re) => re.test(path))
}
