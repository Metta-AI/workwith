// The Prolifica account artifacts are published with (prolifica.app). Codinger
// connects the standard way: it registers itself as an OAuth client (one per
// redirect address), the user approves it once in the browser, and the tokens
// are kept in ~/.codinger/prolifica.json and refreshed as they expire.

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { DATA } from './store.ts'
import type { ProlificaState } from '../shared/artifacts.ts'

export const ORIGIN = (process.env.PROLIFICA_ORIGIN ?? 'https://prolifica.app').replace(/\/$/, '')
const FILE = path.join(DATA, 'prolifica.json')

type Conn = {
  origin: string; clientId: string; redirectUri: string
  access?: string; refresh?: string; expires?: number; handle?: string | null
}

let conn: Conn | null = (() => {
  try { const c = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Conn; return c.origin === ORIGIN ? c : null } catch { return null }
})()
const save = () => fs.writeFileSync(FILE, JSON.stringify(conn, null, 2), { mode: 0o600 })

export function prolificaState(): ProlificaState {
  return conn?.access ? { handle: conn.handle ?? null, origin: ORIGIN } : null
}

// Started connections, by their state parameter, until the browser comes back.
const pending = new Map<string, { verifier: string; redirectUri: string; at: number }>()
const b64url = (b: Buffer) => b.toString('base64url')

// The address to open in the browser to approve Codinger.
export async function connectUrl(redirectUri: string): Promise<string> {
  if (!conn || conn.redirectUri !== redirectUri) {
    const r = await fetch(`${ORIGIN}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Codinger', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      }),
    })
    if (!r.ok) throw new Error(`Prolifica refused to register Codinger: ${r.status} ${await r.text()}`)
    conn = { origin: ORIGIN, clientId: (await r.json()).client_id, redirectUri }
    save()
  }
  const verifier = b64url(randomBytes(32)), state = b64url(randomBytes(16))
  for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60_000) pending.delete(k)
  pending.set(state, { verifier, redirectUri, at: Date.now() })
  const q = new URLSearchParams({
    response_type: 'code', client_id: conn.clientId, redirect_uri: redirectUri, state, scope: 'prolifica',
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: `${ORIGIN}/mcp`,
  })
  return `${ORIGIN}/authorize?${q}`
}

async function tokens(body: Record<string, string>) {
  const r = await fetch(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
  const j = await r.json().catch(() => ({})) as any
  if (!r.ok || !j.access_token) throw new Error(`Prolifica gave no token: ${j.error_description ?? j.error ?? r.status}`)
  Object.assign(conn!, { access: j.access_token, refresh: j.refresh_token ?? conn!.refresh, expires: Date.now() + (j.expires_in ?? 3600) * 1000 })
  save()
}

// The browser came back from approving (or declining): finish the connection.
export async function connectCallback(url: URL): Promise<void> {
  const p = pending.get(url.searchParams.get('state') ?? '')
  if (!p || !conn) throw new Error('This connection was not started here, or it is too old. Start it again from Codinger.')
  pending.delete(url.searchParams.get('state')!)
  if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error_description') ?? 'You declined.')
  await tokens({ grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: p.redirectUri, client_id: conn.clientId, code_verifier: p.verifier, resource: `${ORIGIN}/mcp` })
  const me = await call('/api/me').catch(() => null) as { handle?: string | null } | null
  conn.handle = me?.handle ?? null
  save()
}

export function disconnect() {
  if (conn) { delete conn.access; delete conn.refresh; delete conn.expires; delete conn.handle; save() }
}

// Node's fetch says only "fetch failed"; what went wrong (a reset connection, a timeout, a name
// that did not resolve) is in its cause. Say that, and which request it was.
function failed(p: string, init: RequestInit, e: any): Error {
  const c = e?.cause, why = c ? [c.code, c.message].filter(Boolean).join(': ') : ''
  const size = init.body instanceof Uint8Array ? ` (${(init.body.length / 1048576).toFixed(1)} MB)` : ''
  return new Error(`Prolifica ${init.method ?? 'GET'} ${p.split('?')[0]}${size}: ${e?.message ?? e}${why ? ` (${why})` : ''}`, { cause: e })
}

// A request to Prolifica's API as the connected person. JSON comes back parsed.
// onSent: called as the body goes out, with the bytes sent so far (a body of bytes only).
export async function call(p: string, init: RequestInit = {}, onSent?: (sent: number) => void): Promise<any> {
  const text = await (await request(p, init, onSent)).text()
  try { return JSON.parse(text) } catch { return text }
}

// A file on Prolifica as it is stored there, byte for byte (call() would parse it).
export async function bytes(p: string): Promise<Buffer> {
  return Buffer.from(await (await request(p)).arrayBuffer())
}

// Cloudflare can close a kept-alive connection before it passes the request on to Prolifica,
// which then never sees it. curl and browsers send the request again on a new connection; Node's
// fetch does not. Sent again here, after a moment (the other connections it closed are let go of
// by then), when the request does the same if it arrives twice: not a new page, or a squash.
const CLOSED = new Set(['UND_ERR_SOCKET', 'EPIPE', 'ECONNRESET'])
const twiceSafe = (p: string, init: RequestInit) => (init.method ?? 'GET').toUpperCase() !== 'POST' || p.startsWith('/api/data?')

// A body of bytes as a stream, in parts of 64 KB, that says how much of it went out. A stream
// is read once: each try makes a new one.
function counted(b: Uint8Array, onSent: (sent: number) => void): ReadableStream<Uint8Array> {
  let at = 0
  onSent(0)
  return new ReadableStream({
    pull(c) {
      if (at >= b.length) return c.close()
      const end = Math.min(at + 65536, b.length)
      c.enqueue(b.subarray(at, end))
      onSent(at = end)
    },
  })
}

async function request(p: string, init: RequestInit = {}, onSent?: (sent: number) => void): Promise<Response> {
  if (!conn?.access) throw new Error('Codinger is not connected to Prolifica.')
  const b = onSent && init.body instanceof Uint8Array ? init.body : null
  const go = async () => {
    for (let tries = 1; ; tries++) {
      try {
        const headers: Record<string, string> = { ...init.headers as Record<string, string>, authorization: `Bearer ${conn!.access}` }
        // With a length, Node sends the stream as one body, not in chunks.
        if (b) headers['content-length'] = String(b.length)
        return await fetch(`${ORIGIN}${p}`, { ...init, headers, ...(b && { body: counted(b, onSent!), duplex: 'half' }) } as RequestInit)
      } catch (e: any) {
        if (tries === 3 || !CLOSED.has(e?.cause?.code) || !twiceSafe(p, init)) throw failed(p, init, e)
        // How often Prolifica's connection closes, and for which requests: in ~/.codinger/server.log.
        console.log(`[prolifica] try ${tries} failed, sending again: ${failed(p, init, e).message}`)
        await new Promise((r) => setTimeout(r, 250))
      }
    }
  }
  if (conn.expires && conn.expires - Date.now() < 60_000 && conn.refresh) await tokens({ grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: conn.clientId }).catch(() => {})
  let r = await go()
  if (r.status === 401 && conn.refresh) {
    try { await tokens({ grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: conn.clientId }) } catch { disconnect(); throw new Error('The connection to Prolifica expired. Connect again.') }
    r = await go()
  }
  if (r.ok) return r
  const text = await r.text()
  let j: any = text
  try { j = JSON.parse(text) } catch { /* not JSON */ }
  throw Object.assign(new Error(`Prolifica: ${j?.error ?? text ?? r.status}`), { status: r.status })
}
