// @ts-check
import { execFile } from 'node:child_process'
import { LABEL } from './intake.mjs'

/**
 * @typedef {(cmd: string, args: string[]) => Promise<string>} Exec
 */

/** @type {Exec} */
const defaultExec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${String(stderr || err.message).trim()}`))
      else resolve(stdout)
    })
  })

/**
 * The default GitHub client: every call is `graft api`, so writes go out as
 * the repo's GitHub App and no human token is needed.
 *
 * @param {{ repo: string, exec?: Exec, bin?: string }} opts
 * @returns {import('./intake.mjs').GithubClient}
 */
export function graftClient({ repo, exec = defaultExec, bin = 'graft' }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`github: repo must be owner/name, got ${repo}`)
  const base = `/repos/${repo}`
  const api = async (
    /** @type {string} */ method,
    /** @type {string} */ path,
    /** @type {any} */ body,
    paginate = false,
  ) => {
    const args = ['api', method, path, '--repo', repo]
    if (body !== undefined) args.push('--body', JSON.stringify(body))
    if (paginate) args.push('--paginate')
    const out = await exec(bin, args)
    return out.trim() ? JSON.parse(out) : null
  }
  return {
    openIntents: async () => {
      const list = await api(
        'GET',
        `${base}/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=100`,
        undefined,
        true,
      )
      return (Array.isArray(list) ? list : [])
        .filter((i) => !i.pull_request)
        .map((i) => ({ number: i.number, body: i.body ?? '' }))
    },
    createIssue: ({ title, body, labels }) => api('POST', `${base}/issues`, { title, body, labels }),
    comment: (number, body) => api('POST', `${base}/issues/${number}/comments`, { body }),
  }
}
