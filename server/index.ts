// Codiner's server: owns the Claude Code processes, persists their transcripts,
// and serves the UI. Binds to 127.0.0.1 only and refuses cross-origin requests,
// since anything that can reach it can run Claude in your directories.
//
//   node server/index.ts          serve the built UI from dist/
//   node server/index.ts --dev    serve the UI through Vite, with hot reload

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Part, PermissionMode, ServerMsg, SessionMeta, Settings, Usage } from '../shared/types.ts'
import { execFile } from 'node:child_process'
import os from 'node:os'
import { Session, type Hooks, type Launch, type SlashCommand } from './session.ts'
import { findHistory, importTranscript, listDirs, listHistory } from './history.ts'
import { MASTER_PROMPT, WORKER_PROMPT, lookPrompt } from './prompts.ts'
import { LOOK_OPTIONS, LOOK_SLOTS, cleanLook, describeLook } from '../shared/looks.ts'
import { AGENTS_FILE, agentsPrompt, readAgentsMd, writeAgentsMd } from './agentsmd.ts'
import { handleMcp, type Tool } from './mcp.ts'
import {
  DATA, MASTER_DIR, appendEvent, deleteEvents, expandHome, imageFile, knownWindow, loadSessions, loadSettings, saveImage, saveSessions, saveSettings,
} from './store.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT ?? 4545)
const DEV = process.argv.includes('--dev')
const MCP_TOKEN = randomUUID()
const MASTER_ID = 'master'
const MODES: PermissionMode[] = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions']

// ---- state ----------------------------------------------------------------

const sessions = new Map<string, Session>()
let settings: Settings = loadSettings()
let usage: Usage = {}
const sockets = new Set<WebSocket>()
// Slash commands differ by directory (project skills), so keep each session's
// list, and the last one seen for sessions that haven't started yet.
const COMMANDS_FILE = path.join(DATA, 'commands.json')
const commands = new Map<string, SlashCommand[]>()
let lastCommands: SlashCommand[] = (() => { try { return JSON.parse(fs.readFileSync(COMMANDS_FILE, 'utf8')) } catch { return [] } })()

const metas = () => [...sessions.values()].map((s) => s.meta)
function broadcast(msg: ServerMsg) {
  const s = JSON.stringify(msg)
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(s)
}
let metaTimer: NodeJS.Timeout | null = null
function metaChanged() {
  saveSessions(metas)
  if (metaTimer) return
  metaTimer = setTimeout(() => { metaTimer = null; broadcast({ type: 'sessions', sessions: metas() }) }, 40)
}

const hooks: Hooks = {
  meta: metaChanged,
  event: (s, event) => { broadcast({ type: 'event', sessionId: s.meta.id, event }); metaChanged() },
  delta: (s, text, reset) => broadcast({ type: 'delta', sessionId: s.meta.id, text, reset }),
  truncate: (s, seq) => { broadcast({ type: 'truncate', sessionId: s.meta.id, seq }); metaChanged() },
  usage: (u) => { usage = u; broadcast({ type: 'usage', usage }) },
  commands: (s, list) => {
    commands.set(s.meta.id, list)
    if (s.meta.kind === 'worker') { lastCommands = list; fs.writeFile(COMMANDS_FILE, JSON.stringify(list), () => {}) }
  },
}

function launchFor(meta: SessionMeta): () => Launch {
  // Every session gets Codiner's set_look tool, pre-approved; workers keep their own MCP servers too.
  if (meta.kind === 'worker') return () => ({
    args: [
      '--mcp-config', JSON.stringify({ mcpServers: { codiner: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp/${MCP_TOKEN}/look/${meta.id}` } } }),
      '--allowedTools', 'mcp__codiner__set_look',
    ],
    prompt: WORKER_PROMPT + lookPrompt(meta.look) + agentsPrompt(),
  })
  return () => ({
    prompt: MASTER_PROMPT + lookPrompt(meta.look) + agentsPrompt(),
    args: [
      '--strict-mcp-config',
      '--mcp-config', JSON.stringify({ mcpServers: { codiner: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp/${MCP_TOKEN}` } } }),
      '--allowedTools', 'mcp__codiner',
      '--tools', 'Read,Write,Edit,Glob,Grep',
      '--autocompact', '200k',
    ],
  })
}

