// One Claude Code conversation, driven through `claude -p` in stream-JSON mode.
// That is the same headless protocol the Agent SDK speaks, run on your own
// Claude Code login: no API key involved (we strip it from the environment).
//
// The process is started lazily on the first send and kept alive between
// turns; after a server restart the next send resumes it with --resume.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { formatAnswer, formatNote } from '../shared/asks.ts'
import { formatDismissed, itemsOf } from '../shared/blocks.ts'
import type { Block, Event, Part, PermissionMode, SessionMeta, Status, Usage } from '../shared/types.ts'
import { entryBefore } from './history.ts'
import { appendEvent, imageFile, knownWindow, learnWindow, readEvents, writeEvents } from './store.ts'

export type Hooks = {
  meta(s: Session): void
  event(s: Session, e: Event): void
  delta(s: Session, text: string, reset: boolean): void
  truncate(s: Session, seq: number): void
  usage(u: Usage): void
  commands(s: Session, list: SlashCommand[]): void
}

export type SlashCommand = { name: string; description: string; argumentHint: string }

export type Launch = { args: string[]; prompt: string }

const MAX_RESULT = 8000
// How long a finished session keeps its claude process before it sleeps.
// CODINER_SLEEP_MS overrides it (for tests).
const IDLE_SLEEP_MS = Number(process.env.CODINER_SLEEP_MS) || 5 * 60_000

export class Session {
  meta: SessionMeta
  private events: Event[] | null = null
  private proc: ChildProcess | null = null
  private buf = ''
  private stderrTail = ''
  private outstanding = 0        // turns sent but not yet finished
  private background = 0         // background tasks (shells, agents) the process is running
  private sleepTimer: NodeJS.Timeout | null = null
  private stopping = false       // we asked the process to end (sleep, close, delete)
  private interrupted = false
  private terminalOnly = new Set(['doctor', 'color', 'focus', 'reload-plugins', 'heapdump'])
  private pending = new Map<string, { input: any; suggestions: any[] }>()
  private hooks: Hooks
  private launch: () => Launch

  constructor(meta: SessionMeta, hooks: Hooks, launch: () => Launch) {
    this.meta = meta
    this.hooks = hooks
    this.launch = launch
    // Whatever was in flight when the server last stopped is gone now.
    meta.running = false
    meta.compacting = false
    if (meta.status === 'working' || meta.status === 'permission') meta.status = 'idle'
  }

  getEvents(): Event[] {
    if (!this.events) this.events = readEvents(this.meta.id)
    return this.events
  }

  private nextSeq(): number {
    const ev = this.getEvents()
    return ev.length ? ev[ev.length - 1].seq + 1 : 1
  }

  private record<T extends Event['t']>(t: T, body: Omit<Extract<Event, { t: T }>, 'seq' | 'ts' | 't'>): Event {
    const e = { seq: this.nextSeq(), ts: Date.now(), t, ...body } as unknown as Event
    this.getEvents().push(e)
    appendEvent(this.meta.id, e)
    this.meta.lastActivity = e.ts
    this.hooks.event(this, e)
    return e
  }

  notice(text: string, level: 'info' | 'warn' | 'error' = 'info') {
    this.record('notice', { text, level })
  }

  private refresh() {
    const m = this.meta
    let s: Status
    if (this.pending.size) s = 'permission'
    else if (this.outstanding > 0 || m.compacting) s = 'working'
    else if (m.error) s = 'error'
    else if (m.pendingAsks) s = 'asking'
    else if (m.unread) s = 'waiting'
    else s = m.started || this.getEvents().length ? 'idle' : 'new'
    m.status = s
    m.running = !!this.proc
    this.scheduleSleep()
    this.hooks.meta(this)
  }

  // A finished session ends its process after a while; the next message resumes it.
  // Never while a turn, a permission prompt, a compaction or background work is live.
  private canSleep() {
    const m = this.meta
    return !!this.proc && ['idle', 'waiting', 'asking'].includes(m.status) && !m.compacting && !this.background
  }

