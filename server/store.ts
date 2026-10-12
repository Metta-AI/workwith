// On-disk state, all under ~/.codiner:
//   sessions.json        every session's metadata
//   events/<id>.jsonl    each session's event log, append-only
//   images/<sha>.<ext>   images pasted into replies (content-addressed)
//   master/              the master agent's working directory (NOTES.md lives here)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Event, ImageRef, SessionMeta, Settings } from '../shared/types.ts'

export const DATA = process.env.CODINER_HOME ?? path.join(os.homedir(), '.codiner')
const EVENTS = path.join(DATA, 'events')
export const IMAGES = path.join(DATA, 'images')
export const MASTER_DIR = path.join(DATA, 'master')
for (const d of [DATA, EVENTS, IMAGES, MASTER_DIR]) fs.mkdirSync(d, { recursive: true })

const SESSIONS = path.join(DATA, 'sessions.json')
const SETTINGS = path.join(DATA, 'settings.json')

export function loadSessions(): SessionMeta[] {
  try { return JSON.parse(fs.readFileSync(SESSIONS, 'utf8')) } catch { return [] }
}

let saveTimer: NodeJS.Timeout | null = null
export function saveSessions(all: () => SessionMeta[]) {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const tmp = SESSIONS + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(all(), null, 1))
    fs.renameSync(tmp, SESSIONS)
  }, 200)
}

export function loadSettings(): Settings {
  try { return { masterAutoSend: false, ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) } } catch { return { masterAutoSend: false } }
}
export function saveSettings(s: Settings) { fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 1)) }

// Context window per model. Claude Code only reports it in a turn's result, so
// remember what each model reported and use it from the start next time.
const WINDOWS = path.join(DATA, 'windows.json')
const windows: Record<string, number> = (() => { try { return JSON.parse(fs.readFileSync(WINDOWS, 'utf8')) } catch { return {} } })()
export function knownWindow(model: string | null | undefined): number {
  if (model && windows[model]) return windows[model]
  return model && /-[5-9]/.test(model) ? 1_000_000 : 200_000 // the 5.x models have 1M windows
}
export function learnWindow(model: string, w: number) {
  if (!model || !w || windows[model] === w) return
  windows[model] = w
  fs.writeFile(WINDOWS, JSON.stringify(windows, null, 1), () => {})
}

const eventsFile = (id: string) => path.join(EVENTS, `${id}.jsonl`)

export function readEvents(id: string): Event[] {
  let raw = ''
  try { raw = fs.readFileSync(eventsFile(id), 'utf8') } catch { return [] }
  const out: Event[] = []
  for (const line of raw.split('\n')) if (line.trim()) try { out.push(JSON.parse(line)) } catch { /* torn write */ }
  return out
}

export function appendEvent(id: string, e: Event) {
  fs.appendFileSync(eventsFile(id), JSON.stringify(e) + '\n')
}

export function writeEvents(id: string, events: Event[]) {
  const tmp = eventsFile(id) + '.tmp'
  fs.writeFileSync(tmp, events.map((e) => JSON.stringify(e) + '\n').join(''))
  fs.renameSync(tmp, eventsFile(id))
}

export function deleteEvents(id: string) {
  fs.rmSync(eventsFile(id), { force: true })
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export function saveImage(dataUrl: string): ImageRef {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(dataUrl)
  if (!m || !EXT[m[1]]) throw new Error('Unsupported image (use PNG, JPEG, GIF or WebP)')
  const buf = Buffer.from(m[2], 'base64')
  const name = `${createHash('sha256').update(buf).digest('hex').slice(0, 24)}.${EXT[m[1]]}`
  const file = path.join(IMAGES, name)
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf)
  return { url: `/api/images/${name}`, mediaType: m[1] }
}

export function imageFile(url: string): string | null {
  const name = /^\/api\/images\/([\w]+\.(png|jpg|gif|webp))$/.exec(url)?.[1]
  return name ? path.join(IMAGES, name) : null
}

export function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}
