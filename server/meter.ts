// How much of your plan's usage limits a token costs, learned by watching.
// Claude Code reports the limits only as percentages used (rate_limit_event),
// never in tokens. So the meter adds up what every Claude Code conversation on
// this machine spends (Codinger's and the terminal's: all write transcripts to
// ~/.claude/projects) between two reports, and compares that with how far the
// percentages moved. Everything it sees goes to meter.jsonl, to check later how
// steady the estimate is (GET /api/meter).
//
// Spend is in dollars at each model's API prices (shared/prices.ts), so a Haiku
// token and an Opus token count for what they cost. Log lines carry v: 2; older
// ones counted every model's tokens alike, and are left out of the estimate.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA } from './store.ts'
import type { Usage } from '../shared/types.ts'
import { costOf } from '../shared/prices.ts'

export const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')
const LOG = path.join(DATA, 'meter.jsonl')
const KEEP = 3 * 24 * 3600_000        // how far back the estimate looks
const RUN = randomUUID().slice(0, 8)  // spend before this run started was not seen: never pair across runs

type Sample = { t: number; run: string; five?: number; seven?: number; resetsAt?: number; cum: number }
const offsets = new Map<string, number>()
const seen = new Map<string, { usd: number; t: number }>()   // message id → dollars counted, as its lines come in
let cum = 0
let samples: Sample[] = []
let started = false

const V = 2
// Who else hears of each call's spend, and of each prompt you send (server/costs.ts).
type Count = { t: number; usd: number; model: string; prompt?: boolean }
const listeners: ((e: Count) => void)[] = []
export const onCount = (f: (e: Count) => void) => { listeners.push(f) }
const tell = (e: Count) => { for (const f of listeners) f(e) }
// Where each transcript stood when this run started: the meter counts from there.
const first = new Map<string, number>()
export const startOffsets = () => new Map(first)

// A prompt you sent, not a tool result, a command's output or Claude Code's own note.
export function isPrompt(m: any) {
  if (m.type !== 'user' || m.isMeta || m.isSidechain) return false
  const c = m.message?.content
  if (typeof c === 'string') return !/^\s*<(command-name|local-command|task-notification)/.test(c)
  return Array.isArray(c) && c.some((b: any) => b.type === 'text') && !c.some((b: any) => b.type === 'tool_result')
}
const log = (x: object) => fs.appendFile(LOG, JSON.stringify({ v: V, ...x }) + '\n', () => {})
const usd = (x: number) => Math.round(x * 1e4) / 1e4

function load() {
  try {
    for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
      if (!line) continue
      const x = JSON.parse(line)
      if (x.v !== V) continue
      if (typeof x.cum === 'number') cum = Math.max(cum, x.cum)
      if (x.k === 'limit' && Date.now() - x.t < KEEP) samples.push({ t: x.t, run: x.run, five: x.five, seven: x.seven, resetsAt: x.resetsAt, cum: x.cum })
    }
  } catch {}
}

function files(dir: string, depth: number, out: string[]) {
  let list: fs.Dirent[]
  try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of list) {
    const p = path.join(dir, e.name)
    if (e.isDirectory() && depth > 0) files(p, depth - 1, out)
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
}

