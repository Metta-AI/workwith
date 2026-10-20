// Who changed the files with uncommitted changes in a git repository: a Codinger session's tool call
// (an edit, or a shell command), or you (an editor, or any program outside the agents). When a tool
// call that can change files starts, Codinger asks git which files have changes and reads those that
// changed since it last looked: those changes are yours. When the call ends, it looks again: a file
// changed after the call started is the session's. An edit can run before Codinger reads the file
// at its start: then the text before the edit (the new text with the edit undone) shows your
// changes, if any, and goes in first as yours. Each file keeps its versions with their author (DATA/changes), from the text of
// its last commit on, and blame per line comes from the versions in order (filehistory.ts keep). A
// file that git shows clean again loses its versions. The Changes view gets this with the diff
// (server/index.ts, web/src/authors.ts).

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { DATA } from './store.ts'
import { keep } from './filehistory.ts'

// who: a session's id, 'you', or 'unknown' (changed before Codinger looked at the file the first time).
// claim: the session said these changes are its own (claim_changes): lines of text (from 1), or all.
type Version = { ts: number; who: string; text: string; claim?: [number, number][] | 'all' }

const DIR = path.join(DATA, 'changes')
fs.mkdirSync(DIR, { recursive: true })
const MAX = 1024 * 1024   // a longer file keeps no versions
const TOOLS = /^(Bash|Write|Edit|MultiEdit|NotebookEdit|Agent|Task)$/   // the tool calls that can change files

const fileOf = (p: string) => path.join(DIR, `${createHash('sha1').update(p).digest('hex').slice(0, 16)}.jsonl`)
const cache = new Map<string, Version[]>()
const seen = new Map<string, string>()   // by file: its mtime and size when Codinger last read it

const run = (args: string[], cwd: string) => new Promise<string | null>((ok) => {
  execFile('git', args, { cwd, timeout: 5000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => ok(err ? null : String(out)))
})

function versions(p: string): Version[] {
  let v = cache.get(p)
  if (v) return v
  v = []
  try { for (const l of fs.readFileSync(fileOf(p), 'utf8').split('\n')) if (l.trim()) try { v.push(JSON.parse(l)) } catch { /* torn */ } } catch { /* none yet */ }
  cache.set(p, v)
  return v
}
function add(p: string, v: Version) {
  versions(p).push(v)
  fs.appendFileSync(fileOf(p), JSON.stringify(v) + '\n')
}
function forget(p: string) {
  cache.delete(p)
  seen.delete(p)
  fs.rm(fileOf(p), { force: true }, () => {})
}

// One look at a time in each repository; files a repository had changed the last time.
const busy = new Map<string, Promise<void>>()
const dirty = new Map<string, Set<string>>()
// The tool calls that run now, by id: when they started.
const open = new Map<string, number>()

export function toolStarted(cwd: string, id: string, tool: string, ts: number) {
  if (!TOOLS.test(tool)) return
  open.set(id, ts)
  // A file the call changes at once has a newer time than its start, and waits for its end.
  queue(cwd, () => look(cwd, 'you', Infinity, ts - 100))
}

// A tool call of a session ended: started is when it started, input what it got.
export function toolEnded(cwd: string, id: string, tool: string, input: any, sid: string, started: number) {
  open.delete(id)
  if (!TOOLS.test(tool)) return
  const file = typeof input?.file_path === 'string' ? path.resolve(cwd, input.file_path) : null
  const edits: { old: string; new: string; all?: boolean }[] = tool === 'Edit' ? [{ old: input.old_string, new: input.new_string, all: !!input.replace_all }]
    : tool === 'MultiEdit' && Array.isArray(input?.edits) ? input.edits.map((e: any) => ({ old: e.old_string, new: e.new_string, all: !!e.replace_all })) : []
  queue(cwd, () => look(cwd, sid, started, Infinity, file && edits.every((e) => typeof e.old === 'string' && typeof e.new === 'string') ? { file, edits } : undefined))
}

// The text before the edits: the new text with them undone, last first; null when it does not fit.
function undo(text: string, edits: { old: string; new: string; all?: boolean }[]): string | null {
  for (const e of [...edits].reverse()) {
    if (!e.new || !text.includes(e.new)) return null
    text = e.all ? text.split(e.new).join(e.old) : text.replace(e.new, () => e.old)
  }
  return text
}

function queue(cwd: string, f: () => Promise<void>): Promise<void> {
  const next = (busy.get(cwd) ?? Promise.resolve()).then(f).catch(() => {})
  busy.set(cwd, next)
  return next
}

// Before the Changes view shows a file: what changed since the last tool call is yours, except a
// change made while a tool call runs, which waits for that call to end.
export function refresh(cwd: string): Promise<void> {
  const until = Math.min(Infinity, ...open.values()) - 100
  return queue(cwd, () => look(cwd, 'you', Infinity, until))
}

async function look(cwd: string, sid: string, started: number, until = Infinity, edit?: { file: string; edits: { old: string; new: string; all?: boolean }[] }) {
  let editReal: string | null = null
  if (edit) try { editReal = fs.realpathSync(edit.file) } catch {}
  const top = (await run(['rev-parse', '--show-toplevel'], cwd))?.trim()
  if (!top) return
  const st = await run(['status', '--porcelain', '-z', '--untracked-files=all'], top)
  if (st == null) return
  const now = new Set<string>()
  const recs = st.split('\0')
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]
    if (r.length < 4) continue
    if (r[0] === 'R' || r[0] === 'C') i++
    now.add(path.join(top, r.slice(3)))
  }
  for (const p of dirty.get(top) ?? []) if (!now.has(p)) forget(p)
  dirty.set(top, now)
  for (const p of now) {
    let s: fs.Stats
    try { s = fs.statSync(p) } catch { continue }
    if (!s.isFile() || s.size > MAX || s.mtimeMs >= until) continue
    const key = `${s.mtimeMs}:${s.size}`
    if (seen.get(p) === key) continue
    seen.set(p, key)
    const text = fs.readFileSync(p, 'utf8')
    const vs = versions(p)
    if (vs.at(-1)?.text === text) continue
    const mine = s.mtimeMs >= started - 100
    const had = vs.length > 0
    if (!had) {
      const base = await run(['show', `HEAD:${path.relative(top, p).split(path.sep).join('/')}`], top)
      add(p, { ts: 0, who: 'base', text: base ?? '' })
    }
    if (mine && p === editReal) {
      const before = undo(text, edit!.edits)
      if (before != null && before !== vs.at(-1)!.text) add(p, { ts: Date.now(), who: had ? 'you' : 'unknown', text: before })
    }
    add(p, { ts: Date.now(), who: mine ? sid : had ? 'you' : 'unknown', text })
  }
}

