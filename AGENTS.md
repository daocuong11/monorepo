# Working in this repo

1. **Task:** the GitHub issue you were given. Its acceptance checks are the definition of done.
2. **Verify:** `pnpm verify` (lint + tests, Nx-cached). Green means committable; the pre-commit hook runs the same command.
3. **Push:** `graft publish agent/<topic> "<conventional commit message>" --paths <a,b> --pr "<title>"`. Never `git commit`, `git push`, `git fetch` or `git pull`.
4. **Done:** `graft ci wait agent/<topic>`, then the PR merges through the queue.

Work in a worktree under `.claude/worktrees/<topic>` and remove it when finished.
