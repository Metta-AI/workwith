// Windows has no named pipes in the file system for proc.ts, so a session's claude
// process runs under this relay. Started detached by the server, it holds claude's
// input open, so claude never sees the end of its input when a server goes. It
// passes on what comes on its own stdin (from the server that started it) and on
// the Windows named pipe \\.\pipe\codinger-<key> (from a later server). claude's
// output goes on to the relay's own stdout and stderr: <key>.out and <key>.err.
// It ends with claude's exit code; ended itself, it takes claude with it.
// It is a file and not `node -e`: some security software stops a node whose
// command line starts hidden processes.
//
// With no server for IDLE_MS after claude's last turn ended (no server started
// again to pick it up), it ends claude: nothing would ever send it more.

import { spawn } from 'node:child_process'
import net from 'node:net'

const IDLE_MS = Number(process.env.CODINGER_RELAY_IDLE_MS) || 10 * 60_000  // shorter for tests

const [key, command] = process.argv.slice(2)
const [cmd, ...args] = JSON.parse(command) as string[]
const claude = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
claude.on('error', (e) => { process.stderr.write(`Could not start ${cmd}: ${e.message}\n`); process.exit(1) })
claude.on('exit', (code) => process.exit(code ?? 1))
claude.stdin!.on('error', () => { /* claude ended: the exit handler ends this too */ })

// servers: how many are connected. idleSince: when the last turn ended, while no other started.
let servers = 0
let idleSince = 0
const pass = (from: NodeJS.ReadableStream) => {
  servers++
  from.on('error', () => {}).on('data', (d) => { idleSince = 0; claude.stdin!.write(d) })
  from.once('close', () => servers--)
}
pass(process.stdin)
net.createServer(pass).listen(`\\\\.\\pipe\\codinger-${key}`)

let line = ''
claude.stdout!.on('data', (d: Buffer) => {
  process.stdout.write(d)
  const parts = (line + d.toString('utf8')).split('\n')
  line = parts.pop()!
  if (line.length > 1 << 20) line = ''  // a huge line is no turn's end
  for (const l of parts) {
    if (!l.trim()) continue
    let type = ''
    try { type = JSON.parse(l).type } catch { /* not a message */ }
    // Other lines can follow a turn's result; only these are a turn at work.
    if (type === 'result') idleSince = Date.now()
    else if (type === 'assistant' || type === 'user' || type === 'stream_event') idleSince = 0
  }
})

setInterval(() => { if (!servers && idleSince && Date.now() - idleSince > IDLE_MS) claude.kill() }, Math.min(30_000, IDLE_MS / 4)).unref()
