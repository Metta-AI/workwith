// Restart on Windows, where there is no sh (see restart() in index.ts): started
// detached by the old server, this waits for it to let go of the port, rebuilds the
// UI unless in dev, then starts the new server. It is a file and not `node -e`:
// some security software stops a node whose command line starts hidden processes.

import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'

const [log, dev, cwd, ...cmd] = JSON.parse(process.argv[2]) as [string, boolean, string, ...string[]]
setTimeout(() => {
  const fd = fs.openSync(log, 'a')
  if (!dev) try { execSync('npx vite build', { cwd, stdio: ['ignore', fd, fd] }) } catch { process.exit(1) }
  spawn(cmd[0], cmd.slice(1), { cwd, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] }).unref()
}, 1000)
