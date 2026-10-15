// The hub for remote access: one Worker and one Durable Object for the owner.
//
// app.<BASE> lists the connected machines; a machine connects to
// app.<BASE>/_remote/connect with its token and keeps that WebSocket open.
// Everything for <machine>.<BASE> (the UI, /api, /ws) goes through that socket
// to the machine (shared/remote.ts), and back.
//
// Sign-in is not here yet: DEV_TOKEN (remote/.dev.vars, or a secret) stands in
// for it, for a machine's token and, as ?dev=<token> once, for a browser.

import { DurableObject } from 'cloudflare:workers'
import { REQ_HEADERS, RES_HEADERS, RESERVED, type HubMsg, type MachineMsg } from '../../shared/remote.ts'

type Env = { HUB: DurableObjectNamespace<Hub>; BASE_HOST: string; DEV_TOKEN?: string }

const TIMEOUT_MS = 60_000
const COOKIE = 'codinger_dev'

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // One owner, so one hub.
    return env.HUB.get(env.HUB.idFromName('owner')).fetch(req)
  },
} satisfies ExportedHandler<Env>

export class Hub extends DurableObject<Env> {
  private pending = new Map<string, (m: Extract<MachineMsg, { t: 'res' }>) => void>()

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const base = this.env.BASE_HOST
    const host = url.hostname
    // Until sign-in: ?dev=<token> once on an address signs that address in.
    const dev = url.searchParams.get('dev')
    if (dev && this.env.DEV_TOKEN && dev === this.env.DEV_TOKEN) {
      url.searchParams.delete('dev')
      return new Response(null, { status: 302, headers: { location: url.pathname + url.search, 'set-cookie': `${COOKIE}=${dev}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` } })
    }
    if (host === base || host === `app.${base}`) return this.app(req, url)
    if (!host.endsWith(`.${base}`)) return new Response('Not found', { status: 404 })
    const name = host.slice(0, -base.length - 1)
    if (name.includes('.') || RESERVED.has(name)) return new Response('Not found', { status: 404 })

    if (!this.signedIn(req)) return page('Sign in', '<p>You are not signed in.</p>', 401)