function adopt(meta: SessionMeta): Session {
  const s = new Session(meta, hooks, launchFor(meta))
  sessions.set(meta.id, s)
  return s
}

function newMeta(o: Partial<SessionMeta> & { cwd: string; title: string }): SessionMeta {
  const now = Date.now()
  return {
    id: randomUUID().slice(0, 8), kind: 'worker', parentId: null, model: null, permissionMode: 'auto',
    claudeSessionId: randomUUID(), started: false, createdAt: now, lastActivity: now, status: 'new',
    running: false, unread: false, compacting: false, context: { used: 0, window: knownWindow(o.model) }, pendingAsks: 0,
    lastText: '', error: null, archived: false, inbox: [], ...o,
  }
}

for (const m of loadSessions()) {
  const meta = { ...newMeta(m), ...m }
  // The window used to default to 200k until a turn finished; trust what the model reports.
  if (meta.context.window === 200_000 || meta.context.used > meta.context.window) meta.context.window = Math.max(knownWindow(meta.model), meta.context.used)
  adopt(meta)
}
if (!sessions.has(MASTER_ID)) {
  adopt(newMeta({ id: MASTER_ID, kind: 'master', title: 'Master', cwd: MASTER_DIR }))
  metaChanged()
}
// Auto mode became the default: move sessions still on the old defaults over, once.
if (!settings.autoModeMigrated) {
  for (const s of sessions.values()) if (s.meta.permissionMode === 'default' || (s.meta.kind === 'master' && s.meta.permissionMode === 'acceptEdits')) s.meta.permissionMode = 'auto'
  settings = { ...settings, autoModeMigrated: true }
  saveSettings(settings)
  metaChanged()
}

function get(id: string): Session {
  const s = sessions.get(id)
  if (!s) throw new HttpError(404, `No session ${id}`)
  return s
}

function createSession(o: { cwd: string; title?: string; model?: string | null; permissionMode?: PermissionMode; parentId?: string | null }): Session {
  const cwd = path.resolve(expandHome(String(o.cwd ?? '').trim()))
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new HttpError(400, `Not a directory: ${cwd}`)
  const mode = MODES.includes(o.permissionMode as PermissionMode) ? o.permissionMode! : 'auto'
  const s = adopt(newMeta({
    cwd, title: o.title?.trim() || path.basename(cwd), model: o.model || null, permissionMode: mode,
    parentId: o.parentId && sessions.has(o.parentId) ? o.parentId : null,
  }))
  metaChanged()
  return s
}

// Pick up a session from Claude Code's own history, conversation included.
function resumeHistory(claudeId: string): Session {
  const existing = [...sessions.values()].find((s) => s.meta.claudeSessionId === claudeId)
  if (existing) { if (existing.meta.archived) { existing.meta.archived = false; metaChanged() } return existing }
  const found = findHistory(claudeId)
  if (!found) throw new HttpError(404, 'No such Claude Code session')
  const { file, item } = found
  if (!fs.existsSync(item.cwd)) throw new HttpError(400, `Its directory no longer exists: ${item.cwd}`)
  const { events, contextUsed, model } = importTranscript(file)
  const meta = newMeta({ cwd: item.cwd, title: item.title, claudeSessionId: claudeId, started: true, model, lastActivity: item.mtime })
  meta.context.used = contextUsed
  meta.context.window = Math.max(knownWindow(model), contextUsed)
  meta.status = 'idle'
  for (const e of events) appendEvent(meta.id, e)
  const s = adopt(meta)
  s.notice(`Picked up from Claude Code history (${plural(events.filter((e) => e.t === "user").length, "message")}). Your next message continues this conversation.`)
  if (Date.now() - item.mtime < 3 * 60_000) s.notice('This session was active in the last few minutes. If it is still open in a terminal, close it there first, or both will write to the same conversation.', 'warn')
  metaChanged()
  return s
}

