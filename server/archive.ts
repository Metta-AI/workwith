// Codinger's own copy of every Claude Code transcript on this machine.
// Claude Code deletes its transcripts after 30 days; the copy in
// ~/.codinger/archive/transcripts is kept until you delete it, with the same
// folders as ~/.claude/projects. Each pass adds the whole lines a transcript
// gained since the last one. A transcript that got shorter (rewritten) keeps
// its old copy under a new name, with the time, and is copied again.
//
// The copy is slim: images (most of a transcript's size: screenshots the
// agents read) lose their data; the API request records, the context Claude
// Code repeats in each turn and the thinking signatures are left out; and a
// text longer than CAP keeps its start only. Usage, prompts, replies and tool
// calls stay, so the usage ledger (server/usage.ts) reads the copy, not the
// originals, and can always be built again from it.

import fs from 'node:fs'
import path from 'node:path'
import { DATA } from './store.ts'
import { PROJECTS } from './meter.ts'
import type { ArchiveInfo } from '../shared/usage.ts'

export const ARCHIVE = path.join(DATA, 'archive', 'transcripts')

export async function files(dir: string, depth: number, out: string[] = []): Promise<string[]> {
  let list: fs.Dirent[]
  try { list = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of list) {
    const p = path.join(dir, e.name)
    if (e.isDirectory() && depth > 0) await files(p, depth - 1, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

const size = (f: string) => fs.promises.stat(f).then((s) => s.size, () => 0)

let info: ArchiveInfo = { dir: ARCHIVE, bytes: 0, files: 0, at: null }
export const archiveInfo = () => info

const CAP = 16_000
const STATE = path.join(ARCHIVE, '..', 'offsets.json')
let offsets: Record<string, number> = {}
try { offsets = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch {}

// Images without their data, and long texts cut, anywhere in a line.
function trim(x: any): any {
  if (typeof x === 'string') return x.length > CAP ? `${x.slice(0, CAP)}… [${(x.length - CAP).toLocaleString('en')} more characters left out of Codinger's copy]` : x
  if (Array.isArray(x)) return x.map(trim)
  if (!x || typeof x !== 'object') return x
  const out: any = {}
  for (const k in x) {
    if ((k === 'data' || k === 'base64') && typeof x[k] === 'string' && x[k].length > 1000) { out[k] = ''; out.omittedBytes = x[k].length; continue }
    out[k] = trim(x[k])
  }
  return out
}
// Context Claude Code adds to each turn: the same text again and again.
const BOILERPLATE = new Set(['prompt_snapshot', 'skill_listing', 'total_tokens_reminder', 'instructions', 'deferred_tools_delta', 'deferred_tools_record', 'mcp_instructions_delta', 'environment'])
export function slim(line: string): string | null {
  if (line.length <= CAP && !/"type":"(api-request|attachment|assistant)/.test(line)) return line
  let m: any
  try { m = JSON.parse(line) } catch { return line }
  if (typeof m.type === 'string' && m.type.startsWith('api-request')) return null
  if (m.type === 'attachment' && BOILERPLATE.has(m.attachment?.type)) return null
  if (m.type === 'assistant') {
    // The same tool inputs as the message's, and the thinking's signature: only the API reads them.
    delete m.wireToolInputs
    if (Array.isArray(m.message?.content)) for (const b of m.message.content) if (b?.type === 'thinking') delete b.signature
  }
  return JSON.stringify(trim(m))
}

// Read a file from a byte offset, in batches of whole lines. Returns where the last whole line ends.
export async function readLines(file: string, from: number, each: (batch: string[]) => void | Promise<void>): Promise<number> {
  const fh = await fs.promises.open(file, 'r')
  try {
    const size = (await fh.stat()).size
    const buf = Buffer.alloc(4 << 20)
    let pos = from, rest = Buffer.alloc(0)
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos)
      if (!bytesRead) break
      pos += bytesRead
      const chunk = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
      const end = chunk.lastIndexOf(10)
      if (end < 0) { rest = Buffer.from(chunk); continue }
      await each(chunk.toString('utf8', 0, end).split('\n'))
      rest = Buffer.from(chunk.subarray(end + 1))
    }
    return pos - rest.length
  } finally { await fh.close() }
}

// Copy what is new. Returns the copies that changed.
export async function archive(): Promise<string[]> {
  const changed: string[] = []
  for (const f of await files(PROJECTS, 6)) {
    const rel = path.relative(PROJECTS, f), dst = path.join(ARCHIVE, rel)
    const n = await size(f)
    let from = offsets[rel] ?? 0
    if (n === from) continue
    if (n < from) {
      try { await fs.promises.rename(dst, dst.replace(/\.jsonl$/, `.${Date.now()}.jsonl`)) } catch {}
      from = 0
    }
    try {
      await fs.promises.mkdir(path.dirname(dst), { recursive: true })
      const out = await fs.promises.open(dst, 'a', 0o600)
      try {
        offsets[rel] = await readLines(f, from, async (batch) => {
          const keep = batch.map(slim).filter((l): l is string => l != null && l !== '')
          if (keep.length) await out.write(keep.join('\n') + '\n')
        })
      } finally { await out.close() }
      changed.push(dst)
    } catch {}
  }
  if (changed.length) await fs.promises.writeFile(STATE, JSON.stringify(offsets))
  let bytes = 0
  const all = await files(ARCHIVE, 6)
  for (const f of all) bytes += await size(f)
  info = { dir: ARCHIVE, bytes, files: all.length, at: Date.now() }
  return changed
}