    const machine = this.machine(name)
    if (!machine) return page('Not connected', `<p><b>${esc(name)}</b> is not connected. Turn on remote access in its Codinger.</p><p><a href="//app.${esc(base)}${port(url)}/">Your machines</a></p>`, 502)
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') return this.channel(req, url, name, machine)
    return this.request(req, url, machine)
  }

  // ---- app.<BASE> -------------------------------------------------------------

  private async app(req: Request, url: URL): Promise<Response> {
    if (url.pathname === '/_remote/connect') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
      const token = req.headers.get('authorization')?.replace(/^Bearer /, '')
      if (!this.env.DEV_TOKEN || token !== this.env.DEV_TOKEN) return new Response('Not allowed', { status: 403 })
      const name = url.searchParams.get('name') ?? ''
      if (!/^[a-z0-9-]{1,40}$/.test(name) || RESERVED.has(name)) return new Response('Bad name', { status: 400 })
      // A machine that connects again takes the place of its old socket.
      for (const old of this.ctx.getWebSockets(`m:${name}`)) { this.dropMachine(name); old.close(1012, 'Connected again') }
      const [client, server] = Object.values(new WebSocketPair())
      this.ctx.acceptWebSocket(server, ['m', `m:${name}`])
      return new Response(null, { status: 101, webSocket: client })
    }
    if (!this.signedIn(req)) return page('Codinger', '<p>Sign in to see your machines.</p>', 401)
    const names = this.ctx.getWebSockets('m').map((ws) => this.ctx.getTags(ws).find((t) => t.startsWith('m:'))!.slice(2)).sort()
    const p = port(url)
    const list = names.length
      ? `<ul>${names.map((n) => `<li><a href="//${esc(n)}.${esc(this.env.BASE_HOST)}${p}/">${esc(n)}</a></li>`).join('')}</ul>`
      : '<p>No machine is connected.</p>'
    return page('Your machines', list)
  }

  private signedIn(req: Request): boolean {
    const t = this.env.DEV_TOKEN
    return !!t && cookie(req, COOKIE) === t
  }

  private machine(name: string): WebSocket | undefined {
    return this.ctx.getWebSockets(`m:${name}`)[0]
  }

  // ---- HTTP through the machine ---------------------------------------------

  private async request(req: Request, url: URL, machine: WebSocket): Promise<Response> {
    const id = crypto.randomUUID()
    const headers: Record<string, string> = {}
    for (const h of REQ_HEADERS) { const v = req.headers.get(h); if (v) headers[h] = v }
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : toBase64(new Uint8Array(await req.arrayBuffer()))
    const res = await new Promise<Extract<MachineMsg, { t: 'res' }> | null>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null) }, TIMEOUT_MS)
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m) })
      send(machine, { t: 'req', id, method: req.method, path: url.pathname + url.search, headers, ...(body ? { body } : {}) })
    })
    if (!res) return new Response('The machine did not answer in time.', { status: 504 })
    const out = new Headers()
    for (const h of RES_HEADERS) if (res.headers[h]) out.set(h, res.headers[h])
    return new Response(req.method === 'HEAD' ? null : fromBase64(res.body), { status: res.status, headers: out })
  }

  // ---- WebSockets through the machine ---------------------------------------

  private channel(req: Request, url: URL, name: string, machine: WebSocket): Response {
    const chan = crypto.randomUUID()
    const protocols = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server, ['b', `b:${name}`, `c:${chan}`])
    send(machine, { t: 'open', chan, path: url.pathname + url.search, protocols })
    return new Response(null, { status: 101, webSocket: client, headers: protocols[0] ? { 'sec-websocket-protocol': protocols[0] } : {} })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const tags = this.ctx.getTags(ws)
    const data = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    if (tags[0] === 'm') {
      let m: MachineMsg
      try { m = JSON.parse(data) } catch { return }
      if (m.t === 'res') { this.pending.get(m.id)?.(m); this.pending.delete(m.id) }
      else if (m.t === 'msgs') for (const b of this.ctx.getWebSockets(`c:${m.chan}`)) for (const d of m.data) b.send(d)
      else if (m.t === 'close') for (const b of this.ctx.getWebSockets(`c:${m.chan}`)) b.close(1000, 'Closed')
      return
    }
    // A browser: on to its machine.
    const name = tags.find((t) => t.startsWith('b:'))!.slice(2)
    const chan = tags.find((t) => t.startsWith('c:'))!.slice(2)
    const machine = this.machine(name)
    if (machine) send(machine, { t: 'msg', chan, data })
    else ws.close(1011, 'The machine went away')
  }

  async webSocketClose(ws: WebSocket) {
    try { ws.close(1000, 'Closed') } catch { /* closed */ }
    const tags = this.ctx.getTags(ws)
    if (tags[0] === 'm') return this.dropMachine(tags[1].slice(2))
    const name = tags.find((t) => t.startsWith('b:'))!.slice(2)
    const chan = tags.find((t) => t.startsWith('c:'))!.slice(2)
    const machine = this.machine(name)
    if (machine) send(machine, { t: 'close', chan })
  }

  async webSocketError(ws: WebSocket) { await this.webSocketClose(ws) }

  // A machine went: so do the browsers on it.
  private dropMachine(name: string) {
    for (const b of this.ctx.getWebSockets(`b:${name}`)) try { b.close(1011, 'The machine went away') } catch { /* closed */ }
  }
}

// ---- helpers -----------------------------------------------------------------

const send = (ws: WebSocket, m: HubMsg) => { try { ws.send(JSON.stringify(m)) } catch { /* gone */ } }
const port = (url: URL) => url.port ? `:${url.port}` : ''
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const cookie = (req: Request, name: string) => req.headers.get('cookie')?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1)

function toBase64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}
function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}a{color:#0b6bcb}</style>
<h1>${esc(title)}</h1>${body}`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}