// What the master sees at the end of each message you send it.
function board(): string {
  const lines = metas().filter((m) => m.kind === 'worker' && !m.archived).map((m) => {
    const ctx = Math.round((m.context.used / (m.context.window || 1)) * 100)
    return `- ${m.id} "${m.title}" ${m.cwd} status=${m.status} ctx=${ctx}%${m.pendingAsks ? ` open_questions=${m.pendingAsks}` : ''}${m.parentId ? ` parent=${m.parentId}` : ''}${m.inbox.length ? ` drafts_waiting=${m.inbox.length}` : ''}`
  })
  return `<board>\n${lines.length ? lines.join('\n') : '(no worker sessions)'}\n</board>`
}

// ---- master tools -----------------------------------------------------------

function deliver(s: Session, text: string): string {
  if (settings.masterAutoSend) {
    s.send([{ kind: 'text', text }], { from: 'master' })
    return `Sent to ${s.meta.id}.`
  }
  s.meta.inbox.push({ id: randomUUID().slice(0, 8), text, from: 'master', ts: Date.now() })
  metaChanged()
  return `Held as a draft in ${s.meta.id}'s inbox; the user will review and send it (auto-send is off).`
}

// The critter's look, chosen by the Claude in that session.
function lookTool(id: string): Tool {
  return {
    name: 'set_look',
    description: 'Choose how your critter looks in the Codiner sidebar: its colour and what it wears. Give only the slots you want to set; "none" clears one. Pick once; there is no need to call it again.',
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(LOOK_SLOTS.map((s) => [s, { type: 'string', enum: [...LOOK_OPTIONS[s], 'none'] }])),
    },
    run: (args) => {
      const s = get(id)
      const { look, rejected } = cleanLook(args ?? {}, s.meta.look ?? {})
      s.meta.look = look
      metaChanged()
      return `Saved. You look like this: ${describeLook(look) || 'plain'}.${rejected.length ? ` Not known, so left out: ${rejected.join(', ')}.` : ''}`
    },
  }
}

