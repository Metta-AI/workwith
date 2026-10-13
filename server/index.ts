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
import type { InboxItem, Part, PermissionMode, ServerMsg, SessionMeta, Settings, Usage } from '../shared/types.ts'
import { inboxLabel, inboxParts, openItemsOf } from '../shared/inbox.ts'
import { execFile, execFileSync, spawn } from 'node:child_process'
import os from 'node:os'
import { Session, type Hooks, type Launch, type SlashCommand } from './session.ts'
import { findHistory, importTranscript, lastCache, listDirs, listHistory } from './history.ts'
import { LEAD_PROMPT, WORKER_PROMPT, lookPrompt, workerNotesPrompt } from './prompts.ts'
import { LOOK_OPTIONS, LOOK_SLOTS, cleanLook, describeLook } from '../shared/looks.ts'
import { cleanAppearance } from '../shared/appearance.ts'
import * as meter from './meter.ts'
import { notesDir, notesNow, notesPath, readNotes, resumeKeepWarm, startNotes } from './notes.ts'
import { notesFile } from '../shared/notes.ts'
import { allTasks, endText, logPath, markTold, readLog, removeTask, searchLog, startTask, startTasks, statusLine, stopTask, taskOf } from './tasks.ts'
import type { Task, TaskNotify } from '../shared/types.ts'
import { configsFor, probe, serversFor } from './mcpservers.ts'
import { DEFAULT_CACHE_GUARD, cacheLeft, knownTtl } from '../shared/cache.ts'
import { AGENTS_FILE, agentsPrompt, readAgentsMd, writeAgentsMd } from './agentsmd.ts'
import { handleMcp, type Tool } from './mcp.ts'
import { blame, initFileHistory, moveHistory, noteEdit, record as recordVersion, versions } from './filehistory.ts'
import { authState, cancelLogin, childEnv, initAuth, needed as authNeeded, startLogin, submitCode } from './auth.ts'
import {
  DATA, LEAD_DIR, LEAD_NOTES, OLD_LEAD_NOTES, appendEvent, deleteEvents, expandHome, imageFile, knownWindow, leadRenamed, resolveModel, loadSessions, loadSettings, saveImage, saveSessions, saveSettings,
} from './store.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT ?? 4545)
const DEV = process.argv.includes('--dev')
const MCP_TOKEN = randomUUID()
const LEAD_ID = 'lead'
const MODES: PermissionMode[] = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions']

// ---- state ----------------------------------------------------------------

const sessions = new Map<string, Session>()
let settings: Settings = loadSettings()
meter.poll()
setInterval(meter.poll, 60_000).unref()
let usage: Usage = { rate: meter.rate() }
const sockets = new Set<WebSocket>()
// Slash commands differ by directory (project skills), so keep each session's
// list, and the last one seen for sessions that haven't started yet.
const COMMANDS_FILE = path.join(DATA, 'commands.json')
const commands = new Map<string, SlashCommand[]>()
// Closes the terminal window (or iTerm2 session) on the tty given as $1, a moment
// after the command's shell ends. Each app gets its own AppleScript, so a Mac
// without iTerm2 still compiles the Terminal one.
const CLOSER = `#!/bin/sh
rm -f "$0"
sleep 1
case "$TERM_PROGRAM" in
iTerm.app) osascript - "$1" <<'AS'
on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with x in sessions of t
          if tty of x is (item 1 of argv) then close x
        end repeat
      end repeat
    end repeat
  end tell
end run
AS
;;
Apple_Terminal) osascript - "$1" <<'AS'
on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is (item 1 of argv) then close w
      end repeat
    end repeat
  end tell
end run
AS
;;
esac
`
// Commands opened in Terminal from a <run> block, by token, until they report back.
const runs = new Map<string, { sid: string; log: string }>()
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
  event: (s, event) => {
    broadcast({ type: 'event', sessionId: s.meta.id, event })
    metaChanged()
    if (event.t === 'result') setImmediate(() => { autoSend(s); taskTurn(s) })
    // A tool call that finished may have changed a tracked file: record it with this message.
    if (event.t === 'tool_result') {
      const ev = s.getEvents()
      for (let i = ev.length - 1; i >= 0 && i > ev.length - 400; i--) {
        const a = ev[i]
        const b = a.t === 'assistant' ? a.blocks.find((x) => x.type === 'tool_use' && x.id === event.toolUseId) : undefined
        if (b?.type === 'tool_use') { noteEdit(b.name, b.input, { kind: 'session', sid: s.meta.id, title: s.meta.title, seq: a.seq }); break }
      }
    }
  },
  delta: (s, text, reset) => broadcast({ type: 'delta', sessionId: s.meta.id, text, reset }),
  authFailed: () => authNeeded(),
  truncate: (s, seq) => { broadcast({ type: 'truncate', sessionId: s.meta.id, seq }); metaChanged() },
  usage: (u) => { meter.limit(u); usage = { ...u, rate: meter.rate() }; broadcast({ type: 'usage', usage }) },
  commands: (s, list) => {
    commands.set(s.meta.id, list)
    if (s.meta.kind === 'worker') { lastCommands = list; fs.writeFile(COMMANDS_FILE, JSON.stringify(list), () => {}) }
  },
  mcpServers: (s) => s.meta.mcp ? configsFor(s.meta.cwd, s.meta.mcp.on) : null,
}