  private scheduleSleep() {
    if (!this.canSleep()) {
      if (this.sleepTimer) { clearTimeout(this.sleepTimer); this.sleepTimer = null }
      return
    }
    if (this.sleepTimer) return
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null
      if (this.canSleep()) this.stop()
    }, IDLE_SLEEP_MS)
  }

  // ---- process ----------------------------------------------------------

  private ensureProc() {
    // A process that is on its way out (asleep, closed) takes no more input; start a new one.
    if (this.proc && !this.stopping) return
    this.stopping = false
    const { args, prompt } = this.launch()
    const m = this.meta
    const full = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio',
      '--permission-mode', m.permissionMode,
      ...(m.model ? ['--model', m.model] : []),
      ...(m.resumeAt ? ['--resume', m.claudeSessionId, '--resume-session-at', m.resumeAt, '--fork-session']
        : m.started ? ['--resume', m.claudeSessionId] : ['--session-id', m.claudeSessionId]),
      '--append-system-prompt', prompt,
      ...args,
    ]
    const env = { ...process.env }
    // Never bill per token: without these, claude uses your subscription login.
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    // Don't let the child think it is nested inside another Claude Code.
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_ENTRYPOINT
    if (!fs.existsSync(m.cwd)) throw new Error(`Directory not found: ${m.cwd}`)
    const p = spawn(process.env.CODINER_CLAUDE ?? 'claude', full, { cwd: m.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = p
    this.buf = ''
    this.stderrTail = ''
    p.stdout!.setEncoding('utf8')
    p.stdout!.on('data', (d: string) => {
      if (this.proc !== p) return // let go of by a rewind
      this.buf += d
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        if (!line.trim()) continue
        let msg: any
        try { msg = JSON.parse(line) } catch { continue }
        try { this.handle(msg) } catch (e) { console.error(`[${m.id}] handling`, msg?.type, e) }
      }
    })
    p.stderr!.setEncoding('utf8')
    p.stderr!.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-2000) })
    p.stdin!.on('error', () => { /* the exit handler reports it */ })
    p.on('error', (e) => { this.notice(`Could not start claude: ${e.message}`, 'error') })
    // Ask for the command list (with descriptions) the way the Agent SDK does.
    p.stdin!.write(JSON.stringify({ type: 'control_request', request_id: `init-${m.id}`, request: { subtype: 'initialize' } }) + '\n')
    p.on('exit', (code, signal) => {
      if (this.proc !== p) return
      this.proc = null
      const wasBusy = this.outstanding > 0
      // claude exits with code 143 on SIGTERM, so a stop we asked for is judged by the flag.
      const expected = this.stopping
      this.stopping = false
      this.outstanding = 0
      this.background = 0
      for (const id of this.pending.keys()) this.record('permission_resolved', { requestId: id, resolution: 'cancelled' })
      this.pending.clear()
      this.meta.compacting = false
      if (expected) {
        // Asleep or closed: nothing to report.
      } else if (code && signal !== 'SIGTERM') {
        const tail = this.stderrTail.trim().split('\n').slice(-6).join('\n')
        this.meta.error = `claude exited with code ${code}${tail ? `: ${tail}` : ''}`
        this.notice(this.meta.error, 'error')
      } else if (wasBusy) {
        this.notice('The Claude process stopped mid-turn.', 'warn')
      }
      this.hooks.delta(this, '', true)
      this.refresh()
    })
    this.refresh()
  }

  private write(obj: unknown) {
    this.ensureProc()
    this.proc!.stdin!.write(JSON.stringify(obj) + '\n')
  }

  stop() {
    if (!this.proc) return
    this.stopping = true
    this.proc.kill('SIGTERM')
  }

  // End the process and forget it at once: whatever it still prints is ignored.
  private detach() {
    const p = this.proc
    this.proc = null
    p?.kill('SIGTERM')
    this.stopping = false
    this.outstanding = 0
    this.background = 0
    this.interrupted = false
    this.pending.clear()
    this.meta.compacting = false
    this.hooks.delta(this, '', true)
  }

  // ---- input ------------------------------------------------------------

  // `hidden` is appended to what Claude sees but left out of the transcript
  // (the master's board snapshot).
  send(parts: Part[], opts: { from?: string; hidden?: string } = {}) {
    const { from, hidden } = opts
    // A message that is only a slash command goes in as one, as if typed at the claude prompt.
    const only = parts.length === 1 && parts[0].kind === 'text' && !parts[0].images?.length ? parts[0].text.trim() : ''
    if (/^\/[\w:.-]+/.test(only)) return this.command(only, from)
    const content: any[] = []
    // Adjacent text blocks reach Claude run together, so parts share one block, a blank line apart.
    const addText = (text: string) => {
      const prev = content.at(-1)
      if (prev?.type === 'text') prev.text += `\n\n${text}`
      else content.push({ type: 'text', text })
    }
    for (const p of parts) {
      const text = partText(p)
      if (text.trim()) addText(text)
      for (const img of p.images ?? []) {
        const file = imageFile(img.url)
        if (!file || !fs.existsSync(file)) continue
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: fs.readFileSync(file).toString('base64') } })
      }
    }
    if (!content.length) throw new Error('Nothing to send')
    if (hidden) addText(hidden)
    const uuid = randomUUID()
    this.write({ type: 'user', uuid, message: { role: 'user', content } })
    this.outstanding++
    this.meta.unread = false
    this.meta.pendingAsks = 0
    this.meta.error = null
    this.record('user', { parts, uuid, csid: this.meta.claudeSessionId, ...(from ? { from } : {}) })
    this.refresh()
  }

  // Slash commands (/compact, /context, ...) go in as plain user text.
  command(cmd: string, from?: string) {
    const uuid = randomUUID()
    this.write({ type: 'user', uuid, message: { role: 'user', content: cmd } })
    this.outstanding++
    this.meta.unread = false
    this.meta.error = null
    if (cmd.startsWith('/compact')) this.meta.compacting = true
    this.record('user', { parts: [{ kind: 'text', text: cmd }], uuid, csid: this.meta.claudeSessionId, ...(from ? { from } : {}) })
    this.refresh()
  }

  // Forget one of your messages and everything after it, in the transcript and
  // in Claude's context. Claude resumes from the entry before it, in a forked
  // copy of its transcript (the original stays in Claude Code's history).
  // Files Claude changed since then stay as they are.
  rewind(seq: number) {
    const ev = this.getEvents()
    const i = ev.findIndex((e) => e.seq === seq)
    const e = ev[i]
    if (e?.t !== 'user') throw new Error('That is not one of your messages')
    const m = this.meta
    const text = e.parts.map(partText).filter((t) => t.trim()).join('\n\n').trim()
    const nth = ev.slice(0, i).filter((x) => x.t === 'user' && x.parts.map(partText).filter((t) => t.trim()).join('\n\n').trim() === text).length
    // A message sent just before a fork or a /clear is filed under the old id; look in both.
    let csid = '', at: string | null | undefined
    for (const id of new Set([e.csid, m.claudeSessionId].filter((x): x is string => !!x))) {
      at = entryBefore(id, { uuid: e.uuid, text, nth })
      if (at !== undefined) { csid = id; break }
    }
    if (at === undefined) {
      // Claude never got it (or its transcript is gone): only the transcript here needs cutting.
      if (m.started && ev.slice(0, i).some((x) => x.t === 'user')) throw new Error('Claude Code\'s transcript has no record of that message, so its context cannot be cut there')
      at = null
    }
    this.detach()
    if (at) Object.assign(m, { claudeSessionId: csid, started: true, resumeAt: at })
    else Object.assign(m, { claudeSessionId: randomUUID(), started: false, resumeAt: null })
    ev.splice(i)
    writeEvents(m.id, ev)
    m.error = null
    m.unread = false
    m.pendingAsks = this.openAsks()
    const last = ev.findLast((x) => x.t === 'assistant' && x.blocks.some((b) => b.type === 'text'))
    m.lastText = last?.t === 'assistant' ? overview(last.blocks.flatMap((b) => b.type === 'text' ? [b.text] : []).join('\n')) : ''
    this.hooks.truncate(this, seq)
    this.refresh()
  }

  interrupt() {
    if (!this.proc) return
    this.interrupted = true
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
  }

  setPermissionMode(mode: PermissionMode) {
    this.meta.permissionMode = mode
    if (this.proc) this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_permission_mode', mode } })
    this.refresh()
  }

  answerPermission(requestId: string, decision: 'allow' | 'always' | 'deny', message?: string) {
    const req = this.pending.get(requestId)
    if (!req) throw new Error('That permission request is no longer pending')
    this.pending.delete(requestId)
    const response = decision === 'deny'
      ? { behavior: 'deny', message: `The user denied this.${message?.trim() ? ` Their reason: ${message.trim()}` : ''}` }
      : { behavior: 'allow', updatedInput: req.input, ...(decision === 'always' ? { updatedPermissions: req.suggestions } : {}) }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    this.record('permission_resolved', { requestId, resolution: decision })
    this.refresh()
  }

  markSeen() {
    if (!this.meta.unread) return
    this.meta.unread = false
    this.refresh()
  }

  // ---- output -----------------------------------------------------------

  private handle(msg: any) {
    const m = this.meta
    // Claude starts a turn by itself when background work finishes.
    if (!this.outstanding && (msg.type === 'stream_event' || msg.type === 'assistant')) { this.outstanding = 1; this.refresh() }
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          m.started = true
          // /clear starts a new conversation under a new id, and so does a fork after a rewind; resume that one next time.
          if (msg.session_id) { m.claudeSessionId = msg.session_id; m.resumeAt = null }
          if (Array.isArray(msg.terminal_slash_commands)) this.terminalOnly = new Set(msg.terminal_slash_commands)
          if (msg.model && msg.model !== m.model) { m.model = msg.model; m.context.window = knownWindow(m.model) }
          if (msg.apiKeySource && msg.apiKeySource !== 'none') this.notice(`Claude is authenticating with ${msg.apiKeySource}, which may bill per token.`, 'warn')
          this.refresh()
        } else if (msg.subtype === 'background_tasks_changed') {
          this.background = Array.isArray(msg.tasks) ? msg.tasks.length : 0
          this.refresh()
        } else if (msg.subtype === 'status') {
          m.compacting = msg.status === 'compacting'
          this.refresh()
        } else if (msg.subtype === 'compact_boundary') {
          const c = msg.compact_metadata ?? {}
          if (c.post_tokens != null) m.context.used = c.post_tokens
          this.notice(`Context compacted${c.pre_tokens ? `: ${k(c.pre_tokens)} → ${k(c.post_tokens ?? 0)}` : ''} (${c.trigger ?? 'manual'})`)
          this.refresh()
        }
        return
      case 'stream_event': {
        if (msg.parent_tool_use_id) return
        const ev = msg.event
        if (ev?.type === 'content_block_start' || ev?.type === 'message_start') this.hooks.delta(this, '', true)
        else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') this.hooks.delta(this, ev.delta.text, false)
        return
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) return // a subagent's own turns: too noisy for the transcript
        const a = msg.message ?? {}
        const blocks: Block[] = []
        for (const b of a.content ?? []) {
          if (b.type === 'text') blocks.push({ type: 'text', text: b.text })
          else if (b.type === 'thinking' && b.thinking) blocks.push({ type: 'thinking', text: b.thinking })
          else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
        }
        const synthetic = a.model === '<synthetic>'
        if (!synthetic && a.usage) {
          const u = a.usage
          m.context.used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
        }
        this.hooks.delta(this, '', true)
        if (!blocks.length) return
        const plain = overview(blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n'))
        if (plain) m.lastText = plain
        this.record('assistant', { msgId: a.id ?? msg.uuid, blocks, ...(synthetic ? { synthetic } : {}) })
        return
      }
      case 'user': {
        if (msg.parent_tool_use_id) return
        const c = msg.message?.content
        if (typeof c === 'string') {
          const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(c)?.[1]?.trim()
          if (out) this.notice(out)
          return
        }
        for (const b of c ?? []) {
          if (b.type !== 'tool_result') continue
          const text = typeof b.content === 'string' ? b.content
            : (b.content ?? []).map((x: any) => x.type === 'text' ? x.text : `[${x.type}]`).join('\n')
          this.record('tool_result', { toolUseId: b.tool_use_id, text: text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + '\n… (truncated)' : text, isError: !!b.is_error })
        }
        return
      }
      case 'result': {
        this.outstanding = Math.max(0, this.outstanding - 1)
        m.compacting = false
        const mu = msg.modelUsage ?? {}
        for (const [model, u] of Object.entries(mu)) if ((u as any)?.contextWindow) learnWindow(model, (u as any).contextWindow)
        const win = (mu[m.model ?? ''] ?? Object.values(mu)[0] as any)?.contextWindow
        if (win) m.context.window = win
        if (msg.is_error && this.interrupted) {
          msg.is_error = false
          this.notice('Interrupted.')
        } else if (msg.is_error) {
          m.error = String(msg.result ?? msg.subtype ?? 'error').slice(0, 500)
        }
        if (!this.outstanding) this.interrupted = false
        if (msg.num_turns > 0 || msg.is_error) {
          this.record('result', { durationMs: msg.duration_ms ?? 0, isError: !!msg.is_error, ...(msg.is_error ? { text: m.error! } : {}) })
          m.unread = true
          m.pendingAsks = this.openAsks()
        }
        this.hooks.delta(this, '', true)
        this.refresh()
        return
      }
      case 'control_response': {
        const r = msg.response
        if (r?.request_id === `init-${m.id}` && Array.isArray(r.response?.commands)) {
          this.hooks.commands(this, r.response.commands
            .filter((c: any) => c?.name && !this.terminalOnly.has(c.name) && !c.name.startsWith('__'))
            .map((c: any) => ({ name: c.name, description: String(c.description ?? ''), argumentHint: String(c.argumentHint ?? '') })))
        }
        return
      }
      case 'conversation_reset': {
        m.context.used = 0
        m.pendingAsks = 0
        this.notice('Conversation cleared. Claude starts fresh from here.')
        this.refresh()
        return
      }
      case 'control_request': {
        const r = msg.request ?? {}
        if (r.subtype === 'can_use_tool') {
          const suggestions = (r.permission_suggestions ?? []).filter((s: any) => s.type === 'addRules')
          this.pending.set(msg.request_id, { input: r.input, suggestions })
          this.record('permission', {
            requestId: msg.request_id, toolName: r.display_name ?? r.tool_name, input: r.input,
            description: r.description ?? r.decision_reason, canAlways: suggestions.length > 0,
            ...(r.tool_use_id ? { toolUseId: r.tool_use_id } : {}),
          })
          this.refresh()
        } else {
          this.write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Codiner does not handle ${r.subtype}` } })
        }
        return
      }
      case 'control_cancel_request': {
        if (this.pending.delete(msg.request_id)) {
          this.record('permission_resolved', { requestId: msg.request_id, resolution: 'cancelled' })
          this.refresh()
        }
        return
      }
      case 'rate_limit_event': {
        const i = msg.rate_limit_info ?? {}
        const w = i.unifiedWindows ?? {}
        this.hooks.usage({ fiveHour: w.five_hour?.utilization, sevenDay: w.seven_day?.utilization, resetsAt: i.resetsAt, status: i.status })
        return
      }
    }
  }

  // Questions and items to consider in Claude's text since the user last spoke.
  private openAsks(): number {
    const ev = this.getEvents()
    let n = 0
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i]
      if (e.t === 'user') break
      if (e.t === 'assistant') for (const b of e.blocks) if (b.type === 'text') n += itemsOf(b.text).length
    }
    return n
  }

  // A plain-text rendering of the recent transcript, for the master agent.
  digest(maxChars: number, turns: number): string {
    const ev = this.getEvents()
    let start = ev.length
    let seen = 0
    while (start > 0 && seen < turns) { start--; if (ev[start].t === 'user') seen++ }
    const lines: string[] = []
    for (const e of ev.slice(start)) {
      if (e.t === 'user') lines.push(`USER${e.from ? ` (via ${e.from})` : ''}: ${e.parts.map((p) => p.kind === 'note' ? formatNote(p.quote, p.text) : p.kind === 'answer' ? `[answer ${p.askKey}] ${p.choices?.join('; ') ?? ''} ${p.text}` : p.kind === 'dismiss' ? formatDismissed(p.items) : p.text).join('\n')}`)
      else if (e.t === 'assistant') for (const b of e.blocks) {
        if (b.type === 'text') lines.push(`CLAUDE: ${b.text}`)
        else if (b.type === 'tool_use') lines.push(`  [${b.name}] ${toolSummary(b.name, b.input)}`)
      }
      else if (e.t === 'permission') lines.push(`  [waiting for permission: ${e.toolName}]`)
      else if (e.t === 'notice' && e.level !== 'info') lines.push(`  [${e.level}: ${e.text}]`)
    }
    const s = lines.join('\n')
    return s.length > maxChars ? '…' + s.slice(-maxChars) : s
  }
}

// The text Claude receives for one part of a message.
function partText(p: Part): string {
  return p.kind === 'note' ? formatNote(p.quote, p.text)
    : p.kind === 'answer' ? formatAnswer(p.askKey.split(':').pop()!, p.question, p.choices, p.text)
    : p.kind === 'dismiss' ? formatDismissed(p.items)
    : p.text
}

// The tail of what Claude said, for overviews: questions as their text, without the markup.
function overview(text: string): string {
  return text
    .replace(/^```ask\b[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, (_, body: string) => `Q: ${body.split('\n')[0]}`)
    .replace(/^\s*<ask\b[^>]*>\s*\n?([^\n]*)[\s\S]*?<\/ask>\s*$/gm, (_, q: string) => `Q: ${q}`)
    .replace(/^\s*<\/?(answer|details|consider)\b[^>]*>\s*$/gm, '')
    .trim().slice(-400)
}

export function toolSummary(name: string, input: any): string {
  if (!input) return ''
  const v = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt
  return typeof v === 'string' ? v.split('\n')[0].slice(0, 160) : JSON.stringify(input).slice(0, 160)
}

const k = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