const tools: Tool[] = [
  {
    name: 'list_sessions',
    description: 'List the worker sessions: id, title, directory, status, context use, open questions and the tail of the last thing Claude said in each.',
    inputSchema: { type: 'object', properties: { include_archived: { type: 'boolean' } } },
    run: ({ include_archived }) => metas().filter((m) => m.kind === 'worker' && (include_archived || !m.archived)).map((m) => ({
      id: m.id, title: m.title, cwd: m.cwd, parent: m.parentId, status: m.status,
      context: `${Math.round(m.context.used / 1000)}k of ${Math.round(m.context.window / 1000)}k`,
      open_questions: m.pendingAsks, drafts_waiting: m.inbox.length, last_said: m.lastText.slice(-240),
    })),
  },
  {
    name: 'read_session',
    description: 'Read a condensed plain-text transcript of the last few turns of a session. Costs context: keep max_chars small.',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: { id: { type: 'string' }, turns: { type: 'number', description: 'User turns to go back (default 1)' }, max_chars: { type: 'number', description: 'Default 3000' } },
    },
    run: ({ id, turns, max_chars }) => get(id).digest(Math.min(Number(max_chars) || 3000, 20000), Number(turns) || 1),
  },
  {
    name: 'send_to_session',
    description: 'Send a message to a worker session, written as if from the user. A message that is just a slash command (/compact, /model sonnet, /clear, /code-review, any skill) runs it, exactly as if typed at the claude prompt. Unless the user enabled auto-send, it is held as a draft for them to approve.',
    inputSchema: { type: 'object', required: ['id', 'message'], properties: { id: { type: 'string' }, message: { type: 'string' } } },
    run: ({ id, message }) => {
      const s = get(id)
      if (s.meta.kind !== 'worker') throw new Error('You can only message worker sessions')
      return deliver(s, String(message))
    },
  },
  {
    name: 'spawn_session',
    description: 'Start a new worker session in a directory. The first prompt is delivered like send_to_session.',
    inputSchema: {
      type: 'object', required: ['cwd', 'title'],
      properties: {
        cwd: { type: 'string', description: 'Absolute or ~ path to an existing directory' },
        title: { type: 'string' }, prompt: { type: 'string' },
        parent: { type: 'string', description: 'Id of the session this one is a sub-task of' },
        model: { type: 'string', description: 'opus, sonnet, haiku or fable; omit for the default' },
      },
    },
    run: ({ cwd, title, prompt, parent, model }) => {
      const s = createSession({ cwd, title, parentId: parent, model })
      return `Created ${s.meta.id}.` + (prompt ? ' ' + deliver(s, String(prompt)) : '')
    },
  },
  {
    name: 'find_past_sessions',
    description: "Search Claude Code's own session history (every conversation run with `claude` on this machine, in a terminal or here), newest first. Match on title, directory and prompts.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match; all must appear (case-insensitive). Omit for the most recent.' },
        limit: { type: 'number', description: 'Default 10' },
      },
    },
    run: ({ query, limit }) => {
      const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const byClaude = new Map(metas().map((m) => [m.claudeSessionId, m.id]))
      return listHistory()
        .filter((h) => !h.continuedIn && !h.cwd.startsWith(MASTER_DIR))
        .filter((h) => { const hay = `${h.title} ${h.cwd} ${h.firstPrompt} ${h.lastPrompt}`.toLowerCase(); return words.every((w) => hay.includes(w)) })
        .slice(0, Math.min(Number(limit) || 10, 50))
        .map((h) => ({
          claude_session_id: h.id, title: h.title, cwd: h.cwd, last_active: new Date(h.mtime).toISOString(),
          first_prompt: h.firstPrompt.slice(0, 160), last_prompt: h.lastPrompt.slice(0, 160), in_codiner_as: byClaude.get(h.id) ?? null,
        }))
    },
  },
  {
    name: 'resume_past_session',
    description: 'Bring a past Claude Code session into Codiner as a worker, with its conversation, so the user (or you, via send_to_session) can continue it. Returns its Codiner id.',
    inputSchema: { type: 'object', required: ['claude_session_id'], properties: { claude_session_id: { type: 'string' } } },
    run: ({ claude_session_id }) => {
      const s = resumeHistory(String(claude_session_id))
      return `Resumed as ${s.meta.id} ("${s.meta.title}", ${s.meta.cwd}). Nothing has been sent to it yet.`
    },
  },
  {
    name: 'interrupt_session',
    description: 'Stop the turn a worker is in the middle of (like pressing Esc in Claude Code). The session stays open.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: ({ id }) => { get(id).interrupt(); return 'Interrupted.' },
  },
  {
    name: 'close_session',
    description: 'Close a worker: end its process and move it to the archive. It can be reopened later with its history, so this is safe for finished work.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: ({ id }) => {
      const s = get(id)
      if (s.meta.kind !== 'worker') throw new Error('Only worker sessions can be closed')
      s.stop(); s.meta.archived = true; metaChanged()
      return `Closed ${id}.`
    },
  },
  {
    name: 'compact_session',
    description: "Compact a worker session's context (Claude Code's /compact), optionally with instructions on what to keep.",
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, instructions: { type: 'string' } } },
    run: ({ id, instructions }) => {
      const s = get(id)
      if (s.meta.status === 'working' || s.meta.status === 'permission') throw new Error('That session is mid-turn; try again when it is idle')
      s.command(instructions ? `/compact ${instructions}` : '/compact')
      return 'Compacting.'
    },
  },
]

