// Codiner as one agent's desk, on the agent's own host behind a proxy that signs
// people in (deploy/README.md). All of it is off unless the environment asks:
//
//   CODINER_AGENT_NAME     the agent's name: the sidebar, the tab, "Message Synth"
//   CODINER_AGENT_AVATAR   an image file: its face in the sidebar
//   CODINER_AGENT_CSS      a CSS file loaded after Codiner's own: its colours (no theme prompt then)
//   CODINER_USER_HEADER    the header the proxy names the signed-in person in
//   CODINER_PEOPLE         names to show: "ada@example.com=Ada,grace@example.com=Grace"
//                          (otherwise the login before the @, capitalised)

import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'
import type { AgentInfo, Person } from '../shared/types.ts'

const env = process.env
const AVATAR = env.CODINER_AGENT_AVATAR && fs.existsSync(env.CODINER_AGENT_AVATAR) ? env.CODINER_AGENT_AVATAR : null
const THEME = env.CODINER_AGENT_CSS && fs.existsSync(env.CODINER_AGENT_CSS) ? env.CODINER_AGENT_CSS : null

export const agentInfo = (): AgentInfo | undefined =>
  env.CODINER_AGENT_NAME ? { name: env.CODINER_AGENT_NAME, avatar: !!AVATAR, theme: !!THEME } : undefined

// Claude Code on Bedrock or Vertex bills each token; there is no plan with limits to show.
export const billing = (): 'api' | 'plan' =>
  env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CODINER_BILLING === 'api' ? 'api' : 'plan'

const NAMES = new Map((env.CODINER_PEOPLE ?? '').split(',').flatMap((x) => {
  const at = x.indexOf('=')
  return at > 0 ? [[x.slice(0, at).trim().toLowerCase(), x.slice(at + 1).trim()] as [string, string]] : []
}))
const HEADER = env.CODINER_USER_HEADER?.toLowerCase()

export function nameOf(login: string): string {
  const named = NAMES.get(login.toLowerCase())
  if (named) return named
  const local = login.split('@')[0].split(/[._-]/)[0]
  return local ? local[0].toUpperCase() + local.slice(1) : login
}

// The person behind a request, as the proxy names them; null when Codiner can't tell.
export function personOf(req: http.IncomingMessage): Person | null {
  if (!HEADER) return null
  const raw = req.headers[HEADER]
  const login = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  return login ? { login, name: nameOf(login) } : null
}

// /agent/theme.css and /agent/avatar. The theme is always there (empty without a
// file), so index.html can link it before the page draws.
export function serveAgent(pathname: string, res: http.ServerResponse): boolean {
  if (pathname === '/agent/theme.css') {
    res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-cache' })
    res.end(THEME ? fs.readFileSync(THEME) : '')
    return true
  }
  if (pathname === '/agent/avatar' && AVATAR) {
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[path.extname(AVATAR).toLowerCase()]
    res.writeHead(200, { 'content-type': type ?? 'application/octet-stream', 'cache-control': 'max-age=3600' })
    fs.createReadStream(AVATAR).pipe(res)
    return true
  }
  return false
}
