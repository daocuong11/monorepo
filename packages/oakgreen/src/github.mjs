// @ts-check

/**
 * @typedef {{ name: string, color: string, description: string }} Label
 * @typedef {{
 *   listLabels: (repo: string) => Promise<string[]>,
 *   createLabel: (repo: string, label: Label) => Promise<void>,
 * }} GithubClient
 */

/**
 * Every call is `graft api`, so writes go out as the repo's GitHub App.
 *
 * @param {(tool: 'graft', args: string[]) => Promise<import('./tools.mjs').Result>} run
 * @returns {GithubClient}
 */
export function graftGithub(run) {
  const api = async (/** @type {string[]} */ args) => {
    const r = await run('graft', ['api', ...args])
    if (r.code !== 0)
      throw new Error(`graft api ${args[0]} ${args[1]}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`)
    return r.stdout.trim() ? JSON.parse(r.stdout) : null
  }
  return {
    listLabels: async (repo) => {
      const list = await api(['GET', `/repos/${repo}/labels?per_page=100`, '--paginate', '--repo', repo])
      return (Array.isArray(list) ? list : []).map((l) => l.name)
    },
    createLabel: async (repo, label) => {
      await api(['POST', `/repos/${repo}/labels`, '--body', JSON.stringify(label), '--repo', repo])
    },
  }
}
