// Remote access, this machine's end. Two jobs, both through the hub at
// web.codinger.app (remote/, a Cloudflare Worker):
//
// - Serving: one outbound WebSocket to the hub, which sends through it
//   everything for web.codinger.app/m/<name>/. Each request is replayed on this
//   server at 127.0.0.1, and each browser WebSocket gets its own local one, so
//   the server sees what it sees from a local page. Nothing listens for
//   connections from outside.
// - Reaching your other machines: /api/remote/m/<other>/… on this server goes to
//   the hub's /m/<other>/… with this machine's token, so the local page needs no
//   sign-in of its own.
//
// "Connect this machine" asks the hub for a code; you approve it on
// web.codinger.app, signed in, and the machine gets its token. Remote access can be
// turned off and on again; Disconnect forgets the token.
//
// A channel's messages to the hub go in batches: the first at once, the rest
// within BATCH_MS of it in one frame (the hub pays for each frame it gets).

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { machineName, RES_HEADERS, type HubMsg, type MachineMsg } from '../shared/remote.ts'
import type { RemoteStatus } from '../shared/types.ts'
import { DATA } from './store.ts'

const BATCH_MS = Number(process.env.CODINGER_REMOTE_BATCH_MS) || 1000
// The hub's address: web.codinger.app, or the Worker's own workers.dev address where that
// domain does not resolve. Chosen in Settings (saved), else CODINGER_REMOTE_HUB.
const DEFAULT_HUB = (process.env.CODINGER_REMOTE_HUB ?? 'https://web.codinger.app').replace(/\/$/, '')
const FILE = path.join(DATA, 'remote.json')

type Saved = { on: boolean; name: string; token?: string; hub?: string }
let saved: Saved = { on: false, name: machineName(os.hostname().replace(/\.local$/, '')) }
try { saved = { ...saved, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) } } catch { /* not set up */ }
const hubUrl = () => saved.hub ?? DEFAULT_HUB
// Forget the token; keep the name and the hub's address.
const unlink = () => { saved = { on: false, name: saved.name, ...(saved.hub ? { hub: saved.hub } : {}) } }
const save = () => fs.writeFileSync(FILE, JSON.stringify(saved, null, 1), { mode: 0o600 })

let port = 0
let changed: (s: RemoteStatus) => void = () => {}
let hub: WebSocket | null = null
let connected = false
let linking: { code: string; url: string } | null = null
let retry: NodeJS.Timeout | null = null

export function remoteStatus(): RemoteStatus {
  return { hub: hubUrl(), name: saved.name, on: saved.on, linked: !!saved.token, connected, ...(linking ? { linking } : {}) }
}
const tell = () => changed(remoteStatus())

export function startRemote(localPort: number, onChange: (s: RemoteStatus) => void) {
  port = localPort
  changed = onChange
  if (saved.on && saved.token) connect()
}

// ---- the settings -------------------------------------------------------------

