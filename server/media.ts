// Files an agent shows the user (shared/media.ts): with show_file, or as a markdown image
// in its message. Each is copied to ~/.codinger/media when the agent shows it, so it still
// shows after the agent changes or deletes the file, and only files an agent chose are served.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { MEDIA_URL, mediaExt } from '../shared/media.ts'
import { MEDIA, expandHome } from './store.ts'

export const MEDIA_MAX = 500 * 1024 * 1024
// The most one range request gets (server/index.ts: /api/media).
export const MEDIA_PART = 4 * 1024 * 1024

// Copies still under way, by kept name: a request for one waits for it.
const copying = new Map<string, Promise<void>>()

// The address comes at once (named by the file's path, size and time, not by reading it all);
// the copy follows.
export function keepMedia(file: string, st: fs.Stats): string {
  const name = `${createHash('sha256').update(`${file}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 24)}.${mediaExt(file)}`
  const kept = path.join(MEDIA, name)
  if (!copying.has(name) && !fs.existsSync(kept)) {
    const part = `${kept}.part`
    copying.set(name, fs.promises.copyFile(file, part).then(() => fs.promises.rename(part, kept)).catch(() => {}).finally(() => copying.delete(name)))
  }
  return `/api/media/${name}`
}

export async function mediaFile(url: string): Promise<string | null> {
  const name = MEDIA_URL.exec(url)?.[1]
  if (!name) return null
  await copying.get(name)
  return path.join(MEDIA, name)
}

// A file path an agent gave (absolute, ~/, or relative to its directory), kept; null when it
// is an address, or no file that can be kept.
export function keepPath(p: string, cwd: string): string | null {
  if (/^[a-z][\w+.-]*:/i.test(p) && !/^[a-z]:[\\/]/i.test(p)) return null
  if (p.startsWith('/api/') || p.startsWith('#')) return null
  let file = p
  try { file = decodeURI(p) } catch { /* as written */ }
  file = path.resolve(cwd, expandHome(file))
  let st: fs.Stats
  try { st = fs.statSync(file) } catch { return null }
  return st.isFile() && st.size <= MEDIA_MAX ? keepMedia(file, st) : null
}

const IMAGE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))((?:\s+"[^"\n]*")?\s*)\)/g

// An agent's message with its markdown images of local files (`![caption](shot.png)`)
// pointed at kept copies. Code blocks and inline code stay as written.
export function keepMediaIn(text: string, cwd: string): string {
  if (!text.includes('![')) return text
  let fence = false
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return line }
    if (fence) return line
    return line.split(/(`+[^`]*`+)/).map((part, i) => i % 2 ? part : part.replace(IMAGE, (m, alt: string, angled?: string, bare?: string, title = '') => {
      const url = keepPath(angled ?? bare ?? '', cwd)
      return url ? `![${alt}](${url}${title})` : m
    })).join('')
  }).join('\n')
}
