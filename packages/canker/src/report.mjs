// @ts-check

/**
 * Offenders as an aligned table, worst first.
 * @param {import('./ratchet.mjs').Offender[]} offenders
 */
export function table(offenders) {
  const head = ['location', 'function', 'complexity', 'coverage', 'crap', 'baseline']
  const rows = [...offenders]
    .sort((a, b) => b.crap - a.crap)
    .map((o) => [
      `${o.file}:${o.start.line}`,
      o.id,
      String(o.complexity),
      `${(o.coverage * 100).toFixed(1)}%`,
      o.crap.toFixed(2),
      o.baseline === null ? 'new' : o.baseline.toFixed(2),
    ])
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const numeric = new Set([2, 3, 4, 5])
  const fmt = (r) =>
    r
      .map((c, i) => (numeric.has(i) ? c.padStart(widths[i]) : c.padEnd(widths[i])))
      .join('  ')
      .trimEnd()
  return [fmt(head), fmt(widths.map((w) => '-'.repeat(w))), ...rows.map(fmt)].join('\n')
}
