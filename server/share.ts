// A session's transcript, published read-only to web.codinger.app/s/<id> (shared/share.ts).
// What goes is chosen here, on this machine: by default the messages, and each tool call as
// one line without its output. Things that look like keys are hidden, and the home folder
// shows as ~. The hub (remote/) keeps it with the images and files it shows; anyone with
// the link can read it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Block, Event, SessionMeta, Settings } from '../shared/types.ts'
import { SHARE_FILE, SHARE_FILE_MAX, type Found, type Published, type Share, type ShareOpts, type SharePreview } from '../shared/share.ts'
import { mediaType } from '../shared/media.ts'
import { IMAGES, MEDIA } from './store.ts'
import { hubAuth } from './remote.ts'

const MAIL = new Set(['mcp__codinger__send_message', 'mcp__codinger__reply', 'mcp__codinger__spawn_session', 'mcp__codinger__stop_session'])
const SHOW_FILE = 'mcp__codinger__show_file'
const START_TASK = 'mcp__codinger__start_task'

const firstLine = (v: unknown, max = 300) => typeof v === 'string' ? v.split('\n')[0].slice(0, max) : undefined

// What a tool call's line shows (web/src/components/Transcript.tsx: summary), and no more.
// Messages to other sessions show in full: they are messages.
function lineInput(name: string, input: any): any {
  const i = input ?? {}
  const pick = (...keys: string[]) => Object.fromEntries(keys.filter((k) => i[k] != null).map((k) => [k, i[k]]))
  if (MAIL.has(name)) return pick('to', 'id', 'title', 'message', 'prompt', 'message_id')
  if (name === SHOW_FILE) return pick('path', 'caption')
  if (name === 'mcp__codinger__show_artifact') return pick('name', 'url')
  if (name === START_TASK) return { title: firstLine(i.title), command: firstLine(i.command), notify: i.notify }
  if (name === 'Bash') return { command: firstLine(i.command) }
  if (typeof i.file_path === 'string') return { file_path: i.file_path }
  for (const k of ['pattern', 'url', 'query', 'description']) if (typeof i[k] === 'string') return { [k]: firstLine(i[k]) }
  return {}
}

// Codinger's own tools say on their first line what they did (a task's id, the file shown);
// other output goes.
function lineResult(name: string, text: string): string {
  if (!name.startsWith('mcp__codinger__')) return ''
  const url = name === SHOW_FILE ? /^url: \S+$/m.exec(text)?.[0] : undefined
  return [firstLine(text, 400), url].filter(Boolean).join('\n')
}

function pick(events: Event[], opts: ShareOpts): Event[] {
  const full = opts.tools === 'full'
  const names = new Map<string, string>()
  const resolved = new Set<string>()
  for (const e of events) {
    if (e.t === 'assistant') for (const b of e.blocks) if (b.type === 'tool_use') names.set(b.id, b.name)
    if (e.t === 'permission_resolved') resolved.add(e.requestId)
  }
  const out: Event[] = []
  for (const e of events) {
    switch (e.t) {
      case 'assistant': {
        const blocks = e.blocks.flatMap((b): Block[] =>
          b.type === 'thinking' ? (opts.thinking && b.text.trim() ? [b] : [])
          : b.type === 'tool_use' && !full ? [{ ...b, input: lineInput(b.name, b.input) }]
          : [b])
        if (blocks.length) out.push({ ...e, blocks })
        break
      }
      case 'tool_result':
        out.push(full ? e : { ...e, text: lineResult(names.get(e.toolUseId) ?? '', e.text) })
        break
      // A request still waiting means nothing to a reader.
      case 'permission':
        if (resolved.has(e.requestId)) out.push(full ? e : { ...e, input: lineInput(e.toolName, e.input) })
        break
      default: out.push(e)
    }
  }
  return out
}

// ---- secrets ---------------------------------------------------------------------