// ---- http -----------------------------------------------------------------------

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`])
const localHost = (req: http.IncomingMessage) => LOCAL_HOSTS.has(req.headers.host ?? '')
const localOrigin = (req: http.IncomingMessage) => {
  const o = req.headers.origin
  if (!o) return true
  try { return LOCAL_HOSTS.has(new URL(o).host) } catch { return false }
}

async function json(req: http.IncomingMessage): Promise<any> {
  let s = ''
  for await (const c of req) { s += c; if (s.length > 40_000_000) throw new HttpError(413, 'Too large') }
  return s ? JSON.parse(s) : {}
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const parts = url.pathname.split('/').slice(2) // after /api
  const method = req.method ?? 'GET'
  const [a, id, b, c, d] = parts

  if (a === 'images' && method === 'GET') {
    const file = imageFile(url.pathname)
    if (!file || !fs.existsSync(file)) throw new HttpError(404, 'No such image')
    res.writeHead(200, { 'content-type': `image/${path.extname(file).slice(1).replace('jpg', 'jpeg')}`, 'cache-control': 'max-age=31536000, immutable' })
    fs.createReadStream(file).pipe(res)
    return
  }
  if (a === 'images' && method === 'POST') return send(res, 200, saveImage(String((await json(req)).dataUrl ?? '')))
  if (a === 'agents-md' && method === 'GET') return send(res, 200, { path: AGENTS_FILE, text: readAgentsMd() })
  if (a === 'agents-md' && method === 'PUT') {
    const body = await json(req)
    if (typeof body.text !== 'string') throw new HttpError(400, 'text must be a string')
    writeAgentsMd(body.text)
    return send(res, 200, { path: AGENTS_FILE, text: body.text })
  }
  if (a === 'settings' && method === 'PUT') {
    const body = await json(req)
    settings = { ...settings, ...(typeof body.masterAutoSend === 'boolean' ? { masterAutoSend: body.masterAutoSend } : {}) }
    saveSettings(settings)
    broadcast({ type: 'settings', settings })
    return send(res, 200, settings)
  }
  if (a === 'history' && !id && method === 'GET') {
    const byClaude = new Map(metas().map((m) => [m.claudeSessionId, m.id]))
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const items = listHistory()
      .filter((h) => !h.continuedIn && !h.cwd.startsWith(MASTER_DIR))
      .filter((h) => !q || `${h.title} ${h.cwd} ${h.firstPrompt} ${h.lastPrompt}`.toLowerCase().includes(q))
      .slice(0, 300)
      .map((h) => ({ ...h, codinerId: byClaude.get(h.id) ?? null }))
    return send(res, 200, items)
  }
  if (a === 'history' && id && b === 'resume' && method === 'POST') return send(res, 200, resumeHistory(id).meta)
  if (a === 'recent-dirs' && method === 'GET') {
    const seen = new Map<string, { path: string; ts: number; source: string }>()
    const add = (p: string, ts: number, source: string) => {
      if (p.startsWith(MASTER_DIR) || p.startsWith(DATA)) return
      const cur = seen.get(p)
      if (!cur || cur.ts < ts) seen.set(p, { path: p, ts, source: cur && cur.source !== source ? 'both' : source })
    }
    for (const m of metas()) if (m.kind === 'worker') add(m.cwd, m.lastActivity, 'codiner')
    for (const h of listHistory()) add(h.cwd, h.mtime, 'claude')
    const dirs = [...seen.values()].filter((d) => fs.existsSync(d.path)).sort((x, y) => y.ts - x.ts).slice(0, 60)
    return send(res, 200, dirs)
  }
  if (a === 'fs' && id === 'dirs' && method === 'GET') {
    const p = expandHome(url.searchParams.get('path') || '~')
    try { return send(res, 200, listDirs(p, url.searchParams.get('hidden') === '1')) } catch { throw new HttpError(400, `Can't read ${p}`) }
  }
  if (a === 'fs' && id === 'pick' && method === 'POST') {
    if (process.platform !== 'darwin') throw new HttpError(400, 'The native folder picker is macOS-only')
    const start = (await json(req)).path
    const def = start && fs.existsSync(expandHome(start)) ? ` default location (POSIX file "${expandHome(start).replace(/["\\]/g, '')}")` : ''
    const picked = await new Promise<string | null>((resolve) => {
      execFile('osascript', ['-e', `POSIX path of (choose folder with prompt "Choose a folder for the Claude session"${def})`], { timeout: 600_000 },
        (err, out) => resolve(err ? null : out.trim().replace(/\/$/, '') || null))
    })
    return send(res, 200, { path: picked })
  }
  if (a === 'master' && id === 'reset' && method === 'POST') {
    const s = get(MASTER_ID)
    s.stop()
    Object.assign(s.meta, { claudeSessionId: randomUUID(), started: false, context: { used: 0, window: s.meta.context.window }, error: null, unread: false, pendingAsks: 0 })
    s.notice('Fresh start: the master forgot this conversation. It keeps NOTES.md.')
    return send(res, 200, { ok: true })
  }
  if (a !== 'sessions') throw new HttpError(404, 'Not found')

  if (!id && method === 'POST') return send(res, 200, createSession(await json(req)).meta)
  const s = get(id)
  if (!b && method === 'PATCH') {
    const body = await json(req)
    if (typeof body.title === 'string' && body.title.trim()) s.meta.title = body.title.trim()
    if (typeof body.archived === 'boolean' && s.meta.kind === 'worker') { s.meta.archived = body.archived; if (body.archived) s.stop() }
    if (MODES.includes(body.permissionMode)) s.setPermissionMode(body.permissionMode)
    metaChanged()
    return send(res, 200, s.meta)
  }
  if (!b && method === 'DELETE') {
    if (s.meta.kind !== 'worker') throw new HttpError(400, 'The master session cannot be deleted')
    s.stop()
    sessions.delete(id)
    deleteEvents(id)
    metaChanged()
    return send(res, 200, { ok: true })
  }
  if (b === 'events' && method === 'GET') return send(res, 200, s.getEvents())
  if (b === 'commands' && method === 'GET') return send(res, 200, commands.get(id) ?? lastCommands)
  if (method !== 'POST') throw new HttpError(404, 'Not found')
  const body = await json(req)
  switch (b) {
    case 'send': {
      const p: Part[] = Array.isArray(body.parts) ? body.parts : []
      s.send(p, s.meta.kind === 'master' ? { hidden: board() } : {})
      return send(res, 200, { ok: true })
    }
    case 'rewind': {
      // Delete from a message on; with parts, send them in its place (an edit).
      try { s.rewind(Number(body.seq)) } catch (e) { throw new HttpError(400, (e as Error).message) }
      const p: Part[] = Array.isArray(body.parts) ? body.parts : []
      if (p.length) s.send(p, s.meta.kind === 'master' ? { hidden: board() } : {})
      return send(res, 200, { ok: true })
    }
    case 'command':
      if (!/^\/[\w:.-]+/.test(body.cmd ?? '')) throw new HttpError(400, 'Not a slash command')
      s.command(body.cmd)
      return send(res, 200, { ok: true })
    case 'interrupt': s.interrupt(); return send(res, 200, { ok: true })
    case 'seen': s.markSeen(); return send(res, 200, { ok: true })
    case 'permission':
      s.answerPermission(String(body.requestId), body.decision, body.message)
      return send(res, 200, { ok: true })
    case 'inbox':
      if (d === 'dismiss') { s.meta.inbox = s.meta.inbox.filter((i) => i.id !== c); metaChanged(); return send(res, 200, { ok: true }) }
  }
  throw new HttpError(404, 'Not found')
}

