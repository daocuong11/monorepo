// @ts-check
/** The launchd agent for `mycelium run`: KeepAlive restarts it whenever it exits. Settings stay in the env file. */
import { join } from 'node:path'

export const LABEL = 'com.oakgreencc.mycelium'

/** @param {string} s */
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * @param {{ node: string, bin: string, home: string, path: string, logFile: string, envFile?: string }} o
 * `envFile` is written only when it was set explicitly (`$MYCELIUM_ENV`); otherwise the default is found again.
 */
export function plist({ node, bin, home, path, logFile, envFile }) {
  const args = [node, bin, 'run'].map((a) => `    <string>${xml(a)}</string>`).join('\n')
  const env = { PATH: path, HOME: home, ...(envFile ? { MYCELIUM_ENV: envFile } : {}) }
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
${args}
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
export const logPath = (home) => join(home, '.mycelium', 'logs', 'mycelium.log')