// Read what transcripts gained since the last look. Files there at start count
// from their end; new files from their start.
export function poll() {
  const all: string[] = []
  files(PROJECTS, 6, all)   // workflow agents: <project>/<session>/subagents/workflows/<run>/agent-….jsonl
  if (!started) {
    started = true
    load()
    for (const f of all) { try { offsets.set(f, fs.statSync(f).size) } catch {} }
    for (const [f, n] of offsets) first.set(f, n)
    return
  }
  let added = 0
  const models: Record<string, number> = {}
  for (const f of all) {
    let size: number
    try { size = fs.statSync(f).size } catch { continue }
    const from = offsets.get(f) ?? 0
    if (size <= from) { if (size < from) offsets.set(f, size); continue }
    const buf = Buffer.alloc(size - from)
    try { const fd = fs.openSync(f, 'r'); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd) } catch { continue }
    // Only whole lines; a half-written one waits for the next look.
    const end = buf.lastIndexOf(10)
    if (end < 0) continue
    offsets.set(f, from + end + 1)
    const sub = f.includes(`${path.sep}subagents${path.sep}`)
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!sub && line.includes('"type":"user"')) {
        try { const m = JSON.parse(line); if (isPrompt(m)) tell({ t: Date.parse(m.timestamp) || Date.now(), usd: 0, model: '', prompt: true }) } catch {}
        continue
      }
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
      let m: any
      try { m = JSON.parse(line) } catch { continue }
      const msg = m.message
      if (m.type !== 'assistant' || !msg?.usage || !msg.id || msg.model === '<synthetic>') continue
      // A message's blocks come as separate lines with the usage so far: count only what grew.
      const n = costOf(msg.usage, msg.model), prev = seen.get(msg.id)?.usd ?? 0
      if (n <= prev) continue
      seen.set(msg.id, { usd: n, t: Date.now() })
      added += n - prev
      tell({ t: Date.parse(m.timestamp) || Date.now(), usd: n - prev, model: msg.model })
      models[msg.model] = (models[msg.model] ?? 0) + n - prev
    }
  }
  for (const [id, x] of seen) if (Date.now() - x.t > 24 * 3600_000) seen.delete(id)
  for (const k in models) models[k] = usd(models[k])
  if (added) { cum += added; log({ t: Date.now(), k: 'spend', usd: usd(added), models, cum: usd(cum), run: RUN }) }
}

// Spend that leaves no transcript to read: calls made without saving one (server/notes.ts).
export function spend(u: any, model: string) {
  const n = costOf(u, model)
  if (!n) return
  cum += n
  tell({ t: Date.now(), usd: n, model })
  log({ t: Date.now(), k: 'spend', usd: usd(n), models: { [model]: usd(n) }, cum: usd(cum), run: RUN })
}

// A report of the limits, from any session. Several sessions send the same one.
export function limit(u: Usage) {
  if (u.fiveHour == null && u.sevenDay == null) return
  poll()
  const last = samples.at(-1)
  if (last && last.run === RUN && last.five === u.fiveHour && last.seven === u.sevenDay && last.cum === cum) return
  const s: Sample = { t: Date.now(), run: RUN, five: u.fiveHour, seven: u.sevenDay, resetsAt: u.resetsAt, cum }
  samples.push(s)
  samples = samples.filter((x) => Date.now() - x.t < KEEP)
  log({ ...s, cum: usd(s.cum), k: 'limit', status: u.status })
}

// The last report saved, so after a restart the limits show before a session sends the next one.
// Not one older than the 5-hour window, nor a 5-hour share whose window has reset since.
export function last(): Usage {
  const s = samples.at(-1)
  if (!s || Date.now() - s.t > 5 * 3600_000) return {}
  const live = s.resetsAt == null || s.resetsAt * 1000 > Date.now()
  return { fiveHour: live ? s.five : undefined, sevenDay: s.seven, resetsAt: live ? s.resetsAt : undefined }
}

// Consecutive reports in one run, with spend between them and the percentage
// not reset in between: how much each moved.
export function pairs(win: 'five' | 'seven') {
  const out: { t: number; usd: number; moved: number }[] = []
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i]
    const x = a[win], y = b[win]
    if (a.run !== b.run || x == null || y == null || y < x || b.cum <= a.cum) continue
    out.push({ t: b.t, usd: usd(b.cum - a.cum), moved: y - x })
  }
  return out
}

// The share of each limit that a dollar of spend uses, once there is enough to go on.
export function rate(): NonNullable<Usage['rate']> {
  const est = (win: 'five' | 'seven') => {
    const p = pairs(win)
    const moved = p.reduce((s, x) => s + x.moved, 0), spent = p.reduce((s, x) => s + x.usd, 0)
    return p.length >= 3 && moved >= 0.02 && spent > 0 ? moved / spent : undefined
  }
  return { fiveHour: est('five'), sevenDay: est('seven'), pairs: pairs('five').length }
}