const server = http.createServer(async (req, res) => {
  try {
    if (!localHost(req) || !localOrigin(req)) throw new HttpError(403, 'Codiner only answers requests from its own page')
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname === `/mcp/${MCP_TOKEN}`) {
      const master = [...sessions.values()].find((s) => s.meta.kind === 'master')
      return await handleMcp(req, res, master ? [...tools, lookTool(master.meta.id)] : tools)
    }
    const look = url.pathname.startsWith(`/mcp/${MCP_TOKEN}/look/`) && url.pathname.split('/').pop()
    if (look && sessions.has(look)) return await handleMcp(req, res, [lookTool(look)])
    if (url.pathname.startsWith('/api/')) return await api(req, res, url)
    if (vite) return vite.middlewares(req, res)
    serveStatic(url.pathname, res)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) console.error(e)
    if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : String(e) })
  }
})

const DIST = path.join(ROOT, 'dist')
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
function serveStatic(p: string, res: http.ServerResponse) {
  let file = path.join(DIST, path.normalize(p).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  if (!fs.existsSync(file)) { res.writeHead(500).end('Run `npm run build` first, or start with --dev.'); return }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}

// ---- websocket --------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') return // Vite's HMR socket has its own listener
  if (!localHost(req) || !localOrigin(req)) { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws)
    ws.on('close', () => sockets.delete(ws))
    ws.send(JSON.stringify({ type: 'hello', sessions: metas(), settings, usage, platform: process.platform, home: os.homedir() } satisfies ServerMsg))
  })
})

let vite: { middlewares: (req: http.IncomingMessage, res: http.ServerResponse) => void } | null = null
if (DEV) {
  const { createServer } = await import('vite')
  vite = await createServer({
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  })
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Codiner on http://localhost:${PORT}${DEV ? ' (dev)' : ''}`)
})

function shutdown() {
  for (const s of sessions.values()) s.stop()
  saveSessions(metas)
  setTimeout(() => process.exit(0), 300)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function plural(n: number, word: string) { return `${n} ${word}${n === 1 ? '' : 's'}` }
