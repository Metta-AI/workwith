// Windows has no named pipes in the file system for proc.ts, so a session's claude
// process runs under this relay. Started detached by the server, it holds claude's
// input open, so claude never sees the end of its input when a server goes. It
// passes on what comes on its own stdin (from the server that started it) and on
// the Windows named pipe \\.\pipe\codinger-<key> (from a later server). claude's
// output goes to the relay's own stdout and stderr: <key>.out and <key>.err.
// It ends with claude's exit code; ended itself, it takes claude with it.
// It is a file and not `node -e`: some security software stops a node whose
// command line starts hidden processes.

import { spawn } from 'node:child_process'
import net from 'node:net'

const [key, command] = process.argv.slice(2)
const [cmd, ...args] = JSON.parse(command) as string[]
const claude = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
claude.on('error', (e) => { process.stderr.write(`Could not start ${cmd}: ${e.message}\n`); process.exit(1) })
claude.on('exit', (code) => process.exit(code ?? 1))
claude.stdin!.on('error', () => { /* claude ended: the exit handler ends this too */ })

const pass = (from: NodeJS.ReadableStream) => from.on('error', () => {}).on('data', (d) => claude.stdin!.write(d))
pass(process.stdin)
net.createServer(pass).listen(`\\\\.\\pipe\\codinger-${key}`)