function launchFor(meta: SessionMeta): () => Launch {
  // Every session gets Codiner's set_look tool, pre-approved; workers keep their own MCP servers too.
  if (meta.kind === 'worker') return () => {
    const notes = settings.notes !== false
    // The worker writes its own notes: their folder (and its .gitignore) is there first.
    if (notes) notesDir(meta)
    return {
      args: [
        '--mcp-config', JSON.stringify({ mcpServers: { codiner: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp/${MCP_TOKEN}/look/${meta.id}` } } }),
        // Started with your MCP servers off: only Codiner's, until one is turned on (server/mcpservers.ts).
        ...(meta.mcp ? ['--strict-mcp-config'] : []),
        '--allowedTools', `mcp__codiner__set_look,mcp__codiner__set_title,mcp__codiner__start_task,mcp__codiner__stop_task,mcp__codiner__list_tasks${meta.mcp && settings.mcpClaude !== false ? ',mcp__codiner__use_mcp_server' : ''}`,
      ],
      prompt: WORKER_PROMPT + lookPrompt(meta.look) + titlePrompt(meta) + mcpPrompt(meta) + (notes ? workerNotesPrompt(notesFile(meta.id)) : '') + agentsPrompt(),
    }
  }
  return () => ({
    prompt: LEAD_PROMPT + lookPrompt(meta.look) + agentsPrompt(),
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

// The model a session will run before Claude Code says: what its alias (or the
// default) resolved to last time, else the model the newest session ran.
function expectModel(model: string | null | undefined): string | null {
  const known = resolveModel(model)
  if (known?.includes('-')) return known
  if (model) return model
  return [...sessions.values()].map((s) => s.meta).filter((m) => m.model?.includes('-')).sort((a, b) => b.createdAt - a.createdAt)[0]?.model ?? null
}

function newMeta(o: Partial<SessionMeta> & { cwd: string; title: string }): SessionMeta {
  const now = Date.now()
  const expected = expectModel(o.model)
  return {
    id: randomUUID().slice(0, 8), kind: 'worker', parentId: null, model: null, permissionMode: 'auto',
    claudeSessionId: randomUUID(), started: false, createdAt: now, lastActivity: now, status: 'new',
    running: false, unread: false, compacting: false, context: { used: 0, window: knownWindow(expected) }, pendingAsks: 0,
    lastText: '', error: null, archived: false, inbox: [], ...(expected ? { expectedModel: expected } : {}), ...o,
  }
}

for (const m of loadSessions()) {
  const meta = { ...newMeta(m), ...m }
  // The window used to default to 200k until a turn finished; trust what the model reports.
  if (meta.context.window === 200_000 || meta.context.used > meta.context.window) meta.context.window = Math.max(knownWindow(meta.model ?? meta.expectedModel), meta.context.used)
  // Sessions from before Codiner kept a cache record: the transcript has one.
  if (!meta.cache && meta.started) meta.cache = lastCache(meta.cwd, meta.claudeSessionId) ?? undefined
  adopt(meta)
}
if (!sessions.has(LEAD_ID)) {
  adopt(newMeta({ id: LEAD_ID, kind: 'lead', title: 'Lead', cwd: LEAD_DIR }))
  metaChanged()
}
if (leadRenamed) {
  get(LEAD_ID).notice('The master is now called the lead. It starts a new conversation and keeps its LEAD_NOTES.md.')
  saveSettings(settings)
  metaChanged()
}
// Auto mode became the default: move sessions still on the old defaults over, once.
if (!settings.autoModeMigrated) {
  for (const s of sessions.values()) if (s.meta.permissionMode === 'default' || (s.meta.kind === 'lead' && s.meta.permissionMode === 'acceptEdits')) s.meta.permissionMode = 'auto'
  settings = { ...settings, autoModeMigrated: true }
  saveSettings(settings)
  metaChanged()
}
startNotes({ sessions: () => sessions.values(), settings: () => settings, usage: () => usage, changed: metaChanged })
startTasks({ changed: (tasks) => broadcast({ type: 'tasks', tasks }), ended: taskEnded })

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
    // Your MCP servers start off, except the ones you keep always on.
    ...(settings.mcpStartOff !== false ? { mcp: { strict: true as const, on: [...(settings.mcpAlways ?? [])] } } : {}),
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
  meta.cache = lastCache(item.cwd, claudeId) ?? undefined
  meta.status = 'idle'
  for (const e of events) appendEvent(meta.id, e)
  const s = adopt(meta)
  s.notice(`Picked up from Claude Code history (${plural(events.filter((e) => e.t === "user").length, "message")}). Your next message continues this conversation.`)
  if (Date.now() - item.mtime < 3 * 60_000) s.notice('This session was active in the last few minutes. If it is still open in a terminal, close it there first, or both will write to the same conversation.', 'warn')
  metaChanged()
  return s
}

// Context added to each message you send, out of the transcript: the lead gets
// the board; a worker gets who else is at work in its directory, from the
// ~/.claude/bin/agents helper when there is one, so it need not check first.
const AGENTS_BIN = path.join(os.homedir(), '.claude', 'bin', 'agents')
function hiddenFor(s: Session): { hidden?: string } {
  if (s.meta.kind === 'lead') return { hidden: board() }
  const out: string[] = []
  if (fs.existsSync(AGENTS_BIN)) {
    let who = ''
    try { who = execFileSync(AGENTS_BIN, ['active', s.meta.cwd, '--other', s.meta.claudeSessionId.slice(0, 8)], { timeout: 3000, encoding: 'utf8' }) }
    catch (e) { who = String((e as { stdout?: string }).stdout ?? '') } // exit code 1: someone is active
    who = who.trim()
    out.push(`[Codiner, ${new Date().toISOString().slice(0, 16)}Z] Other agents active in ${s.meta.cwd} (from \`agents active\`): ${who ? `\n${who}` : 'none.'}`)
  }
  // Tasks that ended since it last heard.
  out.push(...tasksEnded(s))
  return out.length ? { hidden: out.join('\n\n') } : {}
}

// ---- tasks (server/tasks.ts) ------------------------------------------------

// The session's tasks that ended and it has not heard of: their texts, now marked heard.
function tasksEnded(s: Session): string[] {
  const t = allTasks().filter((x) => x.sid === s.meta.id && x.ended && !x.told)
  if (t.length) markTold(t.map((x) => x.id))
  return t.map(endText)
}

const busy = (s: Session) => s.meta.status === 'working' || s.meta.status === 'permission'

// A task ended. The session always hears of it with its next message; "turn" and
// "interrupt" make that happen now, unless a send would write an expired cache again.
function taskEnded(t: Task) {
  const s = sessions.get(t.sid)
  if (!s) return
  s.notice(`Task "${t.title}" ${t.stopped ? `was stopped by ${t.stopped === 'user' ? 'you' : 'Claude'}` : `ended${t.code != null ? ` with exit code ${t.code}` : ''}`}.`, t.code && !t.stopped ? 'warn' : 'info')
  if (t.notify === 'next' || t.stopped === 'agent') return
  if (holdReasons(s, true).length) { s.notice(`Claude hears of it with your next message: its prompt cache has expired, so a message now would write it all again.`); return }
  if (busy(s) && t.notify === 'interrupt') s.interrupt()
  else if (busy(s)) return // taskTurn sends it when the turn ends
  sendTasks(s)
}

// A turn ended: tasks that asked for a turn of their own get it.
function taskTurn(s: Session) {
  if (busy(s) || !allTasks().some((x) => x.sid === s.meta.id && x.ended && !x.told && x.notify !== 'next')) return
  if (holdReasons(s, true).length) return
  sendTasks(s)
}

function sendTasks(s: Session) {
  const texts = tasksEnded(s)
  if (texts.length) s.send([{ kind: 'text', text: texts.join('\n\n') }], { from: 'codiner', ...hiddenFor(s) })
}

function taskTools(id: string): Tool[] {
  const mine = (tid: unknown) => { const t = taskOf(String(tid ?? '')); if (!t || t.sid !== id) throw new Error(`You have no task "${tid}". Call list_tasks.`); return t }
  return [
    {
      name: 'start_task',
      description: 'Run a long or lasting shell command (a dev server, a watcher, a long build or test run) apart from this session, with no time limit. The user can watch its log and stop it in Codiner, and it keeps running if this session stops. Returns its id and log path; read the log with your usual tools.',
      inputSchema: {
        type: 'object', required: ['title', 'command'],
        properties: {
          title: { type: 'string', description: 'A short name for the user, like "Dev server" or "Full test run"' },
          command: { type: 'string', description: 'The shell command (run with /bin/sh -c)' },
          cwd: { type: 'string', description: "The directory to run it in; your session's by default" },
          notify: { type: 'string', enum: ['next', 'turn', 'interrupt'], description: 'How you hear that it ended. next (default): with the next message to you. turn: in a turn of your own as soon as you are between turns; use it when you wait on the result. interrupt: stop your current turn; only when its end changes what you are doing.' },
        },
      },
      run: (args) => {
        const s = get(id)
        const command = String(args?.command ?? '').trim()
        if (!command) return 'Give a command.'
        const cwd = expandHome(String(args?.cwd ?? '') || s.meta.cwd)
        if (!fs.existsSync(cwd)) return `There is no directory ${cwd}.`
        const notify = (['next', 'turn', 'interrupt'] as const).includes(args?.notify) ? args.notify as TaskNotify : 'next'
        const t = startTask(id, { title: String(args?.title ?? '').trim().slice(0, 80) || command.slice(0, 40), command, cwd, notify })
        return `Started task \`${t.id}\` (pid ${t.pid}). Log: ${logPath(t.id)}. You will hear when it ends (${notify}).`
      },
    },
    {
      name: 'stop_task',
      description: 'Stop one of your tasks: SIGTERM to its process group, then SIGKILL after 5 seconds.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: (args) => { const t = mine(args?.id); if (t.ended) return `It already ended.`; stopTask(t.id, 'agent'); return `Stopping task \`${t.id}\`.` },
    },
    {
      name: 'list_tasks',
      description: 'Your tasks, running and ended, with their status and log paths.',
      inputSchema: { type: 'object', properties: {} },
      run: () => { const t = allTasks().filter((x) => x.sid === id); return t.length ? t.map(statusLine).join('\n') : 'You have no tasks.' },
    },
  ]
}

// What the lead sees at the end of each message you send it.
function board(): string {
  const lines = metas().filter((m) => m.kind === 'worker' && !m.archived).map((m) => {
    const ctx = Math.round((m.context.used / (m.context.window || 1)) * 100)
    return `- ${m.id} "${m.title}" ${m.cwd} status=${m.status} ctx=${ctx}%${m.pendingAsks ? ` open_questions=${m.pendingAsks}` : ''}${m.parentId ? ` parent=${m.parentId}` : ''}${m.inbox.length ? ` drafts_waiting=${m.inbox.length}` : ''}`
  })
  return `<board>\n${lines.length ? lines.join('\n') : '(no worker sessions)'}\n</board>`
}

// ---- lead tools -----------------------------------------------------------

// The lead's drafts wait in the session's reply tray, beside yours, and go with
// your next message. They go on their own only when nothing there waits for
// you: auto-send is on, the worker is not mid-turn, every question and item
// Claude left has a reply, and you are not writing one. `now` is your yes, given
// to the lead, to send past all that. A big, expired cache always waits for you.
// approved: you said yes to the lead's drafts (Send drafts, in the lead view), so auto-send need not be on.
function holdReasons(s: Session, now = false, approved = false): string[] {
  const guard = settings.cacheGuard ?? DEFAULT_CACHE_GUARD
  const left = cacheLeft(s.meta, Date.now(), knownTtl(metas()))
  const why: string[] = []
  if (guard && left != null && left <= 0 && s.meta.context.used >= guard) why.push('its prompt cache has expired, so a send would write its whole context to the cache again; that is the user\'s call')
  if (now) return why
  if (!settings.leadAutoSend && !approved) why.push('auto-send is off')
  if (s.meta.status === 'working' || s.meta.status === 'permission') why.push('it is mid-turn (the drafts go when the turn ends, if nothing else holds them)')
  const open = openItemsOf(s.getEvents()).filter((i) => !s.meta.inbox.some((d) => d.key === i.key))
  if (open.length) why.push(`Claude left questions or items the user has not replied to: ${open.map((i) => `${i.id} ("${i.label.slice(0, 60)}")`).join(', ')}`)
  if (s.meta.drafting) why.push('the user is writing a reply there')
  return why
}

function flushInbox(s: Session): void {
  const parts = inboxParts(s.meta.inbox)
  s.meta.inbox = []
  metaChanged()
  if (parts.length) s.send(parts, { from: 'lead', ...hiddenFor(s) })
}

// A turn ended: drafts that waited only for it may go now.
function autoSend(s: Session): void {
  if (s.meta.kind === 'worker' && s.meta.inbox.length && !holdReasons(s).length) flushInbox(s)
}

type Draft = Omit<InboxItem, 'id' | 'from' | 'ts'>

function deliver(s: Session, drafts: Draft[], opts: { now?: boolean; urgent?: boolean } = {}): string {
  const id = s.meta.id
  // Urgent: stop the worker and send just this message. The rest wait as usual.
  if (opts.urgent) {
    const text = drafts.filter((d) => !d.kind || d.kind === 'text').map((d) => d.text.trim()).filter(Boolean).join('\n\n')
    if (!text) throw new Error('An urgent send needs a message')
    if (s.meta.status === 'working' || s.meta.status === 'permission') s.interrupt()
    s.send([{ kind: 'text', text }], { from: 'lead', ...hiddenFor(s) })
    drafts = drafts.filter((d) => d.kind && d.kind !== 'text')
    if (!drafts.length) return `Stopped ${id}'s turn, if it was in one, and sent the message.`
  }
  // A newer draft for the same item replaces the older one.
  const keys = new Set(drafts.flatMap((d) => d.key ? [d.key] : []))
  s.meta.inbox = [...s.meta.inbox.filter((i) => !i.key || !keys.has(i.key)), ...drafts.map((d) => ({ ...d, id: randomUUID().slice(0, 8), from: 'lead', ts: Date.now() }))]
  metaChanged()
  const why = holdReasons(s, opts.now)
  if (!why.length) { flushInbox(s); return `${opts.urgent ? 'Sent the urgent message; then sent' : 'Sent'} the drafts to ${id}.` }
  const n = s.meta.inbox.length
  const ask = !opts.now && why.some((w) => w.startsWith('Claude left')) && !why[0].startsWith('its prompt cache')
  return `Held in ${id}'s reply tray (${n} draft${n === 1 ? '' : 's'} there now); they go with the user's next message there. Held because: ${why.join('; ')}.`
    + (ask ? ' If this should go now anyway, ask the user; with their yes, call again with send_now.' : '')
}

// The critter's look, chosen by the Claude in that session.
// Workers name their session after its task, and keep the name current, unless you named it.
// A name is a small thing of the session's own: Claude may always rename it, and
// when it renames one the user named, the user's name is kept to undo to.
function titlePrompt(meta: SessionMeta): string {
  const base = `\n\n## Your session's name\nName this session after its task with the set_title tool: 2 to 5 words, like "Login flow fix". Do it once the task is clear, and again only if the task changes a lot. Do not mention it unless the user asks.`
  if (!meta.titleByUser) return base + '\n'
  return base + ` The user named this session "${meta.title}"; you may still rename it when the task changes, and they can undo it.${meta.titleUndone ? ` They undid your rename to "${meta.titleUndone}", so do not propose that one again.` : ''}\n`
}

// A session that started with your MCP servers off is told their names, and may turn one on.
function mcpPrompt(meta: SessionMeta): string {
  if (!meta.mcp) return ''
  const names = serversFor(meta.cwd).map((s) => s.name)
  const may = settings.mcpClaude !== false
  return `\n\n## MCP servers\nThis session started with the user's MCP servers off, to keep its context small.`
    + (names.length ? ` These are available: ${names.join(', ')}.` : ' Codiner does not know their names yet: call use_mcp_server with no name.')
    + (meta.mcp.on.length ? ` Turned on: ${meta.mcp.on.join(', ')}.` : '')
    + ` When the task needs one, turn it on with the use_mcp_server tool${may ? '' : ', which asks the user first'}, then use its tools (they may come as deferred tools: load them with ToolSearch). Do not turn on a server the task does not need.\n`
}

function mcpTool(id: string): Tool {
  return {
    name: 'use_mcp_server',
    description: "Turn on one of the user's MCP servers (for example a claude.ai connector) in this session, when the task needs it. Its tools become available from your next step. With no name, it lists the servers.",
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The server name, as listed' } } },
    run: async (args) => {
      const s = get(id), m = s.meta
      if (!m.mcp) return 'This session has all of the user\'s MCP servers on already.'
      const want = String(args?.name ?? '').trim().toLowerCase().replace(/^claude\.ai /, '')
      const find = () => serversFor(m.cwd).find((x) => x.name.toLowerCase().replace(/^claude\.ai /, '') === want)
      const server = want ? find() : undefined
      const list = serversFor(m.cwd).map((x) => `${x.name}${m.mcp!.on.includes(x.name) ? ' (on)' : ''}${x.status === 'needs-auth' ? ' (needs sign-in)' : ''}`).join(', ')
      // Codiner looks for servers only when the user presses Refresh: an unknown one may be new.
      const refresh = 'Codiner may not know about it yet: its MCP chip, at the top of this session, now asks the user to press Refresh. Ask them to, then try again.'
      if (!want && list) return `Servers: ${list}.`
      if (!server) {
        m.mcp.missing = want ? String(args.name) : 'a list of servers'
        metaChanged()
        return want ? `There is no server called "${args.name}" that Codiner knows (it knows: ${list || 'none'}). ${refresh}` : `Codiner knows no MCP servers yet. ${refresh}`
      }
      if (server.status === 'needs-auth') return `${server.name} needs the user to sign in first, in their claude.ai connector settings. Ask them to do that.`
      if (!m.mcp.on.includes(server.name)) m.mcp.on.push(server.name)
      s.setMcp(configsFor(m.cwd, m.mcp.on))
      metaChanged()
      return `Turned on ${server.name} (${server.tools} tools). Its tools are available from your next step.`
    },
  }
}

function titleTool(id: string): Tool {
  return {
    name: 'set_title',
    description: "Name your session in the Codiner sidebar after its task: 2 to 5 words. Call it when the task becomes clear, and again only if the task changes a lot.",
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    run: (args) => {
      const s = get(id)
      const t = String(args?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
      if (!t) return 'Give a title of 2 to 5 words.'
      if (t === s.meta.title) return `It is already "${t}".`
      const m = s.meta
      // Over a name the user gave, keep theirs to undo to.
      if (m.titleByUser && m.titleBefore == null) m.titleBefore = m.title
      m.title = t
      metaChanged()
      return m.titleBefore != null ? `Renamed to "${t}". The user had named it "${m.titleBefore}" and can undo this.` : `Renamed to "${t}".`
    },
  }
}

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
    description: "List the worker sessions: id, title, directory, status, context use, the questions and items Claude left open (with ids, for send_to_session's replies), your drafts waiting in each, whether the user is writing a reply there, and the tail of the last thing Claude said.",
    inputSchema: { type: 'object', properties: { include_archived: { type: 'boolean' } } },
    run: ({ include_archived }) => metas().filter((m) => m.kind === 'worker' && (include_archived || !m.archived)).map((m) => ({
      id: m.id, title: m.title, cwd: m.cwd, parent: m.parentId, status: m.status,
      context: `${Math.round(m.context.used / 1000)}k of ${Math.round(m.context.window / 1000)}k`,
      open_items: openItemsOf(get(m.id).getEvents()).map((i) => ({ id: i.id, kind: i.kind, label: i.label.slice(0, 120), ...(i.kind === 'ask' && i.ask.options.length ? { choices: i.ask.options } : {}) })),
      your_drafts: m.inbox.map(inboxLabel), user_drafting: !!m.drafting, last_said: m.lastText.slice(-240),
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
    description: "Draft a reply to a worker session, written as if from the user: replies to its open questions and items (ids from list_sessions' open_items), a message, or both. The drafts go into the session's reply tray beside the user's own, where the user can edit them, and go with the user's next message there. They go on their own only when auto-send is on, the worker is between turns, every open question and item has a reply, and the user is not writing one. A message that is just a slash command (/compact, /model sonnet, /code-review, any skill) runs it, as if typed at the claude prompt.",
    inputSchema: {
      type: 'object', required: ['id'],
      properties: {
        id: { type: 'string' },
        message: { type: 'string', description: 'Plain text, sent after the replies' },
        replies: {
          type: 'array',
          items: {
            type: 'object', required: ['item', 'action'],
            properties: {
              item: { type: 'string', description: 'The id of an open question or item, from open_items' },
              action: { type: 'string', enum: ['answer', 'done', 'dismiss'], description: 'answer: reply to it (a question or an item); done: the user did the task it asked for; dismiss: set it aside without a reply' },
              text: { type: 'string', description: 'The answer, or for done, a problem the user hit. For a draft: the edited text in full; leave it out to approve the draft as written' },
              choices: { type: 'array', items: { type: 'string' }, description: "For a question: the choices picked, word for word" },
            },
          },
        },
        send_now: { type: 'boolean', description: 'Send now, past open questions, a reply the user is writing, or auto-send being off. Only with the user\'s yes, asked in this conversation.' },
        urgent: { type: 'boolean', description: 'Stop the worker\'s turn and send `message` at once. Very rare: only to prevent harm the user would not want to wait on, such as a commit or a deletion about to go wrong.' },
      },
    },
    run: ({ id, message, replies, send_now, urgent }) => {
      const s = get(id)
      if (s.meta.kind !== 'worker') throw new Error('You can only message worker sessions')
      const open = openItemsOf(s.getEvents())
      const drafts: Draft[] = (Array.isArray(replies) ? replies : []).map((r: any) => {
        const it = open.find((i) => i.id === String(r.item) || i.key === String(r.item))
        if (!it) throw new Error(`No open question or item "${r.item}" in ${id}. Open now: ${open.map((i) => i.id).join(', ') || 'none'}`)
        const text = String(r.text ?? '')
        if (r.action === 'done') return { kind: 'done', key: it.key, label: it.label, text }
        if (r.action === 'dismiss') return { kind: 'dismiss', key: it.key, label: it.label, text: '' }
        // A draft: the lead's text is the edited draft; none approves it as written.
        if (it.kind === 'ask' && it.ask.draft != null) return { kind: 'answer', key: it.key, label: it.ask.question, text: text.trim() ? text : it.ask.draft, draft: !text.trim() || text.trim() === it.ask.draft.trim() ? 'same' : 'edited' }
        if (it.kind === 'ask') return { kind: 'answer', key: it.key, label: it.ask.question, text, choices: Array.isArray(r.choices) ? r.choices.map(String) : [] }
        return { kind: 'reply', key: it.key, label: it.label, text }
      })
      if (message != null && String(message).trim()) drafts.push({ kind: 'text', text: String(message) })
      if (!drafts.length) throw new Error('Give a message, replies, or both')
      return deliver(s, drafts, { now: !!send_now, urgent: !!urgent })
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
      return `Created ${s.meta.id}.` + (prompt ? ' ' + deliver(s, [{ kind: 'text', text: String(prompt) }]) : '')
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
        .filter((h) => !h.continuedIn && !h.cwd.startsWith(DATA))
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

// Claude Code's /context for a new worker session in `cwd`, with a worker's own
// arguments (system prompt, Codiner's tools), so it counts what Codiner adds too.
// It makes no API call: Claude Code estimates the sizes itself. Kept 10 minutes.
const contexts = new Map<string, { at: number; text: string }>()
function startContext(cwd: string, fresh: boolean): Promise<string> {
  const hit = contexts.get(cwd)
  if (hit && !fresh && Date.now() - hit.at < 600_000) return Promise.resolve(hit.text)
  const { args, prompt } = launchFor(newMeta({ cwd, title: 'context' }))()
  return new Promise((resolve, reject) => {
    execFile(process.env.CODINER_CLAUDE ?? 'claude', ['-p', '--output-format', 'json', '--no-session-persistence', '--append-system-prompt', prompt, ...args, '--', '/context'],
      { cwd, env: childEnv(), timeout: 120_000, maxBuffer: 8 << 20 }, (err, out) => {
        let text = ''
        try { text = String(JSON.parse(out).result ?? '') } catch { /* reported below */ }
        if (!text) return reject(new Error(err?.message ?? 'Claude Code gave no answer'))
        contexts.set(cwd, { at: Date.now(), text })
        resolve(text)
      })
  })
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
  if (a === 'tasks') {
    if (!id && method === 'GET') return send(res, 200, allTasks())
    if (id && b === 'log' && method === 'GET') { const f = url.searchParams.get('from'); return send(res, 200, readLog(id, f == null ? undefined : Number(f))) }
    if (id && b === 'search' && method === 'GET') return send(res, 200, searchLog(id, url.searchParams.get('q') ?? ''))
    if (id && b === 'stop' && method === 'POST') return send(res, 200, stopTask(id, 'user'))
    if (id && !b && method === 'DELETE') { removeTask(id); return send(res, 200, { ok: true }) }
  }
  if (a === 'images' && method === 'POST') return send(res, 200, saveImage(String((await json(req)).dataUrl ?? '')))
  if (a === 'restart' && method === 'POST') {
    send(res, 200, { ok: true })
    setTimeout(restart, 100)
    return
  }
  if (a === 'files') {
    const p = url.searchParams.get('path') ?? ''
    const known = trackedFiles().includes(p)
    if (!id && method === 'GET') return send(res, 200, trackedFiles().map((f) => ({
      path: f, builtIn: BUILT_IN().includes(f), exists: fs.existsSync(f), versions: versions(f).length, last: versions(f).at(-1)?.ts ?? null,
    })))
    if (id === 'blame' && method === 'GET') { if (!known) throw new HttpError(404, 'Not a tracked file'); return send(res, 200, blame(p)) }
    if (!id && method === 'PUT') {
      if (!known) throw new HttpError(404, 'Not a tracked file')
      const body = await json(req)
      if (typeof body.text !== 'string') throw new HttpError(400, 'text must be a string')
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, body.text)
      recordVersion(p, { kind: 'settings' })
      return send(res, 200, blame(p))
    }
    if (id === 'track' && method === 'POST') {
      const f = path.resolve(expandHome(String((await json(req)).path ?? '').trim()))
      if (!f || f === '/') throw new HttpError(400, 'Give a file path')
      if (!trackedFiles().includes(f)) { settings = { ...settings, trackedFiles: [...(settings.trackedFiles ?? []), f] }; saveSettings(settings) }
      recordVersion(f, { kind: 'initial' })
      return send(res, 200, { path: f })
    }
    if (id === 'track' && method === 'DELETE') {
      settings = { ...settings, trackedFiles: (settings.trackedFiles ?? []).filter((f) => f !== p) }
      saveSettings(settings)
      return send(res, 200, { ok: true })
    }
    throw new HttpError(404, 'Not found')
  }
  if (a === 'agents-md' && method === 'GET') return send(res, 200, { path: AGENTS_FILE, text: readAgentsMd() })
  if (a === 'agents-md' && method === 'PUT') {
    const body = await json(req)
    if (typeof body.text !== 'string') throw new HttpError(400, 'text must be a string')
    writeAgentsMd(body.text)
    recordVersion(AGENTS_FILE, { kind: 'settings' })
    return send(res, 200, { path: AGENTS_FILE, text: body.text })
  }
  if (a === 'settings' && method === 'PUT') {
    const body = await json(req)
    settings = {
      ...settings,
      ...(typeof body.leadAutoSend === 'boolean' ? { leadAutoSend: body.leadAutoSend } : {}),
      ...(typeof body.selfRestart === 'boolean' ? { selfRestart: body.selfRestart } : {}),
      ...(body.appearance ? { appearance: cleanAppearance(body.appearance) } : {}),
      ...(Array.isArray(body.groupOrder) ? { groupOrder: body.groupOrder.map(String) } : {}),
      ...(Number.isFinite(body.cacheGuard) && body.cacheGuard >= 0 ? { cacheGuard: Math.round(body.cacheGuard) } : {}),
      ...(typeof body.notes === 'boolean' ? { notes: body.notes } : {}),
      ...(Number.isFinite(body.keepWarmHours) && body.keepWarmHours >= 0 ? { keepWarmHours: Math.min(48, body.keepWarmHours) } : {}),
      ...(Number.isFinite(body.keepWarmMax) && body.keepWarmMax > 0 ? { keepWarmMax: Math.round(body.keepWarmMax) } : {}),
      ...(Number.isFinite(body.keepWarmUsage) && body.keepWarmUsage > 0 ? { keepWarmUsage: Math.min(100, body.keepWarmUsage) } : {}),
      ...(typeof body.mcpStartOff === 'boolean' ? { mcpStartOff: body.mcpStartOff } : {}),
      ...(typeof body.mcpClaude === 'boolean' ? { mcpClaude: body.mcpClaude } : {}),
      ...(Array.isArray(body.mcpAlways) ? { mcpAlways: body.mcpAlways.map(String) } : {}),
    }
    saveSettings(settings)
    broadcast({ type: 'settings', settings })
    return send(res, 200, settings)
  }
  // What the usage meter has measured, to see how steady its estimate is.
  // What a new session in a folder starts with, by category.
  // Your MCP servers in a folder, found by a probe (server/mcpservers.ts).
  if (a === 'mcp' && method === 'POST') {
    const cwd = path.resolve(expandHome(String((await json(req)).cwd ?? '~')))
    let found
    try { found = await probe(cwd) } catch (e) { throw new HttpError(500, (e as Error).message) }
    // Sessions there stop asking, and get the configs of servers turned on before Codiner knew them.
    for (const x of sessions.values()) if (x.meta.cwd === cwd && x.meta.mcp) {
      delete x.meta.mcp.missing
      if (x.meta.mcp.on.length) x.setMcp(configsFor(cwd, x.meta.mcp.on))
    }
    metaChanged()
    return send(res, 200, found)
  }
  if (a === 'context' && method === 'GET') {
    const cwd = path.resolve(expandHome(url.searchParams.get('cwd') || '~'))
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new HttpError(400, `Not a directory: ${cwd}`)
    try { return send(res, 200, { cwd, text: await startContext(cwd, url.searchParams.get('fresh') === '1') }) } catch (e) { throw new HttpError(500, (e as Error).message) }
  }
  if (a === 'meter' && method === 'GET') return send(res, 200, { rate: meter.rate(), five: meter.pairs('five'), seven: meter.pairs('seven') })
  if (a === 'history' && !id && method === 'GET') {
    const byClaude = new Map(metas().map((m) => [m.claudeSessionId, m.id]))
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const items = listHistory()
      .filter((h) => !h.continuedIn && !h.cwd.startsWith(DATA))
      .filter((h) => !q || `${h.title} ${h.cwd} ${h.firstPrompt} ${h.lastPrompt}`.toLowerCase().includes(q))
      .slice(0, 300)
      .map((h) => ({ ...h, codinerId: byClaude.get(h.id) ?? null }))
    return send(res, 200, items)
  }
  if (a === 'history' && id && b === 'resume' && method === 'POST') return send(res, 200, resumeHistory(id).meta)
  if (a === 'recent-dirs' && method === 'GET') {
    const seen = new Map<string, { path: string; ts: number; source: string }>()
    const add = (p: string, ts: number, source: string) => {
      if (p.startsWith(DATA)) return
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
  if (a === 'runs' && id && method === 'POST') {
    // A command run from a <run> block ended (the Terminal script calls this).
    const run = runs.get(id)
    if (!run) throw new HttpError(404, 'No such run')
    runs.delete(id)
    let out = ''
    try { out = fs.readFileSync(run.log, 'utf8'); fs.rmSync(run.log, { force: true }) } catch { /* nothing recorded */ }
    // eslint-disable-next-line no-control-regex
    // Progress output redraws a line with \r: keep what each line ended as.
    const tail = out.replace(/\x1b\[[\d;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x04|\x08/g, '').replace(/^\^D/, '')
      .split('\n').map((l) => l.replace(/\r+$/, '').split('\r').pop()!).join('\n')
      .trimEnd().split('\n').slice(-20).join('\n').slice(-3000)
    broadcast({ type: 'run', sessionId: run.sid, token: id, code: Number(url.searchParams.get('code') ?? -1), tail })
    return send(res, 200, { ok: true })
  }
  if (a === 'login' && method === 'POST') {
    if (!id) startLogin()
    else if (id === 'code') { try { submitCode(String((await json(req)).code ?? '')) } catch (e) { throw new HttpError(400, (e as Error).message) } }
    else if (id === 'cancel') cancelLogin()
    else throw new HttpError(404, 'Not found')
    return send(res, 200, authState())
  }
  // Send the lead's drafts to every worker where nothing else holds them.
  if (a === 'lead' && id === 'send-drafts' && method === 'POST') {
    const sent: string[] = [], held: { id: string; title: string; why: string[] }[] = []
    for (const s of sessions.values()) {
      if (s.meta.kind !== 'worker' || s.meta.archived || !s.meta.inbox.length) continue
      const why = holdReasons(s, false, true)
      if (why.length) held.push({ id: s.meta.id, title: s.meta.title, why })
      else { flushInbox(s); sent.push(s.meta.id) }
    }
    return send(res, 200, { sent, held })
  }
  if (a === 'lead' && id === 'reset' && method === 'POST') {
    const s = get(LEAD_ID)
    s.stop()
    Object.assign(s.meta, { claudeSessionId: randomUUID(), started: false, context: { used: 0, window: s.meta.context.window }, error: null, unread: false, pendingAsks: 0 })
    s.notice('Fresh start: the lead forgot this conversation. It keeps LEAD_NOTES.md.')
    return send(res, 200, { ok: true })
  }
  if (a !== 'sessions') throw new HttpError(404, 'Not found')

  if (!id && method === 'POST') return send(res, 200, createSession(await json(req)).meta)
  // The sidebar's order for a set of siblings, top first.
  if (id === 'order' && method === 'PUT') {
    const { ids } = await json(req)
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be a list')
    ids.forEach((x, i) => { const m = sessions.get(String(x))?.meta; if (m) m.order = i })
    metaChanged()
    return send(res, 200, { ok: true })
  }
  // Back to the default order: folders by latest activity, sessions by age.
  if (id === 'order' && method === 'DELETE') {
    for (const x of sessions.values()) delete x.meta.order
    settings = { ...settings, groupOrder: [] }
    saveSettings(settings)
    broadcast({ type: 'settings', settings })
    metaChanged()
    return send(res, 200, { ok: true })
  }
  const s = get(id)
  if (!b && method === 'PATCH') {
    const body = await json(req)
    if (typeof body.title === 'string' && body.title.trim()) {
      // Undo of Claude's rename: remember the name undone, so Claude doesn't offer it again.
      if (body.undo && s.meta.titleBefore != null) s.meta.titleUndone = s.meta.title
      s.meta.title = body.title.trim()
      s.meta.titleByUser = true
      s.meta.titleBefore = undefined
    }
    if (typeof body.archived === 'boolean' && s.meta.kind === 'worker') { s.meta.archived = body.archived; if (body.archived) s.stop() }
    if (MODES.includes(body.permissionMode)) s.setPermissionMode(body.permissionMode)
    metaChanged()
    return send(res, 200, s.meta)
  }
  if (!b && method === 'DELETE') {
    if (s.meta.kind !== 'worker') throw new HttpError(400, 'The lead session cannot be deleted')
    s.stop()
    sessions.delete(id)
    deleteEvents(id)
    metaChanged()
    return send(res, 200, { ok: true })
  }
  if (b === 'events' && method === 'GET') return send(res, 200, s.getEvents())
  if (b === 'commands' && method === 'GET') return send(res, 200, commands.get(id) ?? lastCommands)
  if (b === 'mcp' && method === 'GET') {
    return send(res, 200, { servers: serversFor(s.meta.cwd), on: s.meta.mcp?.on ?? null })
  }
  if (b === 'notes' && !c && method === 'GET') return send(res, 200, { path: notesPath(s.meta), text: readNotes(s.meta) })
  if (method !== 'POST') throw new HttpError(404, 'Not found')
  const body = await json(req)
  switch (b) {
    case 'send': {
      const p: Part[] = Array.isArray(body.parts) ? body.parts : []
      // The lead's drafts that went with your reply.
      if (Array.isArray(body.inbox) && body.inbox.length) { s.meta.inbox = s.meta.inbox.filter((i) => !body.inbox.includes(i.id)); metaChanged() }
      s.send(p, hiddenFor(s))
      return send(res, 200, { ok: true })
    }
    case 'drafting':
      if (s.meta.drafting !== !!body.on) { s.meta.drafting = !!body.on; metaChanged() }
      return send(res, 200, { ok: true })
    case 'rewind': {
      // Delete from a message on; with parts, send them in its place (an edit).
      try { s.rewind(Number(body.seq)) } catch (e) { throw new HttpError(400, (e as Error).message) }
      const p: Part[] = Array.isArray(body.parts) ? body.parts : []
      if (p.length) s.send(p, hiddenFor(s))
      return send(res, 200, { ok: true })
    }
    case 'run': {
      // A command Claude asked you to run, opened in a new Terminal window in the session's
      // directory. A .command file opens in the default terminal app and needs no Automation permission.
      if (process.platform !== 'darwin') throw new HttpError(400, 'Run in Terminal is macOS-only')
      const cmd = String(body.command ?? '').trim()
      if (!cmd) throw new HttpError(400, 'No command')
      // `script` keeps the terminal interactive and records what the command prints; when the
      // command ends, the script reports its exit code back, and the result goes to the item.
      const token = randomUUID().slice(0, 12)
      const file = path.join(os.tmpdir(), `codiner-${token}.command`)
      const log = path.join(os.tmpdir(), `codiner-${token}.log`)
      const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`
      const closer = path.join(os.tmpdir(), `codiner-${token}-close.sh`)
      fs.writeFileSync(closer, CLOSER, { mode: 0o755 })
      runs.set(token, { sid: s.meta.id, log })
      fs.writeFileSync(file, [
        '#!/bin/sh', 'rm -f "$0"', `cd ${q(s.meta.cwd)} || exit 1`,
        `cat <<'CODINER_CMD'`, `$ ${cmd}`, 'CODINER_CMD',
        `script -q ${q(log)} /bin/sh -c ${q(cmd)}`, 'code=$?',
        `curl -s -m 5 -X POST "http://127.0.0.1:${PORT}/api/runs/${token}?code=$code" >/dev/null 2>&1`,
        // On success the window closes itself a moment after the shell ends (found by its tty);
        // on failure it stays, so you can read what went wrong.
        'if [ $code -eq 0 ]; then', '  echo; echo "Done. This window closes."',
        `  nohup sh ${q(closer)} "$(tty)" >/dev/null 2>&1 &`, `else rm -f ${q(closer)}`, 'fi',
        'exit $code', '',
      ].join('\n'), { mode: 0o755 })
      execFile('open', [file], (err) => { if (err) console.error('open', err.message) })
      return send(res, 200, { token })
    }
    case 'command':
      if (!/^\/[\w:.-]+/.test(body.cmd ?? '')) throw new HttpError(400, 'Not a slash command')
      s.command(body.cmd)
      return send(res, 200, { ok: true })
    case 'mcp': {
      // Turn one of your MCP servers on or off in a session that started with them off.
      const m = s.meta
      if (!m.mcp) throw new HttpError(400, 'This session started with all your MCP servers on')
      const name = String(body.name ?? '')
      m.mcp.on = body.on ? [...new Set([...m.mcp.on, name])] : m.mcp.on.filter((n) => n !== name)
      s.setMcp(configsFor(m.cwd, m.mcp.on))
      metaChanged()
      return send(res, 200, { on: m.mcp.on })
    }
    case 'notes': {
      // Write the notes now; keep-warm on again; or a new session that starts from them.
      if (c === 'keep-warm') { resumeKeepWarm(s.meta); return send(res, 200, { ok: true }) }
      if (c === 'continue') {
        if (!readNotes(s.meta)) throw new HttpError(400, 'This session has no notes yet')
        const n = createSession({ cwd: s.meta.cwd, title: `${s.meta.title} (continued)`, model: s.meta.model, permissionMode: s.meta.permissionMode, parentId: s.meta.parentId })
        return send(res, 200, { meta: n.meta, text: `Read \`${notesFile(s.meta.id)}\`: notes from an earlier session. Continue the work from there.` })
      }
      const err = notesNow(s, !!body.force)
      if (err) throw new HttpError(err === 'cold' ? 409 : 400, err === 'cold' ? 'The prompt cache has expired or is about to' : err)
      return send(res, 200, { ok: true })
    }
    case 'interrupt': s.interrupt(); return send(res, 200, { ok: true })
    case 'seen': s.markSeen(); return send(res, 200, { ok: true })
    case 'unread': s.markUnread(); return send(res, 200, { ok: true })
    case 'permission':
      s.answerPermission(String(body.requestId), body.decision, body.message)
      return send(res, 200, { ok: true })
    case 'inbox':
      if (d === 'dismiss') { s.meta.inbox = s.meta.inbox.filter((i) => i.id !== c); metaChanged(); return send(res, 200, { ok: true }) }
      // Your edit of one of the lead's drafts.
      if (d === 'edit') {
        const i = s.meta.inbox.find((x) => x.id === c)
        if (!i) throw new HttpError(404, 'No such draft')
        if (typeof body.text === 'string') i.text = body.text
        if (Array.isArray(body.choices)) i.choices = body.choices.map(String)
        metaChanged()
        return send(res, 200, { ok: true })
      }
  }
  throw new HttpError(404, 'Not found')
}

const server = http.createServer(async (req, res) => {
  try {
    if (!localHost(req) || !localOrigin(req)) throw new HttpError(403, 'Codiner only answers requests from its own page')
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname === `/mcp/${MCP_TOKEN}`) {
      const lead = [...sessions.values()].find((s) => s.meta.kind === 'lead')
      return await handleMcp(req, res, lead ? [...tools, lookTool(lead.meta.id)] : tools)
    }
    const look = url.pathname.startsWith(`/mcp/${MCP_TOKEN}/look/`) && url.pathname.split('/').pop()
    if (look && sessions.has(look)) return await handleMcp(req, res, [lookTool(look), titleTool(look), mcpTool(look), ...taskTools(look)])
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
    ws.send(JSON.stringify({ type: 'hello', sessions: metas(), settings, usage, platform: process.platform, home: os.homedir(), auth: authState(), stale } satisfies ServerMsg))
    ws.send(JSON.stringify({ type: 'tasks', tasks: allTasks() } satisfies ServerMsg))
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

// A missing or expired login starts a sign-in; once signed in, what failed goes again.
// Files whose history is kept: the notes every session reads, and any you add in Settings.
const BUILT_IN = () => [AGENTS_FILE, path.join(os.homedir(), '.claude', 'CLAUDE.md'), LEAD_NOTES]
moveHistory(OLD_LEAD_NOTES, LEAD_NOTES)
const trackedFiles = () => [...new Set([...BUILT_IN(), ...(settings.trackedFiles ?? [])])]
initFileHistory({
  files: trackedFiles,
  sessions: () => [...sessions.values()].map((s) => ({
    sid: s.meta.id, title: s.meta.title, csid: s.meta.claudeSessionId,
    seqOf: (toolUseId: string) => s.getEvents().find((e) => e.t === 'assistant' && e.blocks.some((b) => b.type === 'tool_use' && b.id === toolUseId))?.seq ?? null,
  })),
  changed: (p) => broadcast({ type: 'file', path: p }),
})

initAuth({
  change: (auth) => broadcast({ type: 'auth', auth }),
  signedIn: () => { for (const s of sessions.values()) s.retryAfterSignIn(hiddenFor(s)) },
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Codiner on http://localhost:${PORT}${DEV ? ' (dev)' : ''}`)
})

// ---- restarting itself --------------------------------------------------------
// When the server's own code on disk is newer than this process, the page offers
// a restart: a new server starts detached (its log in ~/.codiner/server.log) as
// soon as this one has let go of the port. Sessions resume on their next message.
const STARTED = Date.now()
function codeTime(): number {
  let t = 0
  for (const d of ['server', 'shared']) for (const f of fs.readdirSync(path.join(ROOT, d))) {
    if (f.endsWith('.ts')) t = Math.max(t, fs.statSync(path.join(ROOT, d, f)).mtimeMs)
  }
  return Math.max(t, fs.statSync(path.join(ROOT, 'package.json')).mtimeMs)
}
let stale = false
setInterval(() => {
  let now = stale
  try { now = codeTime() > STARTED } catch { /* a file mid-save */ }
  if (now !== stale) { stale = now; broadcast({ type: 'stale', stale }) }
}, 5000).unref()

function restart() {
  const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`
  const log = q(path.join(DATA, 'server.log'))
  // The built UI is rebuilt first when not serving it through Vite.
  const cmd = `sleep 1; ${DEV ? '' : `npx vite build >> ${log} 2>&1 && `}exec ${[process.execPath, ...process.argv.slice(1)].map(q).join(' ')} >> ${log} 2>&1`
  spawn('sh', ['-c', cmd], { cwd: process.cwd(), env: process.env, detached: true, stdio: 'ignore' }).unref()
  shutdown()
}

function shutdown() {
  for (const s of sessions.values()) s.stop()
  saveSessions(metas)
  setTimeout(() => process.exit(0), 300)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function plural(n: number, word: string) { return `${n} ${word}${n === 1 ? '' : 's'}` }
