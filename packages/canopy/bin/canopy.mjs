#!/usr/bin/env node
// @ts-check
import { main } from '../src/cli.mjs'

const started = main(process.argv.slice(2))
if (typeof started === 'number') process.exitCode = started
else {
  const { server, host, port } = started
  server.on('error', (err) => {
    process.stderr.write(`canopy: ${err.message}\n`)
    process.exitCode = 1
  })
  server.listen(port, host, () => {
    const addr = /** @type {import('node:net').AddressInfo} */ (server.address())
    const shown = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address
    process.stdout.write(`canopy: http://${shown}:${addr.port}/\n`)
  })
  for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM']))
    process.once(sig, () => {
      server.closeAllConnections()
      server.close()
    })
}
