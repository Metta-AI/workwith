// Codinger as one agent's desk, on the agent's own host behind a proxy that signs
// people in (deploy/README.md). All of it is off unless the environment asks:
//
//   CODINGER_AGENT_NAME     the agent's name: the sidebar, the tab, "Message Ada"
//   CODINGER_AGENT_AVATAR   an image file: its face in the sidebar
//   CODINGER_AGENT_CSS      a CSS file that sets its colours (no theme prompt then)
//   CODINGER_AGENT_COLOR    the colour of the installed app's title bar, e.g. #0f4a44
//   CODINGER_AGENT_ABOUT    one line on what the agent is for: the page's description in link previews
//                           (smaller copies of the avatar, <name>-32.png, -64, -180, -512 next to
//                           it, serve as the tab icon and preview image; the avatar stands in otherwise)
//   CODINGER_AGENT_CWD      the agent's own folder: "+ New session" starts a session there at
//                           once, with no dialog (people at a desk have no other folder to pick)
//   CODINGER_USER_HEADER    the header the proxy names the signed-in person in
//   CODINGER_PEOPLE         names to show: "ada@example.com=Ada,grace@example.com=Grace"
//                           (otherwise the login before the @, capitalised)
//   CODINGER_ASK_NAME       1: a browser that the proxy names nobody in asks its person for a
//                           name and keeps it (cookie codinger.name). Nothing checks that name:
//                           only for a page that people reach without a sign-in, e.g. a tunnel
//   CODINGER_BILLING        api: show API spend, not plan limits (Bedrock and Vertex need not say).
//                           fallback: sessions run on the Claude Code login's plan, and on the
//                           Bedrock/Vertex the environment sets up only while there is no login
//                           or the plan's limit is reached (server/billing.ts)
//   CODINGER_ALERT_CMD      (server/billing.ts) a shell command run when sessions go to per-token
//                           billing, with the reason in CODINGER_ALERT_TEXT
//   CODINGER_NO_SHELL       (server/index.ts) 1: no shell commands, for a page open to strangers
//   CODINGER_HOSTS          (server/index.ts) may hold "*.trycloudflare.com" for such a tunnel
//   CODINGER_SUPERVISED     (server/index.ts) 1: a restart only stops this server, and the
//                           supervisor (systemd, launchd) starts the next one
//   CODINGER_BASE           the path the proxy serves Codinger under and passes on unchanged,
//                           e.g. /desk/ada (no trailing slash); unset, the root (server/base.ts)

import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'
import { billingState } from './billing.ts'
import type { AgentInfo, Person } from '../shared/types.ts'
import { parseBase } from './base.ts'

const env = process.env
// Codinger was called Codiner until October 2026; the old names (CODINER_*) still work.
export const desk = (key: string): string | undefined => env[`CODINGER_${key}`] ?? env[`CODINER_${key}`]
const existing = (file: string | undefined) => file && fs.existsSync(file) ? file : null
const NAME = desk('AGENT_NAME')
const AVATAR = existing(desk('AGENT_AVATAR'))
const AVATAR_TYPE = AVATAR ? { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[path.extname(AVATAR).toLowerCase()] ?? 'application/octet-stream' : ''
const THEME = existing(desk('AGENT_CSS'))
const CWD = desk('AGENT_CWD') || undefined
const ABOUT = desk('AGENT_ABOUT')?.trim() || undefined
const ICON_SIZES = new Set(['32', '64', '180', '512'])

export const ASK_NAME = desk('ASK_NAME') === '1'
export const BASE = parseBase(desk('BASE'))

export const agentInfo = (): AgentInfo | undefined =>
  NAME ? { name: NAME, avatar: !!AVATAR, theme: !!THEME, ...(CWD ? { cwd: CWD } : {}) } : undefined

// Claude Code on Bedrock or Vertex bills each token; there is no plan with limits to show.
// CODINGER_BILLING=fallback: the plan, and the provider only while the plan can't (server/billing.ts).
export const billing = (): 'api' | 'plan' =>
  desk('BILLING') === 'api' ? 'api' : billingState().on

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
    start_url: `${BASE}/`, scope: `${BASE}/`, display: 'standalone', background_color: color, theme_color: color,
    icons: AVATAR ? [{ src: `${BASE}/agent/avatar`, sizes: iconSize(AVATAR), type: AVATAR_TYPE, purpose: 'any' }] : [],
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
  const icon = /^\/agent\/icon-(\d+)\.png$/.exec(pathname)
  if (icon && AVATAR && ICON_SIZES.has(icon[1])) {
    // A smaller copy next to the avatar when there is one (avatar-32.png); else the avatar itself.
    const sized = path.join(path.dirname(AVATAR), `${path.basename(AVATAR, path.extname(AVATAR))}-${icon[1]}.png`)
    const file = fs.existsSync(sized) ? sized : AVATAR
    res.writeHead(200, { 'content-type': file === sized ? 'image/png' : AVATAR_TYPE, 'cache-control': 'max-age=3600' })
    fs.createReadStream(file).pipe(res)
    return true
  }
  if (pathname === '/agent/avatar' && AVATAR) {
    res.writeHead(200, { 'content-type': AVATAR_TYPE, 'cache-control': 'max-age=3600' })
    fs.createReadStream(AVATAR).pipe(res)
    return true
  }
  return false
}

const attr = (s: string) => s.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]!)

// An agent's desk page names the agent everywhere a page is shown without being opened: the tab
// and home-screen icon (its face, not Codinger's) and the link-preview tags that chat apps read.
// origin is where the browser reached this page (https://host), for the preview's absolute URLs.
export function agentPage(html: string, origin: string): string {
  if (!NAME) return html
  const name = attr(NAME)
  const about = attr(ABOUT ?? `${NAME}'s desk: work with ${NAME} here.`)
  html = html.replace('<title>Codinger</title>', `<title>Work with ${name}</title>`)
    .replace('<meta name="apple-mobile-web-app-title" content="Codinger" />', `<meta name="apple-mobile-web-app-title" content="${name}" />`)
  const color = desk('AGENT_COLOR')
  if (color) html = html.replace('<meta name="theme-color" content="#1d1c1a" />', `<meta name="theme-color" content="${attr(color)}" />`)
  const tags = [
    `<meta name="description" content="${about}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:site_name" content="${name}" />`,
    `<meta property="og:title" content="Work with ${name}" />`,
    `<meta property="og:description" content="${about}" />`,
    `<meta property="og:url" content="${attr(`${origin}${BASE}/`)}" />`,
  ]
  if (AVATAR) {
    html = html.replace(/<link rel="icon" href="data:image\/svg\+xml,[^"]*" \/>/, '<link rel="icon" type="image/png" sizes="32x32" href="/agent/icon-32.png" />\n    <link rel="icon" type="image/png" sizes="64x64" href="/agent/icon-64.png" />')
      .replace('<link rel="apple-touch-icon" href="/agent/avatar" />', '<link rel="apple-touch-icon" sizes="180x180" href="/agent/icon-180.png" />')
    tags.push(`<meta property="og:image" content="${attr(`${origin}${BASE}/agent/icon-512.png`)}" />`, `<meta property="og:image:alt" content="${name}" />`)
  }
  return html.replace('</head>', `  ${tags.join('\n    ')}\n  </head>`)
}
