// Claude Code's own session history (~/.claude/projects/<dir>/<session>.jsonl):
// list it cheaply, and turn one transcript into Codiner events so a session
// started in a terminal can be picked up here with its conversation intact.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Block, Event, ImageRef, Part } from '../shared/types.ts'
import { saveImage } from './store.ts'

const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')
const SLICE = 256 * 1024

export type HistoryItem = {
  id: string
  cwd: string
  title: string
  firstPrompt: string
  lastPrompt: string
  mtime: number
  size: number
  continuedIn: string | null
}

type Cached = { key: string; item: HistoryItem | null }
const cache = new Map<string, Cached>()

function readSlice(file: string, start: number, len: number): string {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = fs.readSync(fd, buf, 0, len, start)
    return buf.subarray(0, n).toString('utf8')
  } finally { fs.closeSync(fd) }
}

function lines(s: string, dropFirst: boolean): any[] {
  const out: any[] = []
  const parts = s.split('\n')
  if (dropFirst) parts.shift() // probably cut mid-line
  for (const l of parts) if (l.startsWith('{')) try { out.push(JSON.parse(l)) } catch { /* cut */ }
  return out
}

// The text a person typed, from a user entry; null for tool results and
// injected context.
function typed(m: any): string | null {
  if (m.type !== 'user' || m.isMeta || m.isSidechain || m.isCompactSummary) return null
  const c = m.message?.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : ''
  if (!text || /^\s*<(local-command|system-reminder|command-)/.test(text)) {
    const cmd = /<command-name>([^<]+)<\/command-name>/.exec(text ?? '')?.[1]
    return cmd ? cmd.trim() : null
  }
  return text.trim()
}

function summarize(file: string, id: string, st: fs.Stats): HistoryItem | null {
  const head = lines(readSlice(file, 0, Math.min(SLICE, st.size)), false)
  const tail = st.size > SLICE ? lines(readSlice(file, st.size - SLICE, SLICE), true) : head
  const all = st.size > SLICE ? [...head, ...tail] : head
  const cwd = all.find((m) => typeof m.cwd === 'string')?.cwd
  if (!cwd) return null
  let title = '', aiTitle = '', lastPrompt = '', continuedIn: string | null = null
  for (const m of all) {
    if (m.type === 'agent-name' && m.agentName) title = m.agentName
    if (m.type === 'ai-title' && m.aiTitle) aiTitle = m.aiTitle
    if (m.type === 'last-prompt' && m.lastPrompt) lastPrompt = m.lastPrompt
    if (m.type === 'continued-in' && m.continuedInSessionId) continuedIn = m.continuedInSessionId
  }
  let firstPrompt = ''
  for (const m of head) { const t = typed(m); if (t) { firstPrompt = t; break } }
  if (!firstPrompt && !lastPrompt) return null // never had a conversation
  return {
    id, cwd, title: title || aiTitle || (firstPrompt || lastPrompt).split('\n')[0].slice(0, 80),
    firstPrompt: firstPrompt.slice(0, 300), lastPrompt: lastPrompt.slice(0, 300),
    mtime: st.mtimeMs, size: st.size, continuedIn,
  }
}

export function listHistory(): HistoryItem[] {
  const out: HistoryItem[] = []
  let dirs: string[] = []
  try { dirs = fs.readdirSync(PROJECTS) } catch { return out }
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d)
    let files: string[] = []
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      const file = path.join(dir, f)
      let st: fs.Stats
      try { st = fs.statSync(file) } catch { continue }
      const key = `${st.mtimeMs}:${st.size}`
      let c = cache.get(file)
      if (c?.key !== key) {
        let item: HistoryItem | null = null
        try { item = summarize(file, f.slice(0, -6), st) } catch { /* unreadable */ }
        c = { key, item }
        cache.set(file, c)
      }
      if (c.item) out.push(c.item)
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

export function findHistory(id: string): { file: string; item: HistoryItem } | null {
  for (const [file, c] of cache) if (c.item?.id === id) return { file, item: c.item }
  listHistory()
  for (const [file, c] of cache) if (c.item?.id === id) return { file, item: c.item }
  return null
}

