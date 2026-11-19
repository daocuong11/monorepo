// @ts-check
/** `canopy install`: the launchd agent oakgreen starts, restarts and reloads. Nothing touches the real disk. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { LABEL, plist } from '../src/launchd.mjs'

const HOME = '/Users/me'

/** @param {string[]} argv @param {Record<string, string | undefined>} [env] */
function run(argv, env = { PATH: '/opt/bin:/usr/bin', HOME }) {
  let out = ''
  let err = ''
  /** @type {[string, string][]} */
  const wrote = []
  const code = main(argv, {
    env,
    home: HOME,
    out: (s) => (out += s),
    err: (s) => (err += s),
    write: (p, t) => wrote.push([p, t]),
  })
  return { code, out, err, wrote }
}

/** The ProgramArguments strings of a plist. @param {string} text */
const programArgs = (text) =>
  [
    ...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '').matchAll(
      /<string>(.*?)<\/string>/g,
    ),
  ].map((m) => m[1])

test('install writes a KeepAlive agent under the oakgreen label, serving with the flags given', () => {
  const r = run(['install', '--port', '4400', '--repo', 'a/b', '--state', 'install'])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.wrote.length, 1)
  const [path, text] = r.wrote[0]
  assert.equal(path, `${HOME}/Library/LaunchAgents/com.oakgreencc.canopy.plist`)
  assert.equal(LABEL, 'com.oakgreencc.canopy')
  assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(text, /<key>PATH<\/key>\s*<string>\/opt\/bin:\/usr\/bin<\/string>/, 'graft is found through PATH')
  assert.match(text, new RegExp(`<string>${HOME}/.canopy/logs/canopy.log</string>`))
  assert.doesNotMatch(text, /CAMBIUM_CONFIG/, 'the default config is found again, not pinned')
  const args = programArgs(text)
  assert.equal(args[0], process.execPath)
  assert.match(args[1], /bin\/canopy\.mjs$/)
  // A flag value that happens to read "install" is kept; only the verb is dropped.
  assert.deepEqual(args.slice(2), ['--port', '4400', '--repo', 'a/b', '--state', 'install'])
  assert.match(r.out, /oakgreen start canopy/)
})

test('install --dry-run prints the agent and writes nothing; an explicit CAMBIUM_CONFIG is carried', () => {
  const r = run(['install', '--dry-run'], { PATH: '/usr/bin', HOME, CAMBIUM_CONFIG: '/etc/cambium.json' })
  assert.equal(r.code, 0, r.err)
  assert.equal(r.wrote.length, 0)
  assert.match(r.out, /^# would write \/Users\/me\/Library\/LaunchAgents\/com\.oakgreencc\.canopy\.plist/)
  assert.match(r.out, /<key>CAMBIUM_CONFIG<\/key>\s*<string>\/etc\/cambium\.json<\/string>/)
  assert.deepEqual(programArgs(r.out).slice(2), [])
})

test('install refuses flags canopy itself would refuse; stray arguments are errors', () => {
  assert.equal(run(['install', '--port', 'nope']).code, 2)
  assert.equal(run(['install', '--repo', 'not-a-slug']).code, 2)
  assert.equal(run(['install', '--bogus']).code, 2)
  const stray = run(['serve'])
  assert.equal(stray.code, 2)
  assert.match(stray.err, /unexpected argument serve/)
  assert.equal(run(['install', 'extra']).code, 2)
  assert.match(run(['--dry-run']).err, /--dry-run only goes with install/)
  for (const r of [run(['install', '--port', 'nope']), run(['serve'])]) assert.equal(r.wrote.length, 0)
})

test('plist escapes XML in paths and arguments', () => {
  const text = plist({ node: '/n', bin: '/b', args: ['--repo', 'a&b/c'], home: '/h<x>', path: '/p', logFile: '/l' })
  assert.match(text, /<string>a&amp;b\/c<\/string>/)
  assert.match(text, /<string>\/h&lt;x&gt;<\/string>/)
})
