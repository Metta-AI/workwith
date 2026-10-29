// Codinger as one agent's desk, on the agent's own host behind a proxy that signs
// people in (deploy/README.md). All of it is off unless the environment asks:
//
//   CODINGER_AGENT_NAME     the agent's name: the sidebar, the tab, "Message Ada"
//   CODINGER_AGENT_AVATAR   an image file: its face in the sidebar
//   CODINGER_AGENT_CSS      a CSS file that sets its colours (no theme prompt then)
//   CODINGER_AGENT_COLOR    the colour of the installed app's title bar, e.g. #0f4a44
//   CODINGER_USER_HEADER    the header the proxy names the signed-in person in
//   CODINGER_PEOPLE         names to show: "ada@example.com=Ada,grace@example.com=Grace"
//                           (otherwise the login before the @, capitalised)
//   CODINGER_ASK_NAME       1: a browser that the proxy names nobody in asks its person for a
//                           name and keeps it (cookie codinger.name). Nothing checks that name:
//                           only for a page that people reach without a sign-in, e.g. a tunnel
//   CODINGER_BILLING        api: show API spend, not plan limits (Bedrock and Vertex need not say)
//   CODINGER_NO_SHELL       (server/index.ts) 1: no shell commands, for a page open to strangers
//   CODINGER_HOSTS          (server/index.ts) may hold "*.trycloudflare.com" for such a tunnel
//   CODINGER_SUPERVISED     (server/index.ts) 1: a restart only stops this server, and the
//                           supervisor (systemd, launchd) starts the next one

import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'
import type { AgentInfo, Person } from '../shared/types.ts'

const env = process.env
// Codinger was called Codiner until October 2026; the old names (CODINER_*) still work.
export const desk = (key: string): string | undefined => env[`CODINGER_${key}`] ?? env[`CODINER_${key}`]
const existing = (file: string | undefined) => file && fs.existsSync(file) ? file : null
const NAME = desk('AGENT_NAME')
const AVATAR = existing(desk('AGENT_AVATAR'))
const AVATAR_TYPE = AVATAR ? { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[path.extname(AVATAR).toLowerCase()] ?? 'application/octet-stream' : ''
const THEME = existing(desk('AGENT_CSS'))

export const ASK_NAME = desk('ASK_NAME') === '1'

export const agentInfo = (): AgentInfo | undefined =>
  NAME ? { name: NAME, avatar: !!AVATAR, theme: !!THEME } : undefined

// Claude Code on Bedrock or Vertex bills each token; there is no plan with limits to show.
export const billing = (): 'api' | 'plan' =>
  env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || desk('BILLING') === 'api' ? 'api' : 'plan'

const NAMES = new Map((desk('PEOPLE') ?? '').split(',').flatMap((x) => {
  const at = x.indexOf('=')
  return at > 0 ? [[x.slice(0, at).trim().toLowerCase(), x.slice(at + 1).trim()] as [string, string]] : []
}))
const HEADER = desk('USER_HEADER')?.toLowerCase()

export function nameOf(login: string): string {
  const named = NAMES.get(login.toLowerCase())
  if (named) return named
  const local = login.split('@')[0].split(/[._-]/)[0]
  return local ? local[0].toUpperCase() + local.slice(1) : login
}

// The person behind a request, as the proxy names them; null when Codinger can't tell.
// The proxy's word comes first; a name the browser gave (CODINGER_ASK_NAME) only fills in.
export function personOf(req: http.IncomingMessage): Person | null {
  const raw = HEADER ? req.headers[HEADER] : undefined
  const login = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  if (login) return { login, name: nameOf(login) }
  return ASK_NAME ? guestOf(req) : null
}

function guestOf(req: http.IncomingMessage): Person | null {
  const m = /(?:^|;\s*)codinger\.name=([^;]*)/.exec(req.headers.cookie ?? '') ?? /(?:^|;\s*)codiner\.name=([^;]*)/.exec(req.headers.cookie ?? '')
  let name = ''
  try { name = m ? decodeURIComponent(m[1]) : '' } catch { /* a broken cookie: no name */ }
  name = name.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40)
  return name ? { login: `guest:${name.toLowerCase()}`, name, guest: true } : null
}

// The avatar's size in pixels, for the manifest (PNG only; others say "any").
function iconSize(file: string): string {
  try {
    const b = fs.readFileSync(file).subarray(0, 24)
    if (b.toString('latin1', 1, 4) === 'PNG') return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`
  } catch { /* fall through */ }
  return 'any'
}

// What makes the page installable as an app: the agent's name and its face as the icon.
function manifest() {
  const name = NAME ?? 'Codinger'
  const color = desk('AGENT_COLOR') ?? '#1d1c1a'
  return {
    name: NAME ? `Work with ${name}` : name, short_name: name,
    start_url: '/', scope: '/', display: 'standalone', background_color: color, theme_color: color,
    icons: AVATAR ? [{ src: '/agent/avatar', sizes: iconSize(AVATAR), type: AVATAR_TYPE, purpose: 'any' }] : [],
  }
}

// /agent/theme.css, /agent/avatar and /manifest.webmanifest. The theme is always there
// (empty without a file), so index.html can link it before the page draws.
export function serveAgent(pathname: string, res: http.ServerResponse): boolean {
  if (pathname === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' })
    res.end(JSON.stringify(manifest()))
    return true
  }
  if (pathname === '/agent/theme.css') {
    res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-cache' })
    res.end(THEME ? fs.readFileSync(THEME) : '')
    return true
  }
  if (pathname === '/agent/avatar' && AVATAR) {
    res.writeHead(200, { 'content-type': AVATAR_TYPE, 'cache-control': 'max-age=3600' })
    fs.createReadStream(AVATAR).pipe(res)
    return true
  }
  return false
}
