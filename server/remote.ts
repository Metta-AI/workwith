// Remote access, this machine's end: one outbound WebSocket to the hub
// (remote/, a Cloudflare Worker), which sends through it everything for
// <name>.codinger.app. Each request is replayed on this server at 127.0.0.1,
// and each browser WebSocket gets its own local one, so the server sees what it
// sees from a local page. Nothing listens for connections from outside.
//
// A channel's messages to the hub go in batches: the first at once, the rest
// within BATCH_MS of it in one frame (the hub pays for each frame it gets).
//
// For now it is set with CODINGER_REMOTE (the hub, like wss://app.codinger.app),
// CODINGER_REMOTE_TOKEN and CODINGER_REMOTE_NAME (this machine's host name by default).

import http from 'node:http'
import os from 'node:os'
import WebSocket from 'ws'
import { machineName, RES_HEADERS, type HubMsg, type MachineMsg } from '../shared/remote.ts'

const BATCH_MS = Number(process.env.CODINGER_REMOTE_BATCH_MS) || 1000

export function startRemote(port: number) {
  const hub = process.env.CODINGER_REMOTE
  const token = process.env.CODINGER_REMOTE_TOKEN
  if (!hub || !token) return
  const name = machineName(process.env.CODINGER_REMOTE_NAME ?? os.hostname().replace(/\.local$/, ''))
  const local = `127.0.0.1:${port}`
  let wait = 1000

  const connect = () => {
    const ws = new WebSocket(`${hub.replace(/\/$/, '')}/_remote/connect?name=${name}`, { headers: { authorization: `Bearer ${token}` } })
    const chans = new Map<string, Chan>()
    const send = (m: MachineMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) }

    ws.on('open', () => { wait = 1000; console.log(`Remote access: ${name} is connected to ${hub}`) })
    ws.on('message', (raw) => {
      let m: HubMsg
      try { m = JSON.parse(String(raw)) } catch { return }
      if (m.t === 'req') request(local, m).then(send)
      else if (m.t === 'open') chans.set(m.chan, new Chan(local, m, send, () => chans.delete(m.chan)))
      else if (m.t === 'msg') chans.get(m.chan)?.in(m.data)
      else if (m.t === 'close') { chans.get(m.chan)?.end(); chans.delete(m.chan) }
    })
    ws.on('close', (code, reason) => {
      for (const c of chans.values()) c.end()
      chans.clear()
      if (code === 1012) return // this machine connected again from somewhere else
      console.log(`Remote access: disconnected (${code}${reason.length ? ` ${reason}` : ''}); again in ${wait / 1000}s`)
      setTimeout(connect, wait).unref()
      wait = Math.min(wait * 2, 60_000)
    })
    ws.on('error', () => { /* the close handler tries again */ })
  }
  connect()
}

// One HTTP request, replayed here.
function request(local: string, m: Extract<HubMsg, { t: 'req' }>): Promise<MachineMsg> {
  return new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port: Number(local.split(':')[1]), method: m.method, path: m.path,
      headers: { ...m.headers, host: local, origin: `http://${local}`, 'x-codinger-remote': '1' },
    }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (b: Buffer) => parts.push(b))
      res.on('end', () => {
        const headers: Record<string, string> = {}
        for (const h of RES_HEADERS) { const v = res.headers[h]; if (v) headers[h] = String(v) }
        resolve({ t: 'res', id: m.id, status: res.statusCode ?? 502, headers, body: Buffer.concat(parts).toString('base64') })
      })
    })
    r.on('error', (e) => resolve({ t: 'res', id: m.id, status: 502, headers: { 'content-type': 'text/plain' }, body: Buffer.from(e.message).toString('base64') }))
    if (m.body) r.write(Buffer.from(m.body, 'base64'))
    r.end()
  })
}

// One browser WebSocket, as a local one.
class Chan {
  private ws: WebSocket
  private chan: string
  private send: (m: MachineMsg) => void
  private early: string[] = []  // from the browser before the local socket opened
  private out: string[] = []
  private timer: NodeJS.Timeout | null = null
  private last = 0

  constructor(local: string, m: Extract<HubMsg, { t: 'open' }>, send: (m: MachineMsg) => void, gone: () => void) {
    this.chan = m.chan
    this.send = send
    this.ws = new WebSocket(`ws://${local}${m.path}`, m.protocols, { headers: { origin: `http://${local}`, 'x-codinger-remote': '1' } })
    this.ws.on('open', () => { for (const d of this.early) this.ws.send(d); this.early = [] })
    this.ws.on('message', (d) => this.queue(String(d)))
    this.ws.on('close', () => { this.flush(); send({ t: 'close', chan: m.chan }); gone() })
    this.ws.on('error', () => { /* close follows */ })
  }

  in(data: string) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data)
    else if (this.ws.readyState === WebSocket.CONNECTING) this.early.push(data)
  }

  end() { if (this.timer) clearTimeout(this.timer); this.ws.close() }

  // The first message after a quiet spell goes at once; the rest wait for the batch.
  private queue(d: string) {
    this.out.push(d)
    if (this.timer) return
    const since = Date.now() - this.last
    if (since >= BATCH_MS) return this.flush()
    this.timer = setTimeout(() => this.flush(), BATCH_MS - since)
  }

  private flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.out.length) return
    this.send({ t: 'msgs', chan: this.chan, data: this.out })
    this.out = []
    this.last = Date.now()
  }
}