const SECRETS: [string, RegExp][] = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['Anthropic key', /\bsk-ant-[\w-]{20,}/g],
  ['API key', /\bsk-(?:proj-)?[\w-]{20,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{40,})/g],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[abprs]-[\w-]{10,}/g],
  ['Google key', /\bAIza[\w-]{35}/g],
  ['Stripe key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ['JWT', /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g],
  ['bearer token', /(?<=\bBearer\s+)[\w.~+/-]{20,}=*/g],
  // A value given to a name like API_KEY, token or password: one with a digit, so code (process.env.X) stays.
  ['secret value', /(?<=(?:api[_-]?key|secret|token|passw(?:or)?d)[\w-]*["']?\s*[:=]\s*["']?)(?=[\w.~+/-]*\d)[\w.~+/-]{16,}/gi],
  ['email address', /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g],
]
const HIDDEN = '[hidden]'

// Where in the transcript a string is, for the list of what the scan found.
function whereOf(e: Event, key: string): string {
  if (e.t === 'user') return 'your messages'
  if (e.t === 'tool_result') return 'tool output'
  if (e.t === 'permission') return 'tool calls'
  if (e.t === 'assistant') return key === 'thinking' ? 'thinking' : key === 'tool_use' ? 'tool calls' : "the agent's messages"
  return 'notices'
}

function scrub(events: Event[], redact: boolean): { events: Event[]; found: Found[] } {
  const found = new Map<string, Found>()
  const home = os.homedir()
  const clean = (s: string, where: string): string => {
    let out = s
    for (const [kind, re] of SECRETS) out = out.replace(re, (m) => {
      const sample = m.length > 8 ? `${m.slice(0, 4)}…` : '…'
      const k = `${kind}\0${sample}\0${where}`
      const f = found.get(k) ?? { kind, sample, where, n: 0 }
      f.n++
      found.set(k, f)
      return HIDDEN
    })
    if (!redact) return s
    return home.length > 1 ? out.split(home).join('~') : out
  }
  const walk = (v: any, where: string): any =>
    typeof v === 'string' ? clean(v, where)
    : Array.isArray(v) ? v.map((x) => walk(x, where))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, where)]))
    : v
  const out = events.map((e): Event => {
    if (e.t !== 'assistant') return walk(e, whereOf(e, ''))
    return { ...e, blocks: e.blocks.map((b) => walk(b, whereOf(e, b.type))) }
  })
  return { events: out, found: [...found.values()] }
}

// ---- files ---------------------------------------------------------------------------

const FILE_URL = /\/api\/(images|media)\/([0-9a-f]{24}\.[a-z0-9]{1,8})/g

function filesOf(events: Event[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of JSON.stringify(events).matchAll(FILE_URL)) out.set(m[2], path.join(m[1] === 'images' ? IMAGES : MEDIA, m[2]))
  return out
}

// ---- building and publishing ---------------------------------------------------------

export function buildShare(meta: SessionMeta, events: Event[], settings: Settings, opts: ShareOpts): SharePreview & { paths: Map<string, string> } {
  const { events: kept, found } = scrub(pick(events, opts), opts.redact)
  const files: string[] = [], skipped: SharePreview['skipped'] = [], paths = new Map<string, string>()
  let bytes = 0
  for (const [name, file] of filesOf(kept)) {
    let size: number
    try { size = fs.statSync(file).size } catch { continue }
    if (size > SHARE_FILE_MAX) { skipped.push({ name, size }); continue }
    files.push(name)
    paths.set(name, file)
    bytes += size
  }
  const a = settings.appearance
  const share: Share = {
    v: 1, title: meta.title, at: Date.now(), opts, events: kept, files,
    ...(a?.accent ? { accent: a.accent } : {}), ...(a?.surface ? { surface: a.surface } : {}), ...(a?.font ? { font: a.font } : {}),
  }
  bytes += JSON.stringify(share).length
  return { share, found, skipped, bytes, paths }
}

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const newId = () => Array.from(randomBytes(16), (b) => ID_CHARS[b % 62]).join('')

function hub() {
  const auth = hubAuth()
  if (!auth) throw new Error('Connect this machine to web.codinger.app first (Settings, Remote access).')
  return auth
}

async function call(id: string, sub: string, init: RequestInit = {}): Promise<Response> {
  const { hub: base, token } = hub()
  const r = await fetch(`${base}/_remote/shares/${id}${sub}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } })
    .catch((e: Error & { cause?: Error }) => { throw new Error(`Could not reach ${base}: ${e.cause?.message ?? e.message}`) })
  if (!r.ok && r.status !== 404) throw new Error(`${base} answered ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r
}

// Publish, or publish again at the same link: the files the hub has stay, the rest go up first,
// then the transcript, which drops the files it no longer shows.
export async function publishShare(meta: SessionMeta, events: Event[], settings: Settings, opts: ShareOpts): Promise<Published> {
  const { hub: base } = hub()
  const id = meta.share?.id ?? newId()
  const { share, paths } = buildShare(meta, events, settings, opts)
  const was = await call(id, '')
  const have = new Set(was.ok ? ((await was.json()) as { files: string[] }).files : [])
  for (const name of share.files) {
    if (have.has(name) || !SHARE_FILE.test(name)) continue
    const r = await call(id, `/f/${name}`, { method: 'PUT', headers: { 'content-type': mediaType(name) }, body: fs.readFileSync(paths.get(name)!) })
    if (!r.ok) throw new Error(`The hub did not take ${name} (${r.status})`)
  }
  const r = await call(id, '', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(share) })
  if (!r.ok) throw new Error(`The hub did not take the transcript (${r.status})`)
  return { id, url: `${base}/s/${id}`, at: share.at, opts }
}

export async function unpublishShare(p: Published): Promise<void> {
  await call(p.id, '', { method: 'DELETE' })
}
