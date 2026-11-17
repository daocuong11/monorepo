// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fingerprint } from '../src/envelope.mjs'
import { discordConfig, discordSource, snowflakeAt, snowflakeTime, USER_AGENT } from '../src/sources/discord.mjs'
import { fakeFetch, fixture } from './helpers.mjs'

const CHANNEL = '900000000000000001'
const FORUM = '900000000000000002'
const GUILD = '900000000000000000'
const env = {
  MYCELIUM_DISCORD_TOKEN: 'synthetic-bot-token',
  MYCELIUM_DISCORD_CHANNELS: `${CHANNEL}, forum:${FORUM}`,
  MYCELIUM_DISCORD_GUILD: GUILD,
}
const NOW = Date.parse('2026-11-01T12:10:00Z')
const SINCE = Date.parse('2026-11-01T11:00:00Z')
const forum = fixture('discord-forum.json')
const route = (/** @type {string} */ url) => {
  if (url.includes(`/channels/${CHANNEL}/messages?`)) return fixture('discord-messages.json')
  if (url.endsWith(`/guilds/${GUILD}/threads/active`)) return forum.active
  const starter = /\/channels\/(\d+)\/messages\/(\d+)$/.exec(url)
  if (starter) return forum.starters[starter[2]]
}

test('discord config: channels and forums from env; a forum needs the guild', () => {
  assert.deepEqual(discordConfig(env)?.channels, [
    { id: CHANNEL, forum: false },
    { id: FORUM, forum: true },
  ])
  assert.equal(discordConfig({ MYCELIUM_DISCORD_TOKEN: 't' }), null)
  assert.throws(() => discordConfig({ ...env, MYCELIUM_DISCORD_GUILD: '' }), /GUILD/)
  assert.throws(() => discordConfig({ ...env, MYCELIUM_DISCORD_CHANNELS: 'general' }), /snowflake/)
})

test('snowflakes round-trip to time', () => {
  assert.equal(snowflakeAt(Date.parse('2026-11-01T12:00:00Z')), '1566421549056000000')
  assert.equal(snowflakeTime('1566421549056000000'), Date.parse('2026-11-01T12:00:00Z'))
})

test('discord: a text channel, oldest first; bots and system messages skipped; a reply joins its root', async () => {
  const f = fakeFetch(route)
  const config = /** @type {any} */ ({ ...discordConfig(env), channels: [{ id: CHANNEL, forum: false }] })
  const items = await discordSource({ fetch: f.fetch, config }).pull(null, { now: NOW, since: SINCE })
  assert.equal(f.calls.length, 1)
  assert.equal(
    f.calls[0].url,
    `https://discord.com/api/v10/channels/${CHANNEL}/messages?after=${snowflakeAt(SINCE)}&limit=100`,
  )
  assert.equal(f.calls[0].init.headers.Authorization, 'Bot synthetic-bot-token')
  assert.equal(f.calls[0].init.headers['User-Agent'], USER_AGENT)

  assert.deepEqual(
    items.map((i) => i.envelope?.author ?? null),
    ['alice_example', null, 'bob_example', null, 'carol_example'],
  )
  assert.deepEqual(items.at(-1)?.cursor, { [CHANNEL]: '1566422555688960000' })
  const [root, , reply] = items.map((i) => i.envelope)
  assert.deepEqual(root, {
    source: 'discord',
    externalId: '1566421549056000000',
    receivedAt: '2026-11-01T12:00:00.000Z',
    author: 'alice_example',
    title: '',
    body: 'The app crashes when I open settings',
    url: `https://discord.com/channels/${GUILD}/${CHANNEL}/1566421549056000000`,
    meta: { channelId: CHANNEL, rootId: null },
  })
  assert.equal(reply?.body, 'Same for me on Android\nhttps://cdn.discordapp.com/attachments/example/shot.png')
  assert.equal(fingerprint(/** @type {any} */ (reply)), fingerprint(/** @type {any} */ (root)))
  assert.notEqual(fingerprint(/** @type {any} */ (items[4].envelope)), fingerprint(/** @type {any} */ (root)))
})

test('discord: a forum channel files new posts past the cursor, starter as body', async () => {
  const f = fakeFetch(route)
  const config = /** @type {any} */ ({ ...discordConfig(env), channels: [{ id: FORUM, forum: true }] })
  const src = discordSource({ fetch: f.fetch, config })
  const items = await src.pull(null, { now: NOW, since: SINCE })
  assert.deepEqual(
    items.map((i) => i.envelope?.title),
    ['Map does not load', 'Typo on the welcome screen'],
  )
  assert.deepEqual(items[0].envelope?.meta, {
    channelId: FORUM,
    rootId: '1566421549056000000',
    tags: ['700000000000000001'],
  })
  assert.equal(items[0].envelope?.body, 'Opening the map tab shows a blank grey screen.')
  assert.equal(items[0].envelope?.url, `https://discord.com/channels/${GUILD}/1566421549056000000`)

  const later = await src.pull({ [FORUM]: '1566421549056000000' }, { now: NOW, since: SINCE })
  assert.deepEqual(
    later.map((i) => i.envelope?.title),
    ['Typo on the welcome screen'],
  )
})
