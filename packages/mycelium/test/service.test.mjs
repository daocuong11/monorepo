// @ts-check
/** The settings file and `mycelium install`; nothing touches launchd or the real home. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { envFilePath, parseEnvFile, withEnvFile } from '../src/envfile.mjs'

test('parseEnvFile: comments, export, bare, double and shell single quotes', () => {
  const text = [
    '# a comment',
    'MYCELIUM_REPO=o/r',
    "export MYCELIUM_DISCORD_TOKEN='abc'",
    "MYCELIUM_X='it'\\''s'",
    'MYCELIUM_Y="a \\"b\\""',
    'not a line',
    '',
  ].join('\n')
  assert.deepEqual(parseEnvFile(text), {
    MYCELIUM_REPO: 'o/r',
    MYCELIUM_DISCORD_TOKEN: 'abc',
    MYCELIUM_X: "it's",
    MYCELIUM_Y: 'a "b"',
  })
})

test('withEnvFile: $MYCELIUM_ENV else ~/.mycelium/env; the environment wins; no file is fine', () => {
  assert.equal(envFilePath({}, '/h'), '/h/.mycelium/env')
  assert.equal(envFilePath({ MYCELIUM_ENV: '/x/env' }, '/h'), '/x/env')
  /** @type {string[]} */
  const asked = []
  const read = (/** @type {string} */ p) => {
    asked.push(p)
    return 'MYCELIUM_REPO=file/repo\nMYCELIUM_BACKFILL_HOURS=6\n'
  }
  const r = withEnvFile({ MYCELIUM_REPO: 'env/repo', MYCELIUM_BACKFILL_HOURS: '' }, { home: '/h', read })
  assert.deepEqual(asked, ['/h/.mycelium/env'])
  assert.equal(r.file, '/h/.mycelium/env')
  assert.equal(r.env.MYCELIUM_REPO, 'env/repo')
  assert.equal(r.env.MYCELIUM_BACKFILL_HOURS, '6', 'an empty variable does not hide the file')
  assert.deepEqual(withEnvFile({ A: '1' }, { home: '/h', read: () => null }), { env: { A: '1' }, file: null })
})

const DISCORD = { MYCELIUM_DISCORD_TOKEN: 't', MYCELIUM_DISCORD_CHANNELS: '1' }

/** @param {string[]} argv @param {Record<string, string>} env */
async function install(argv, env) {
  const lines = /** @type {string[]} */ ([])
  const writes = /** @type {[string, string][]} */ ([])
  const code = await main(argv, {
    env: { PATH: '/bin:/usr/bin', ...env },
    home: '/Users/me',
    write: (p, t) => writes.push([p, t]),
    out: (l) => lines.push(l),
    err: () => {},
  })
  return { code, out: lines.join('\n'), writes }
}

test('install: writes the agent for `run`, PATH and HOME in it, no secrets', async () => {
  const r = await install(['install'], { ...DISCORD, MYCELIUM_REPO: 'o/r' })
  assert.equal(r.code, 0)
  assert.equal(r.writes.length, 1)
  const [path, text] = r.writes[0]
  assert.equal(path, '/Users/me/Library/LaunchAgents/com.oakgreencc.mycelium.plist')
  assert.match(text, /<string>com\.oakgreencc\.mycelium<\/string>/)
  assert.match(text, /bin\/mycelium\.mjs<\/string>\n {4}<string>run<\/string>/)
  assert.match(text, /<key>PATH<\/key>\n {4}<string>\/bin:\/usr\/bin<\/string>/)
  assert.match(text, /<key>KeepAlive<\/key>\n {2}<true\/>/)
  assert.match(text, /\/Users\/me\/\.mycelium\/logs\/mycelium\.log/)
  assert.doesNotMatch(text, /MYCELIUM_DISCORD_TOKEN|MYCELIUM_ENV/)
  assert.match(r.out, /sources: discord/)
  assert.match(r.out, /oakgreen start mycelium/)

  const custom = await install(['install'], { ...DISCORD, MYCELIUM_REPO: 'o/r', MYCELIUM_ENV: '/etc/myc' })
  assert.match(custom.writes[0][1], /<key>MYCELIUM_ENV<\/key>\n {4}<string>\/etc\/myc<\/string>/)
})

test('install: refused with no source or no repository; --dry-run prints and writes nothing', async () => {
  await assert.rejects(
    install(['install'], { MYCELIUM_REPO: 'o/r' }),
    /no source is configured.*\/Users\/me\/\.mycelium\/env/,
  )
  await assert.rejects(install(['install'], DISCORD), /MYCELIUM_REPO/)
  const dry = await install(['install', '--dry-run'], {})
  assert.equal(dry.code, 0)
  assert.equal(dry.writes.length, 0)
  assert.match(dry.out, /^# would write \/Users\/me\/Library\/LaunchAgents\/com\.oakgreencc\.mycelium\.plist/)
})
