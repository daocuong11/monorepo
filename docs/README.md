# oakgreen docs

The user documentation site, built with [Starlight](https://starlight.astro.build/). Pages live in `src/content/docs/`, one directory per [Diátaxis](https://diataxis.fr/) quadrant: `tutorials/`, `how-to/`, `reference/`, `explanation/`.

```sh
npm install
npm run dev      # http://localhost:4321/
npm run build    # static site in dist/
```

This directory is not a pnpm workspace package, so the monorepo's `pnpm install` and `pnpm verify` leave it alone.

Writing rules: [AGENTS.md](AGENTS.md).