export async function remoteLink(name: string, hub?: string): Promise<RemoteStatus> {
  saved.name = machineName(name || saved.name)
  if (hub?.trim()) setHub(hub)
  save()
  // Say why it failed: a network or certificate problem shows only in the cause.
  const r = await fetch(`${hubUrl()}/_remote/link/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: saved.name }) })
    .catch((e: Error & { cause?: Error }) => { throw new Error(`Could not reach ${hubUrl()}: ${e.cause?.message ?? e.message}`) })
  if (!r.ok) throw new Error(`${hubUrl()} answered ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const { code, poll, url } = await r.json() as { code: string; poll: string; url: string }
  linking = { code, url }
  tell()
  // Wait for your approval on the web, for as long as the code lasts.
  const until = Date.now() + 10 * 60_000
  const wait = async () => {
    if (linking?.code !== code) return
    if (Date.now() > until) { linking = null; tell(); return }
    try {
      const p = await fetch(`${hubUrl()}/_remote/link/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, poll }) })
      const j = await p.json() as { token?: string; name?: string; waiting?: boolean }
      if (j.token) {
        Object.assign(saved, { token: j.token, name: j.name ?? saved.name, on: true })
        save()
        linking = null
        connect()
        tell()
        return
      }
      if (!p.ok) { linking = null; tell(); return }
    } catch { /* try again */ }
    setTimeout(wait, 2000).unref()
  }
  setTimeout(wait, 2000).unref()
  return remoteStatus()
}

// An address the hub answers at: "web.codinger.app" or a full URL. Empty: the default.
function setHub(hub: string) {
  const h = hub.trim().replace(/\/$/, '')
  if (!h) delete saved.hub
  else saved.hub = /^https?:\/\//.test(h) ? h : `https://${h}`
}

// Another address of the same hub: the token works there too, so no new approval.
export function remoteHub(hub: string) {
  setHub(hub)
  save()
  if (saved.on && saved.token) { disconnect(); connect() }
  tell()
}

export function remoteCancelLink() { linking = null; tell() }

export function remoteOn(on: boolean) {
  saved.on = on && !!saved.token
  save()
  if (saved.on) connect()
  else disconnect()
  tell()
}

// Forget this machine's token (approve it again to come back).
export function remoteForget() {
  disconnect()
  unlink()
  save()
  tell()
}

// ---- serving: the socket to the hub ------------------------------------------------

function connect() {
  if (hub || !saved.token) return
  if (retry) { clearTimeout(retry); retry = null }
  const local = `127.0.0.1:${port}`
  const ws = new WebSocket(`${hubUrl().replace(/^http/, 'ws')}/_remote/connect`, { headers: { authorization: `Bearer ${saved.token}` } })
  hub = ws
  const chans = new Map<string, Chan>()
  const send = (m: MachineMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) }

  ws.on('open', () => { wait = 1000; connected = true; tell() })
  ws.on('unexpected-response', (_req, res) => {
    // The hub does not know this token any more: forgotten on the web.
    if (res.statusCode === 403) { unlink(); save() }
  })
  ws.on('message', (raw) => {
    let m: HubMsg
    try { m = JSON.parse(String(raw)) } catch { return }
    if (m.t === 'req') request(local, m).then(send)
    else if (m.t === 'open') chans.set(m.chan, new Chan(local, m, send, () => chans.delete(m.chan)))
    else if (m.t === 'msg') chans.get(m.chan)?.in(m.data)
    else if (m.t === 'close') { chans.get(m.chan)?.end(); chans.delete(m.chan) }
  })
  ws.on('close', (code) => {
    for (const c of chans.values()) c.end()
    chans.clear()
    if (hub === ws) hub = null
    connected = false
    if (code === 4001) { unlink(); save() } // disconnected on the web
    tell()
    if (!saved.on || !saved.token || code === 1012) return
    retry = setTimeout(connect, wait)
    retry.unref()
    wait = Math.min(wait * 2, 60_000)
  })
  ws.on('error', () => { /* the close handler tries again */ })
}
let wait = 1000

function disconnect() {
  if (retry) { clearTimeout(retry); retry = null }
  const ws = hub
  hub = null
  connected = false
  ws?.close(1000, 'Turned off')
}

// One HTTP request, replayed here.
function request(local: string, m: Extract<HubMsg, { t: 'req' }>): Promise<MachineMsg> {
  return new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port, method: m.method, path: m.path,
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

// ---- reaching your other machines -----------------------------------------------

// GET /api/remote/machines, and /api/remote/m/<name>/… : on to the hub, with this machine's token.
export async function remoteProxy(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (!saved.token) { res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'This machine is not connected to web.codinger.app' })); return }
  const target = url.pathname === '/api/remote/machines' ? '/_remote/machines' : url.pathname.replace(/^\/api\/remote/, '')
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Promise<Buffer>((resolve) => { const b: Buffer[] = []; req.on('data', (d) => b.push(d)); req.on('end', () => resolve(Buffer.concat(b))) })
  const r = await fetch(hubUrl() + target + url.search, {
    method: req.method,
    headers: { authorization: `Bearer ${saved.token}`, ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}) },
    body: body && new Uint8Array(body),
  }).catch((e: Error) => e)
  if (r instanceof Error) { res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `Could not reach ${hubUrl()}: ${r.message}` })); return }
  const headers: Record<string, string> = {}
  for (const h of RES_HEADERS) { const v = r.headers.get(h); if (v) headers[h] = v }
  res.writeHead(r.status, headers).end(Buffer.from(await r.arrayBuffer()))
}

// A WebSocket to /api/remote/m/<name>/…: one to the hub, joined to it.
const wss = new WebSocketServer({ noServer: true })
export function remoteUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
  if (!saved.token) { socket.destroy(); return }
  const target = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/api\/remote/, '')
  const far = new WebSocket(`${hubUrl().replace(/^http/, 'ws')}${target}`, { headers: { authorization: `Bearer ${saved.token}` } })
  far.on('error', () => socket.destroy())
  far.on('open', () => wss.handleUpgrade(req, socket, head, (near) => {
    near.on('message', (d) => far.send(String(d)))
    far.on('message', (d) => near.send(String(d)))
    near.on('close', () => far.close())
    far.on('close', () => near.close())
  }))
}
