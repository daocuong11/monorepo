// @ts-check
/** The launchd agent for `canopy`: KeepAlive restarts it whenever it exits, so `oakgreen restart` picks up new code. */
import { join } from 'node:path'

export const LABEL = 'com.oakgreencc.canopy'

/** @param {string} s */
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * @param {{ node: string, bin: string, args: string[], home: string, path: string, logFile: string, config?: string }} o
 * `args` are the serve flags baked into the agent. `config` is written only when it was set explicitly
 * (`$CAMBIUM_CONFIG`); otherwise canopy finds the default again.
 */
export function plist({ node, bin, args, home, path, logFile, config }) {
  const argv = [node, bin, ...args].map((a) => `    <string>${xml(a)}</string>`).join('\n')
  const env = { PATH: path, HOME: home, ...(config ? { CAMBIUM_CONFIG: config } : {}) }
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xml(home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile)}</string>
</dict>
</plist>
`
}

/** @param {string} home */
export const plistPath = (home) => join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)

/** @param {string} home */
export const logPath = (home) => join(home, '.canopy', 'logs', 'canopy.log')