// The prompt cache as a transcript last left it: when its last API call ran, and
// the TTL it wrote (see shared/cache.ts). For sessions with no record of their own.
export function lastCache(cwd: string, csid: string): { at: number; ttl: number } | null {
  let file = path.join(PROJECTS, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${csid}.jsonl`)
  if (!fs.existsSync(file)) file = findHistory(csid)?.file ?? ''
  let tail = ''
  try {
    const fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size, n = Math.min(size, SLICE * 4)
    const buf = Buffer.alloc(n)
    fs.readSync(fd, buf, 0, n, size - n)
    fs.closeSync(fd)
    tail = buf.toString('utf8')
  } catch { return null }
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"cache_creation"')) continue
    let m: any
    try { m = JSON.parse(lines[i]) } catch { continue }
    const cc = m.message?.usage?.cache_creation
    // A call that only read the cache says nothing of its TTL; look further back.
    if (m.type !== 'assistant' || !cc || !m.timestamp || !(cc.ephemeral_1h_input_tokens || cc.ephemeral_5m_input_tokens)) continue
    return { at: Date.parse(m.timestamp), ttl: cc.ephemeral_1h_input_tokens > 0 ? 3_600_000 : 300_000 }
  }
  return null
}

const MAX_RESULT = 8000
const MAX_IMPORT_IMAGES = 40

// A whole transcript as Codiner events. Subagent turns, injected context and
// bookkeeping entries are dropped, as they are from live sessions.
export function importTranscript(file: string): { events: Event[]; contextUsed: number; model: string | null } {
  const events: Event[] = []
  let seq = 0, contextUsed = 0, images = 0
  let model: string | null = null
  const push = (ts: string | undefined, e: Record<string, unknown>) => {
    events.push({ seq: ++seq, ts: ts ? Date.parse(ts) || Date.now() : Date.now(), ...e } as unknown as Event)
  }
  const raw = fs.readFileSync(file, 'utf8')
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue
    let m: any
    try { m = JSON.parse(line) } catch { continue }
    if (m.isSidechain) continue
    if (m.type === 'system' && m.subtype === 'compact_boundary') { push(m.timestamp, { t: 'notice', text: 'Context compacted', level: 'info' }); continue }
    if (m.type === 'assistant') {
      const a = m.message ?? {}
      const blocks: Block[] = []
      for (const b of a.content ?? []) {
        if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text })
        else if (b.type === 'thinking' && b.thinking) blocks.push({ type: 'thinking', text: b.thinking })
        else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
      }
      if (a.model && a.model !== '<synthetic>') {
        model = a.model
        const u = a.usage ?? {}
        contextUsed = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
      }
      if (blocks.length) push(m.timestamp, { t: 'assistant', msgId: a.id ?? m.uuid, blocks, ...(a.model === '<synthetic>' ? { synthetic: true } : {}) })
      continue
    }
    if (m.type !== 'user' || m.isMeta || m.isCompactSummary) continue
    const c = m.message?.content
    if (typeof c === 'string') {
      const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(c)?.[1]?.trim()
      if (out) { push(m.timestamp, { t: 'notice', text: out, level: 'info' }); continue }
      const t = typed(m)
      if (t) push(m.timestamp, { t: 'user', parts: [{ kind: 'text', text: t }], ...ids(m) })
      continue
    }
    const parts: Part[] = []
    const imgs: ImageRef[] = []
    for (const b of c ?? []) {
      if (b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content
          : (b.content ?? []).map((x: any) => x.type === 'text' ? x.text : `[${x.type}]`).join('\n')
        push(m.timestamp, { t: 'tool_result', toolUseId: b.tool_use_id, text: text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + '\n… (truncated)' : text, isError: !!b.is_error })
      } else if (b.type === 'text' && b.text && !/^\s*<(system-reminder|local-command|command-)/.test(b.text)) {
        parts.push({ kind: 'text', text: b.text })
      } else if (b.type === 'image' && b.source?.type === 'base64' && images < MAX_IMPORT_IMAGES) {
        try { imgs.push(saveImage(`data:${b.source.media_type};base64,${b.source.data}`)); images++ } catch { /* skip */ }
      }
    }
    if (imgs.length) { if (parts.length) parts[parts.length - 1].images = imgs; else parts.push({ kind: 'text', text: '', images: imgs }) }
    if (parts.length) push(m.timestamp, { t: 'user', parts, ...ids(m) })
  }
  return { events, contextUsed, model }
}

const ids = (m: any) => ({ ...(m.uuid ? { uuid: m.uuid } : {}), ...(m.sessionId ? { csid: m.sessionId } : {}) })

// ---- rewinding --------------------------------------------------------------

function transcriptOf(csid: string): string | null {
  let dirs: string[] = []
  try { dirs = fs.readdirSync(PROJECTS) } catch { return null }
  for (const d of dirs) {
    const file = path.join(PROJECTS, d, `${csid}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  return null
}

// The entry one of your messages hangs off in a Claude Code transcript: resume
// there and the message, and everything after it, is gone. Found by its uuid,
// else as the nth message that starts with `text` (older Codiner logs have no
// uuids). null: it was the first message; undefined: it isn't in there.
export function entryBefore(csid: string, msg: { uuid?: string; text: string; nth: number }): string | null | undefined {
  const file = transcriptOf(csid)
  if (!file) return undefined
  const entries: any[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue
    try { const m = JSON.parse(line); if (m.type === 'user' && !m.isSidechain) entries.push(m) } catch { /* torn write */ }
  }
  let hit = msg.uuid ? entries.find((m) => m.uuid === msg.uuid) : undefined
  if (!hit && msg.text) {
    let seen = 0
    hit = entries.find((m) => { const t = typed(m); return !!t && t.startsWith(msg.text) && seen++ === msg.nth })
  }
  return hit ? hit.parentUuid ?? null : undefined
}

// ---- directories ------------------------------------------------------------

export function listDirs(p: string, hidden: boolean): { path: string; parent: string | null; dirs: string[] } {
  const abs = path.resolve(p)
  const dirs = fs.readdirSync(abs, { withFileTypes: true })
    .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && (hidden || !d.name.startsWith('.')))
    .filter((d) => { try { return fs.statSync(path.join(abs, d.name)).isDirectory() } catch { return false } })
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  const parent = path.dirname(abs)
  return { path: abs, parent: parent === abs ? null : parent, dirs }
}
