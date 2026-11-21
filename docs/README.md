# oakgreen docs

The user documentation site, built with [Starlight](https://starlight.astro.build/). Pages live in `src/content/docs/`, one directory per [Diátaxis](https://diataxis.fr/) quadrant: `tutorials/`, `how-to/`, `reference/`, `explanation/`.

```sh
npm ci
npm run dev      # http://localhost:4321/
npm run build    # static site in dist/
```

Pushes to `main` that touch `docs/` deploy the site to <https://docs.oakgreen.cc/> through GitHub Pages (`.github/workflows/docs.yml`). `public/CNAME` holds the custom domain.

This directory is not a pnpm workspace package, so the monorepo's `pnpm install` and `pnpm verify` leave it alone.

Look and feel follow the oakgreen.cc brand: tokens and Starlight overrides in `src/styles/oakgreen.css`, component overrides in `src/components/` (site title, home hero, a dark-first theme picker). `DESIGN.md` records the system; `PRODUCT.md` the audience and brand commitments.

Writing rules: [AGENTS.md](AGENTS.md).
