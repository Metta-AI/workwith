// The files of a session, for the Files pane (web/src/components/FileBrowser.tsx): its folders
// and the files in them, and which files the pane may open. On web.codinger.app anyone with
// your login can use the pane, so it does not open any path: only files under the session's
// directory or the artifacts folder, and files (or folders) that the agent named in a reply or
// wrote or edited.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { Event, SessionMeta } from '../shared/types.ts'
import { ARTIFACTS } from './artifacts.ts'
import { expandHome } from './store.ts'

export type Entry = { name: string; kind: 'dir' | 'file'; size: number; mtime: number; dim?: boolean; secret?: boolean }

// Files that hold keys or passwords: the pane lists them but does not open them (the agent can still read them).
export const isSecret = (p: string) => /^\.env(?!\.(example|sample|template)$)(\..+)?$|\.(pem|key)$/i.test(path.basename(p))

// The real path; for a file not there yet, its folder's real path (on macOS /tmp is /private/tmp).
function real(p: string): string {
  try { return fs.realpathSync(p) } catch {}
  const dir = path.dirname(p)
  return dir === p ? p : path.join(real(dir), path.basename(p))
}
const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

// A path as an agent writes it: absolute, ~/, or under the session's directory, maybe with :line.
export const resolveIn = (cwd: string, p: string) => path.resolve(expandHome(cwd), expandHome(p.trim().replace(/(:\d+){1,2}$/, '')))

// Paths in inline code and in links of a reply, and the files the agent wrote or edited.
const CODE = /`([^`\n]{1,400})`/g
const LINK = /\]\(([^)\s]{1,400})\)/g
const PATHLIKE = /^(?:~|\.{0,2})\/|^[\w.@+-]+\//
const named = new Map<string, { n: number; paths: Set<string> }>()
function namedBy(meta: SessionMeta, events: Event[]): Set<string> {
  const had = named.get(meta.id)
  if (had && had.n === events.length) return had.paths
  const paths = new Set<string>()
  const add = (p: unknown) => {
    if (typeof p !== 'string' || p.includes('://')) return
    const abs = real(resolveIn(meta.cwd, p))
    // A named home folder (or a folder above it) would open every file: not that.
    if (!under(os.homedir(), abs)) paths.add(abs)
  }
  for (const e of events) {
    if (e.t !== 'assistant') continue
    for (const b of e.blocks) {
      if (b.type === 'text') {
        for (const m of b.text.matchAll(CODE)) if (PATHLIKE.test(m[1])) add(m[1])
        for (const m of b.text.matchAll(LINK)) if (PATHLIKE.test(m[1])) add(m[1])
      } else if (b.type === 'tool_use' && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name)) add(b.input?.file_path ?? b.input?.notebook_path)
    }
  }
  named.set(meta.id, { n: events.length, paths })
  return paths
}

// The full path the pane may open, or null.
export function allowed(meta: SessionMeta, events: Event[], p: string): string | null {
  const abs = real(resolveIn(meta.cwd, p))
  if (isSecret(abs)) return null
  if (under(abs, real(expandHome(meta.cwd))) || under(abs, real(ARTIFACTS))) return abs
  for (const n of namedBy(meta, events)) if (under(abs, n)) return abs
  return null
}

// Which of names (in dir) git ignores; none if dir is not in a git repository.
function ignored(dir: string, names: string[]): Promise<Set<string>> {
  if (!names.length) return Promise.resolve(new Set())
  return new Promise((ok) => {
    const child = execFile('git', ['-C', dir, 'check-ignore', '-z', '--stdin'], { timeout: 3000 }, (_err, out) => {
      ok(new Set(String(out ?? '').split('\0').filter(Boolean)))
    })
    child.stdin?.end(names.join('\0') + '\0')
    child.on('error', () => ok(new Set()))
  })
}

// The folders first, then the files, each by name. .git and what git ignores show dimmed; secret files are marked.
export async function listDir(dir: string): Promise<Entry[]> {
  const out: Entry[] = []
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === '.DS_Store') continue
    let st: fs.Stats
    try { st = fs.statSync(path.join(dir, d.name)) } catch { continue }
    out.push({ name: d.name, kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs })
  }
  const ign = await ignored(dir, out.map((e) => e.name))
  for (const e of out) {
    if (e.name === '.git' || ign.has(e.name)) e.dim = true
    if (e.kind === 'file' && isSecret(e.name)) e.secret = true
  }
  return out.sort((a, b) => a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
}
