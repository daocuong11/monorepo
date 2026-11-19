// @ts-check
// page.mjs embeds this function's source in the page with `toString()`, so it uses nothing outside itself.

/**
 * The GitHub-flavoured Markdown that issues and cambium's comments use, built as nodes through `h` (the page's
 * element builder; never `innerHTML`, so nothing in an issue can run or style the page). Covers paragraphs with
 * GitHub's hard line breaks, headings, fenced code, quotes, nested and task lists, tables, `<details>`, rules,
 * and inline code, emphasis, links, bare URLs, `#123` and `owner/name#123` references and `@mentions`.
 * HTML comments (cambium's state marker among them) are dropped, as GitHub does. Images become links: the page
 * loads nothing from elsewhere. Other HTML is shown as text, except a few inline tags whose markup is dropped.
 *
 * @param {string} src
 * @param {(tag: string, attrs?: Record<string, any> | null, ...kids: any[]) => any} h
 * @param {{ repo?: string }} [ctx] the repo bare `#123` references point into
 * @returns {any[]}
 */
export function markdown(src, h, ctx = {}) {
  const FENCE = /^ {0,3}(`{3,}|~{3,})/
  const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
  const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
  const QUOTE = /^ {0,3}> ?/
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+|$)/
  const DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
  const DETAILS = /^\s*<details\b[^>]*>/i
  const INLINE = new RegExp(
    [
      '(?<tick>`+)(?<code>[\\s\\S]*?[^`])\\k<tick>(?!`)',
      '!\\[(?<alt>[^\\]]*)\\]\\((?<src>[^)\\s]+)(?:\\s+"[^"]*")?\\)',
      '\\[(?<text>[^\\]]+)\\]\\((?<href>[^)\\s]+)(?:\\s+"[^"]*")?\\)',
      '<(?<angle>https?://[^\\s>]+)>',
      `(?<url>https?://[^\\s<>]*[^\\s<>.,;:!?'")\\]])`,
      '\\*\\*(?<strong>(?=\\S)[\\s\\S]*?\\S)\\*\\*',
      '(?<!\\w)__(?<strong2>(?=\\S)[\\s\\S]*?\\S)__(?!\\w)',
      '~~(?<del>(?=\\S)[\\s\\S]*?\\S)~~',
      '\\*(?<em>[^\\s*](?:[\\s\\S]*?[^\\s*])?)\\*',
      '(?<!\\w)_(?<em2>[^\\s_](?:[\\s\\S]*?[^\\s_])?)_(?!\\w)',
      '(?<![\\w&/#])(?<rrepo>[\\w.-]+/[\\w.-]+)?#(?<rnum>\\d+)\\b',
      '(?<![\\w`])@(?<user>[A-Za-z0-9][A-Za-z0-9-]{0,38})\\b',
      '\\\\(?<esc>[!-/:-@[-`{-~])',
      '(?<br><br\\s*/?>|\\n)',
      '(?<tag></?(?:b|i|em|strong|sub|sup|kbd|span|p|div|ins|small|code|summary)\\b[^>]*>)',
    ].join('|'),
    'g',
  )
  const safe = (/** @type {string} */ u) => (/^https?:\/\//i.test(u) ? u : null)
  const a = (/** @type {string} */ href, /** @type {any[]} */ ...kids) =>
    h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...kids)

  /** @param {string} text @returns {any[]} */
  function inline(text) {
    /** @type {any[]} */
    const out = []
    let last = 0
    for (const m of text.matchAll(INLINE)) {
      const g = /** @type {Record<string, string | undefined>} */ (m.groups)
      const at = /** @type {number} */ (m.index)
      if (at > last) out.push(text.slice(last, at))
      last = at + m[0].length
      if (g.code != null) out.push(h('code', {}, /^ [\s\S]*\S[\s\S]* $/.test(g.code) ? g.code.slice(1, -1) : g.code))
      else if (g.src != null) {
        const u = safe(g.src)
        out.push(u ? a(u, `image: ${g.alt || 'untitled'}`) : g.alt || '')
      } else if (g.href != null) {
        const u = safe(g.href)
        out.push(u ? a(u, inline(/** @type {string} */ (g.text))) : inline(/** @type {string} */ (g.text)))
      } else if (g.angle != null) out.push(a(g.angle, g.angle))
      else if (g.url != null) out.push(a(g.url, g.url))
      else if (g.strong != null || g.strong2 != null)
        out.push(h('strong', {}, inline(/** @type {string} */ (g.strong ?? g.strong2))))
      else if (g.del != null) out.push(h('del', {}, inline(g.del)))
      else if (g.em != null || g.em2 != null) out.push(h('em', {}, inline(/** @type {string} */ (g.em ?? g.em2))))
      else if (g.rnum != null) {
        const repo = g.rrepo || ctx.repo
        out.push(repo ? a(`https://github.com/${repo}/issues/${g.rnum}`, m[0]) : m[0])
      } else if (g.user != null) out.push(a(`https://github.com/${g.user}`, m[0]))
      else if (g.esc != null) out.push(g.esc)
      else if (g.br != null) out.push(h('br', {}))
    }
    if (last < text.length) out.push(text.slice(last))
    return out
  }

  const indentOf = (/** @type {string} */ l) => /** @type {RegExpMatchArray} */ (l.match(/^\s*/))[0].length
  const startsBlock = (/** @type {string} */ l, /** @type {string | undefined} */ next) =>
    FENCE.test(l) ||
    HEADING.test(l) ||
    HR.test(l) ||
    QUOTE.test(l) ||
    ITEM.test(l) ||
    DETAILS.test(l) ||
    (l.includes('|') && next != null && DELIM.test(next))
  const cells = (/** @type {string} */ row) =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/(?<!\\)\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'))

  /** @param {string[]} lines @param {number} depth @returns {any[]} */
  function blocks(lines, depth) {
    if (depth > 8) return [h('p', {}, lines.join('\n'))]
    /** @type {any[]} */
    const out = []
    let i = 0
    while (i < lines.length) {
      const l = lines[i]
      const fence = FENCE.exec(l)
      const heading = HEADING.exec(l)
      const item = ITEM.exec(l)
      if (!l.trim()) {
        i++
      } else if (fence) {
        const close = new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`)
        const body = []
        for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i])
        i++
        out.push(h('pre', {}, h('code', {}, body.join('\n'))))
      } else if (heading) {
        out.push(h(`h${Math.min(6, heading[1].length + 2)}`, {}, inline(heading[2])))
        i++
      } else if (HR.test(l)) {
        out.push(h('hr', {}))
        i++
      } else if (DETAILS.test(l)) {
        const inner = []
        let open = 0
        for (; i < lines.length; ) {
          const x = lines[i++]
          open += (x.match(/<details\b/gi) || []).length - (x.match(/<\/details>/gi) || []).length
          inner.push(x)
          if (open <= 0) break
        }
        let summary = 'Details'
        const text = inner
          .join('\n')
          .replace(/^\s*<details\b[^>]*>/i, '')
          .replace(/<\/details>\s*$/i, '')
          .replace(/^\s*<summary>([\s\S]*?)<\/summary>/i, (_, s) => {
            summary = s.trim() || summary
            return ''
          })
        out.push(h('details', {}, h('summary', {}, inline(summary)), blocks(text.split('\n'), depth + 1)))
      } else if (l.includes('|') && DELIM.test(lines[i + 1] ?? '')) {
        const head = cells(l)
        const align = cells(lines[i + 1]).map((c) =>
          c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null,
        )
        const style = (/** @type {number} */ k) => (align[k] ? `text-align:${align[k]}` : null)
        const rows = []
        for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(cells(lines[i]))
        out.push(
          h(
            'div',
            { class: 'md-table' },
            h(
              'table',
              {},
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  head.map((c, k) => h('th', { style: style(k) }, inline(c))),
                ),
              ),
              h(
                'tbody',
                {},
                rows.map((r) =>
                  h(
                    'tr',
                    {},
                    head.map((_, k) => h('td', { style: style(k) }, inline(r[k] ?? ''))),
                  ),
                ),
              ),
            ),
          ),
        )
      } else if (QUOTE.test(l)) {
        const inner = []
        while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(QUOTE, ''))
        out.push(h('blockquote', {}, blocks(inner, depth + 1)))
      } else if (item) {
        const base = item[1].length
        const ordered = /\d/.test(item[2])
        /** @type {{ lines: string[], indent: number }[]} */
        const items = []
        while (i < lines.length) {
          const x = lines[i]
          const im = ITEM.exec(x)
          if (im && im[1].length <= base + 1 && !HR.test(x)) {
            if (/\d/.test(im[2]) !== ordered) break
            items.push({ lines: [x.slice(im[0].length)], indent: im[0].length })
            i++
            continue
          }
          const cur = items[items.length - 1]
          if (!x.trim()) {
            let j = i + 1
            while (j < lines.length && !lines[j].trim()) j++
            const next = lines[j]
            const nm = next == null ? null : ITEM.exec(next)
            if (next == null || !((nm && nm[1].length <= base + 1) || indentOf(next) > base + 1)) break
            cur.lines.push('')
            i++
            continue
          }
          if (indentOf(x) <= base && startsBlock(x, lines[i + 1])) break
          cur.lines.push(indentOf(x) >= cur.indent ? x.slice(cur.indent) : x.trimStart())
          i++
        }
        const start = ordered ? Number.parseInt(item[2], 10) : 1
        out.push(
          h(
            ordered ? 'ol' : 'ul',
            { start: start !== 1 ? start : null },
            items.map((it) => {
              const task = /^\[([ xX])\](?:\s+|$)/.exec(it.lines[0])
              if (task) it.lines[0] = it.lines[0].slice(task[0].length)
              return h(
                'li',
                { class: task ? 'task' : null },
                task ? h('input', { type: 'checkbox', disabled: '', checked: task[1] === ' ' ? null : '' }) : null,
                blocks(it.lines, depth + 1),
              )
            }),
          ),
        )
      } else {
        const para = [l.trim()]
        for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1]); i++)
          para.push(lines[i].trim())
        out.push(h('p', {}, inline(para.join('\n'))))
      }
    }
    return out
  }

  const text = String(src ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!-{2}[\s\S]*?-{2}>/g, '') // spelled out: the page's script element must not contain a comment opener
  return blocks(text.split('\n'), 0)
}
