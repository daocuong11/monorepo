// @ts-check
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { QUEUE_LABELS } from './stack.mjs'

/** Where agent skills (mattpocock's `to-tickets`, `triage`, `wayfinder`) look for a repo's label vocabulary. */
export const LABEL_GUIDE_PATH = 'docs/agents/triage-labels.md'
export const DEFAULT_PRIORITY_LABELS = ['priority:critical', 'priority:high', 'priority:medium', 'priority:low']
const MARK = 'q:intake'

/** @param {{ priorityLabels?: string[] }} [opts] @returns {string} */
export function labelGuide({ priorityLabels = DEFAULT_PRIORITY_LABELS } = {}) {
  const rows = QUEUE_LABELS.map((l) => `| \`${l.name}\` | ${l.description} |`).join('\n')
  const priorities = priorityLabels.map((l) => `\`${l}\``).join(', ')
  return `# Issue labels

Written by \`oakgreen setup\`. cambium runs this repo's issues as a queue of labels, and only cambium moves them.

## Filing an issue

- Add \`q:intake\` and no other label from the queue table. cambium's triage reads the issue, then moves it to \`q:task\` or \`q:human\`, parks it, or closes it.
- Put "blocked by #n" in a GitHub blocked-by link, not a label. cambium holds the issue until its blockers close.
- A tracking parent (an epic with sub-issues) gets no \`q:\` label.
- Priority, at most one: ${priorities}.
- Topic labels the repo already has (area, type, platform) are fine. Create no new process labels.

## Queue labels (cambium's; never add or remove them by hand)

| Label | Meaning |
| ----- | ------- |
${rows}

## Skills with their own triage roles

Skills that speak in triage roles (\`needs-triage\`, \`ready-for-agent\`, …) map to this repo as follows. cambium triages, so no agent applies a role label.

| Role | Here |
| ---- | ---- |
| \`needs-triage\` | \`q:intake\` |
| \`needs-info\` | \`q:intake\`; triage moves it to \`q:human\` + \`why:triage\` |
| \`ready-for-agent\` | \`q:intake\`; triage decides, never \`q:task\` by hand |
| \`ready-for-human\` | \`q:intake\` with the reason in the body; triage moves it to \`q:human\` |
| \`wontfix\` | close the issue as not planned, no label |
`
}

const POINTER = `File issues with \`q:intake\` only; cambium triages and moves them. See \`${LABEL_GUIDE_PATH}\`.`

/**
 * The agent instructions file with the pointer to the guide added, or `null` when it already has one.
 * Fits mattpocock's \`## Agent skills\` block: a \`### Triage labels\` sub-block under an existing heading,
 * else a new block at the end.
 *
 * @param {string} text @returns {string | null}
 */
export function withPointer(text) {
  if (text.includes(LABEL_GUIDE_PATH)) return null
  const block = `### Triage labels\n\n${POINTER}\n`
  const heading = /^## Agent skills[^\n]*\n/m.exec(text)
  if (heading) {
    const at = heading.index + heading[0].length
    return `${text.slice(0, at)}\n${block}${text.slice(at)}`
  }
  return `${text.replace(/\n*$/, '\n')}\n## Agent skills\n\n${block}`
}

/** CLAUDE.md wins over AGENTS.md, as the skills that read it pick; null when neither exists. @param {string} root */
export function instructionsFile(root) {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) if (existsSync(join(root, name))) return name
  return null
}

/**
 * Writes the guide if absent and points the instructions file at it. Never rewrites an existing guide.
 *
 * @param {{ root: string, priorityLabels?: string[], dryRun: boolean, print: (line: string) => void }} ctx
 * @returns {{ created: string[], steps: string[] }}
 */
export function writeLabelGuide({ root, priorityLabels, dryRun, print }) {
  const created = []
  const steps = []
  const guide = join(root, LABEL_GUIDE_PATH)
  if (existsSync(guide)) {
    if (readFileSync(guide, 'utf8').includes(MARK)) print(`= label guide ${LABEL_GUIDE_PATH} exists`)
    else {
      print(`! label guide ${LABEL_GUIDE_PATH} exists but does not name ${MARK}; left as is`)
      steps.push(`Replace ${LABEL_GUIDE_PATH} with the oakgreen vocabulary: delete it, then re-run oakgreen setup`)
    }
  } else if (dryRun) print(`+ would write label guide ${LABEL_GUIDE_PATH}`)
  else {
    mkdirSync(dirname(guide), { recursive: true })
    writeFileSync(guide, labelGuide({ priorityLabels }), { flag: 'wx' })
    print(`+ wrote label guide ${LABEL_GUIDE_PATH}`)
    created.push(guide)
  }

  const name = instructionsFile(root)
  if (!name) steps.push(`Point agents at the labels: add a line naming ${LABEL_GUIDE_PATH} to CLAUDE.md or AGENTS.md`)
  else {
    const next = withPointer(readFileSync(join(root, name), 'utf8'))
    if (next == null) print(`= ${name} points at the label guide`)
    else if (dryRun) print(`+ would add a Triage labels pointer to ${name}`)
    else {
      writeFileSync(join(root, name), next)
      print(`+ added a Triage labels pointer to ${name}`)
      created.push(join(root, name))
    }
  }
  if (created.length)
    steps.push(`Commit ${created.map((f) => f.slice(root.length + 1)).join(' and ')} to the repository`)
  return { created, steps }
}
