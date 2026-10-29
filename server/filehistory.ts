// Where the notes you and Claude keep came from. Each tracked file (AGENTS.md,
// your global CLAUDE.md, the lead's LEAD_NOTES.md, and any you add in Settings)
// keeps every version, with who made it: you in Settings, a Codinger session at
// the message where Claude edited it, a Claude Code session elsewhere (found
// in its transcript), or someone outside. Blame per line comes from diffing the
// versions in order.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DATA } from './store.ts'

export type By =
  | { kind: 'initial' }
  | { kind: 'settings' }
  | { kind: 'session'; sid: string; title: string; seq: number }
  | { kind: 'claude'; csid: string; cwd: string }
  | { kind: 'outside' }
export type Version = { ts: number; by: By; text: string }

const DIR = path.join(DATA, 'history')
fs.mkdirSync(DIR, { recursive: true })
const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')

const fileOf = (p: string) => path.join(DIR, `${createHash('sha1').update(p).digest('hex').slice(0, 16)}.jsonl`)
const cache = new Map<string, Version[]>()

export function versions(p: string): Version[] {
  let v = cache.get(p)
  if (v) return v
  v = []
  try { for (const l of fs.readFileSync(fileOf(p), 'utf8').split('\n')) if (l.trim()) try { v.push(JSON.parse(l)) } catch { /* torn */ } } catch { /* none yet */ }
  cache.set(p, v)
  return v
}

// A tracked file that moved keeps its history.
export function moveHistory(from: string, to: string) {
  if (fs.existsSync(fileOf(from)) && !fs.existsSync(fileOf(to))) fs.renameSync(fileOf(from), fileOf(to))
}

const read = (p: string) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
let changed: (p: string) => void = () => {}

// Record the file as it is now, if it differs from the last version.
export function record(p: string, by: By): boolean {
  const text = read(p)
  if (text == null) return false
  const vs = versions(p)
  if (vs.at(-1)?.text === text) return false
  const v = { ts: Date.now(), by: vs.length ? by : { kind: 'initial' as const }, text }
  vs.push(v)
  fs.appendFileSync(fileOf(p), JSON.stringify(v) + '\n')
  changed(p)
  return true
}

// ---- who changed it -----------------------------------------------------------

const tilde = (p: string) => p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p
// Does a tool call touch this file: an edit to it, or a shell command that names it?
export function touches(name: string, input: any, p: string): boolean {
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return input?.file_path === p || input?.notebook_path === p
  if (name === 'Bash' && typeof input?.command === 'string') return input.command.includes(p) || input.command.includes(tilde(p))
  return false
}

// A Claude Code session (any, Codinger's or a terminal's) that touched the file in
// the last few minutes, from the tails of the transcripts written lately.
function claudeEditor(p: string): { csid: string; cwd: string; toolUseId: string } | null {
  const since = Date.now() - 3 * 60_000
  let best: { csid: string; cwd: string; toolUseId: string; ts: number } | null = null
  let dirs: string[] = []
  try { dirs = fs.readdirSync(PROJECTS) } catch { return null }
  for (const d of dirs) {
    let files: string[] = []
    try { files = fs.readdirSync(path.join(PROJECTS, d)).filter((f) => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      const file = path.join(PROJECTS, d, f)
      let st: fs.Stats
      try { st = fs.statSync(file) } catch { continue }
      if (st.mtimeMs < since) continue
      const len = Math.min(st.size, 512 * 1024)
      const buf = Buffer.alloc(len)
      const fd = fs.openSync(file, 'r')
      try { fs.readSync(fd, buf, 0, len, st.size - len) } finally { fs.closeSync(fd) }
      const text = buf.toString('utf8')
      if (!text.includes(path.basename(p))) continue
      for (const line of text.split('\n')) {
        if (!line.startsWith('{') || !line.includes('tool_use')) continue
        let m: any
        try { m = JSON.parse(line) } catch { continue }
        const ts = Date.parse(m.timestamp ?? '') || 0
        if (m.type !== 'assistant' || ts < since) continue
        for (const b of m.message?.content ?? []) {
          if (b.type === 'tool_use' && touches(b.name, b.input, p) && (!best || ts > best.ts)) best = { csid: m.sessionId ?? f.slice(0, -6), cwd: m.cwd ?? '', toolUseId: b.id, ts }
        }
      }
    }
  }
  return best
}

// ---- watching -------------------------------------------------------------------

type Session = { sid: string; title: string; csid: string; seqOf(toolUseId: string): number | null }
let tracked: () => string[] = () => []
let sessions: () => Session[] = () => []

export function initFileHistory(o: { files(): string[]; sessions(): Session[]; changed(p: string): void }) {
  tracked = o.files
  sessions = o.sessions
  changed = o.changed
  for (const p of tracked()) record(p, { kind: 'initial' })
  // Edits by Codinger sessions are recorded as they happen (noteEdit); this catches the rest.
  const seen = new Map<string, string>()
  setInterval(() => {
    for (const p of tracked()) {
      let key = ''
      try { const st = fs.statSync(p); key = `${st.mtimeMs}:${st.size}` } catch { continue }
      if (seen.get(p) === key) continue
      seen.set(p, key)
      if (versions(p).at(-1)?.text === read(p)) continue
      record(p, attribute(p))
    }
  }, 3000).unref()
}

function attribute(p: string): By {
  const ed = claudeEditor(p)
  if (!ed) return { kind: 'outside' }
  const s = sessions().find((x) => x.csid === ed.csid)
  const seq = s?.seqOf(ed.toolUseId)
  return s && seq != null ? { kind: 'session', sid: s.sid, title: s.title, seq } : { kind: 'claude', csid: ed.csid, cwd: ed.cwd }
}

// A Codinger session's tool call finished: if it touched a tracked file, record it now.
export function noteEdit(name: string, input: any, by: By) {
  for (const p of tracked()) if (touches(name, input, p)) record(p, by)
}

// ---- blame ----------------------------------------------------------------------

// For each line of b, the index of the line of a it is unchanged from, if any (LCS).
export function keep(a: string[], b: string[]): (number | null)[] {
  const n = a.length, m = b.length
  if (n * m > 4_000_000) return b.map(() => null)
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: (number | null)[] = b.map(() => null)
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out[j] = i; i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}

// The current text, which version wrote each line, and each version's who, when and size of change.
export function blame(p: string) {
  const vs = versions(p)
  let lines: string[] = []
  let from: number[] = []
  const stats = vs.map((v, k) => {
    const next = v.text.split('\n')
    const kept = keep(lines, next)
    const added = kept.filter((x) => x == null).length
    const removed = lines.length - (next.length - added)
    from = kept.map((x, j) => x == null ? k : from[x])
    lines = next
    return { ts: v.ts, by: v.by, added, removed }
  })
  const now = read(p)
  return { path: p, exists: now != null, text: lines.join('\n'), lines: from, versions: stats, outOfDate: now != null && now !== vs.at(-1)?.text }
}
