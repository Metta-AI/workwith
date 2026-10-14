// A claude process that can outlive the server that started it, so a restart
// of Codiner leaves a working session working.
//
// The process runs in its own process group. It reads its input from a named
// pipe, ~/.codiner/procs/<key>.in, which it also holds open for writing, so it
// never sees the end of its input when a server goes. It writes its output to
// <key>.out and <key>.err; <key>.pid has its pid.
//
// A server that stops hands a busy process on: <session id>.json says which
// process, how far into <key>.out the server got, and the session's state then.
// The next server picks it up from there. Any other process left in the folder
// (from a crash) is stopped when the next server starts.

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { DATA } from './store.ts'

const DIR = path.join(DATA, 'procs')
fs.mkdirSync(DIR, { recursive: true })
const file = (key: string, ext: 'in' | 'out' | 'err' | 'pid' | 'json') => path.join(DIR, `${key}.${ext}`)

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
// The pid is still the claude process Codiner started, not a new process given the same pid.
const ours = (pid: number) => {
  try { return alive(pid) && execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes('--input-format stream-json') } catch { return false }
}

type Handoff = { key: string; pid: number; offset: number; state: unknown }

export class Proc {
  readonly key: string
  readonly pid: number
  private sock: net.Socket
  private fd: number              // <key>.out, read from
  private pos: number             // bytes read from it
  private offset: number          // bytes of whole lines handled
  private buf = ''
  private decoder = new StringDecoder('utf8')
  private watcher: fs.FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private adopted = false         // not our child: its end is found by polling
  private lastErr = ''
  private onLine: (line: string) => void = () => {}
  private onExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {}

  private constructor(key: string, pid: number, offset: number) {
    this.key = key
    this.pid = pid
    this.offset = this.pos = offset
    this.fd = fs.openSync(file(key, 'out'), 'r')
    // Throws ENXIO when nothing reads the pipe: the process is gone.
    const w = fs.openSync(file(key, 'in'), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
    this.sock = new net.Socket({ fd: w, readable: false, writable: true })
    this.sock.on('error', () => { /* the exit handler reports it */ })
  }

  static spawn(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Proc {
    const key = randomUUID().slice(0, 12)
    execFileSync('mkfifo', ['-m', '600', file(key, 'in')])
    const input = fs.openSync(file(key, 'in'), fs.constants.O_RDWR)
    const out = fs.openSync(file(key, 'out'), 'a', 0o600)
    const err = fs.openSync(file(key, 'err'), 'a', 0o600)
    let p
    try {
      p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: [input, out, err] })
      p.on('error', () => { /* no pid: thrown below */ })
      if (!p.pid) throw new Error(`Could not start ${cmd}`)
      fs.writeFileSync(file(key, 'pid'), String(p.pid))
      const proc = new Proc(key, p.pid, 0)
      p.on('exit', (code, signal) => proc.end(code, signal))
      return proc
    } catch (e) {
      remove(key)
      throw e
    } finally {
      for (const fd of [input, out, err]) fs.closeSync(fd)
      p?.unref()
    }
  }

  // The process a stopped server handed on for this session, if it is still there.
  static adopt(id: string): { proc: Proc; state: unknown } | null {
    let h: Handoff
    try { h = JSON.parse(fs.readFileSync(file(id, 'json'), 'utf8')) } catch { return null }
    fs.rmSync(file(id, 'json'), { force: true })
    try {
      const proc = new Proc(h.key, h.pid, h.offset)
      proc.adopted = true
      return { proc, state: h.state }
    } catch {
      // Ended while no server watched (nothing reads the pipe now).

      remove(h.key)
      return null
    }
  }

  // Stop and remove every process here that no session picked up.
  static sweep(keep: Set<string>) {
    for (const f of fs.readdirSync(DIR)) {
      const [key, ext] = f.split('.')
      if (keep.has(key)) continue
      if (ext === 'pid') {
        const pid = Number(fs.readFileSync(path.join(DIR, f), 'utf8'))
        if (pid && ours(pid)) try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
      }
      fs.rmSync(path.join(DIR, f), { force: true })
    }
  }

  start(onLine: (line: string) => void, onExit: (code: number | null, signal: NodeJS.Signals | null) => void) {
    this.onLine = onLine
    this.onExit = onExit
    try { this.watcher = fs.watch(file(this.key, 'out'), () => this.pump()) } catch { /* the timer reads it */ }
    this.timer = setInterval(() => { this.pump(); if (this.adopted && !alive(this.pid)) this.end(null, null) }, 500)
    setImmediate(() => this.pump())
  }

  write(s: string) {
    if (!this.closed) this.sock.write(s)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    try { process.kill(this.pid, signal) } catch { /* gone */ }
  }

  stderrTail(): string {
    if (this.closed) return this.lastErr
    try { return fs.readFileSync(file(this.key, 'err'), 'utf8').slice(-2000) } catch { return '' }
  }

  // Leave the process running for the next server.
  handoff(id: string, state: unknown) {
    this.pump()
    const h: Handoff = { key: this.key, pid: this.pid, offset: this.offset, state }
    fs.writeFileSync(file(id, 'json'), JSON.stringify(h), { mode: 0o600 })
    this.close()
  }

  private pump() {
    if (this.closed) return
    const chunk = Buffer.alloc(1 << 16)
    let n: number
    while (!this.closed && (n = fs.readSync(this.fd, chunk, 0, chunk.length, this.pos)) > 0) {
      this.pos += n
      this.buf += this.decoder.write(chunk.subarray(0, n))
      let i: number
      while (!this.closed && (i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        this.offset += Buffer.byteLength(line) + 1
        this.onLine(line)
      }
    }
  }

  private end(code: number | null, signal: NodeJS.Signals | null) {
    if (this.closed) return
    this.pump()
    this.lastErr = this.stderrTail()
    this.close()
    remove(this.key)
    this.onExit(code, signal)
  }

  private close() {
    if (this.closed) return
    this.closed = true
    this.watcher?.close()
    if (this.timer) clearInterval(this.timer)
    this.sock.destroy()
    fs.closeSync(this.fd)
  }
}

function remove(key: string) {
  for (const ext of ['in', 'out', 'err', 'pid'] as const) fs.rmSync(file(key, ext), { force: true })
}
