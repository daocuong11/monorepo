# Maintaining the docs site

This directory is the user documentation for the oakgreen stack, published with Starlight. **It is written for people.** Agents keep it current; they are not its audience.

## Rules

1. **Humans only.** Never address an agent, describe agent workflow (worktrees, `graft publish` recipes for an agent, prompts, "you are…"), or paste skill text. Agent instructions live in `AGENTS.md`, `CLAUDE.md` and the `skills/` folders.
2. **Short beats complete.** One idea per sentence. No preamble ("This page will…"), no recap, no "Note that", no hedging. If a sentence can go without losing a fact, delete it. A page longer than ~200 lines is probably two pages.
3. **One quadrant per page** ([Diátaxis](https://diataxis.fr/)):
   - `tutorials/`: one guaranteed path for a learner. Steps and visible results, minimal explanation.
   - `how-to/`: a goal for someone who knows what they want. Title "Verb a thing". Conditionals allowed; no teaching.
   - `reference/`: austere facts mirroring the CLI and config. No instructions, no opinions.
   - `explanation/`: why. Design, trade-offs, history. No steps.
   Content of another kind gets moved and linked, not inlined.
4. **The package READMEs are the source of truth** for flags, defaults and behaviour. When code changes a fact here, change the page in the same PR. Do not copy whole README sections; summarise for a reader and link to the README for exhaustive detail.
5. **Style.** British spelling in prose (identifiers stay as they are). Sentence-case headings. No H1 in the body: `title` in frontmatter is the heading. Every page has `title` and a one-line `description`. Internal links are absolute with a trailing slash: `/reference/graft/cli/`. Starlight asides (`:::note`, `:::caution`) only for something a reader would regret missing.
6. **No internal history.** Incident numbers, other repositories' issue links and porting notes belong in package docs, not here.

## Layout

`src/content/docs/<quadrant>/…` becomes the URL. The sidebar is generated per quadrant directory; order with `sidebar: { order: n }` in frontmatter.

## Check

```sh
cd docs && npm install && npm run build   # fails on broken frontmatter; check the output for broken links
```