// Who wrote each line of the file now (by its number, from 1), and who removed each line of its last
// commit (by its number there); null where Codinger does not know. None when it keeps no versions.
// The versions must start from the text of the last commit (a commit since then makes them useless).
export async function whoChanged(p: string): Promise<{ add: Record<number, string>; del: Record<number, string> } | null> {
  const vs = versions(p)
  if (vs.length < 2) return null
  const top = (await run(['rev-parse', '--show-toplevel'], path.dirname(p)))?.trim()
  const head = top ? await run(['show', `HEAD:${path.relative(top, p).split(path.sep).join('/')}`], top) : null
  if ((head ?? '') !== vs[0].text) { forget(p); return null }
  // By version: which one wrote each line now, and which one removed each line of the commit.
  let lines = vs[0].text.split('\n')
  let from: number[] = lines.map(() => 0)
  let alive: (number | null)[] = lines.map((_, i) => i)   // where each line of the commit is now
  const removed: Record<number, number> = {}
  vs.forEach((v, k) => {
    if (!k) return
    const next = v.text.split('\n')
    const kept = keep(lines, next)
    const back = new Map<number, number>()
    kept.forEach((x, j) => { if (x != null) back.set(x, j) })
    from = kept.map((x, j) => x == null ? k : from[x])
    alive = alive.map((at, i) => {
      if (at == null) return null
      const j = back.get(at)
      if (j == null) { removed[i + 1] = k; return null }
      return j
    })
    lines = next
    // A claim takes the lines it names, and the lines of the commit that the same versions removed.
    if (v.claim) {
      const take = from.map((f, j) => f > 0 && (v.claim === 'all' || (v.claim as [number, number][]).some(([a, b]) => j + 1 >= a && j + 1 <= b)))
      const by = new Set(from.filter((_, j) => take[j]))
      from = from.map((f, j) => take[j] ? k : f)
      for (const [i, r] of Object.entries(removed)) if (v.claim === 'all' || by.has(r)) removed[Number(i)] = k
    }
  })
  const who = (k: number) => vs[k].who
  const added: Record<number, string> = {}
  from.forEach((f, j) => { if (f > 0 && who(f) !== 'unknown') added[j + 1] = who(f) })
  const del: Record<number, string> = {}
  for (const [i, r] of Object.entries(removed)) if (who(r) !== 'unknown') del[Number(i)] = who(r)
  return { add: added, del }
}

// A session says that changes in a file are its own: lines of the file as it is now, or all of them.
// What changed before and was not looked at yet counts as yours first. Returns how many of the
// file's changed lines it now has, or a reason why it has none.
export async function claim(cwd: string, file: string, sid: string, lines: [number, number][] | 'all'): Promise<number | string> {
  await refresh(cwd)
  let p = file
  try { p = fs.realpathSync(file) } catch { return 'There is no such file.' }
  const vs = versions(p)
  if (vs.length < 2) return 'Git shows no uncommitted changes in it (or it is over 1 MB).'
  let text: string
  try { text = fs.readFileSync(p, 'utf8') } catch { return 'Codinger cannot read it.' }
  add(p, { ts: Date.now(), who: sid, text, claim: lines })
  const w = await whoChanged(p)
  return w ? Object.values(w.add).filter((x) => x === sid).length + Object.values(w.del).filter((x) => x === sid).length : 0
}
