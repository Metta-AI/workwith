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

// A request to Prolifica's API as the connected person. JSON comes back parsed.
export async function call(p: string, init: RequestInit = {}): Promise<any> {
  if (!conn?.access) throw new Error('Codinger is not connected to Prolifica.')
  const go = () => fetch(`${ORIGIN}${p}`, { ...init, headers: { ...init.headers as Record<string, string>, authorization: `Bearer ${conn!.access}` } })
  if (conn.expires && conn.expires - Date.now() < 60_000 && conn.refresh) await tokens({ grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: conn.clientId }).catch(() => {})
  let r = await go()
  if (r.status === 401 && conn.refresh) {
    try { await tokens({ grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: conn.clientId }) } catch { disconnect(); throw new Error('The connection to Prolifica expired. Connect again.') }
    r = await go()
  }
  const text = await r.text()
  let j: any = text
  try { j = JSON.parse(text) } catch { /* not JSON */ }
  if (!r.ok) throw Object.assign(new Error(`Prolifica: ${j?.error ?? text ?? r.status}`), { status: r.status })
  return j
}
