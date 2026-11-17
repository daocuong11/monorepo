// @ts-check
/** The launchd agent: KeepAlive restarts the daemon whenever it exits. */
import { join } from 'node:path'

export const LABEL = 'com.oakgreencc.cambium'

/** @param {string} s */
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * @param {{ node: string, bin: string, configPath: string, logsDir: string, home: string, path: string, label?: string }} o
 */
export function plist({ node, bin, configPath, logsDir, home, path, label = LABEL }) {
  const args = [node, bin, 'start', '--config', configPath].map((a) => `    <string>${xml(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
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
    <key>PATH</key>
    <string>${xml(path)}</string>
    <key>HOME</key>
    <string>${xml(home)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logsDir, 'cambium.launchd.err.log'))}</string>
</dict>
</plist>
`
}

/** @param {string} home @param {string} [label] */
export const plistPath = (home, label = LABEL) => join(home, 'Library', 'LaunchAgents', `${label}.plist`)
