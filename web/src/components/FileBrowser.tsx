// The Files pane: the session's folder as a tree, the files the agent wrote or edited, the files
// you attached (shared/files.ts), and a viewer for the one you pick. A path in a reply opens here
// too (AssistantMessage.tsx). The server decides which files the pane may open (server/files.ts).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SessionMeta } from '../../../shared/types.ts'
import { filesIn } from '../../../shared/files.ts'
import { mediaKind } from '../../../shared/media.ts'
import { api, changed, LOCAL, localId, machineOf, media, state, useStore } from '../store.ts'
import { highlight, langOfPath } from '../highlight.ts'
import { renderMd } from '../util.ts'
import { BackIcon, ChevronIcon, FileIcon, FolderIcon, OpenIcon, XIcon } from './Icons.tsx'

type Entry = { name: string; kind: 'dir' | 'file'; size: number; mtime: number; dim?: boolean; secret?: boolean }
type Node = { path: string; kind: 'dir'; entries: Entry[] } | { path: string; kind: 'file'; size: number; mtime: number }

// The files attached to its messages, newest first.
export function filesOf(sid: string): string[] {
  const names: string[] = []
  for (const e of state.events[sid] ?? []) if (e.t === 'user') for (const p of e.parts) names.push(...filesIn(p.text ?? ''))
  return [...new Set(names.reverse())]
}

// The files the agent wrote or edited, newest first.
function changedOf(sid: string): string[] {
  const out: string[] = []
  for (const e of state.events[sid] ?? []) {
    if (e.t !== 'assistant') continue
    for (const b of e.blocks) if (b.type === 'tool_use' && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name)) {
      const p = b.input?.file_path ?? b.input?.notebook_path
      if (typeof p === 'string') out.push(p)
    }
  }
  return [...new Set(out.reverse())]
}

// Opens the pane on a path (absolute, ~/, or under the session's directory), maybe with :line.
export function openFile(sid: string, p: string) {
  const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(p.trim())!
  state.filesPane = true
  state.fileOpen = { ...state.fileOpen, [sid]: { path: m[1], line: m[2] ? Number(m[2]) : undefined, at: Date.now() } }
  changed()
}

const TEXT_MAX = 512 * 1024      // the first part of a long text file
const TEXT_MORE = 4 * 1024 * 1024 // and the most that "Show more" loads (through web.codinger.app an answer is one message)
const HIGHLIGHT_MAX = 200 * 1024 // longer text shows without colours
const sepOf = (p: string) => p.includes('\\') && !p.includes('/') ? '\\' : '/'
const baseName = (p: string) => p.split(/[\\/]/).pop() || p
const dirName = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')))
// A path in a box that cuts it at the start (direction: rtl) keeps its slashes where they are.
const ltr = (p: string) => `\u200e${p}\u200e`
const kb = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? `${r.status} ${r.statusText}`)
  return j
}

export function FileBrowser({ m, width, onHide }: { m: SessionMeta; width: number; onHide(): void }) {
  const st = useStore()
  const machine = machineOf(m.id)
  const base = `/api/sessions/${localId(m.id)}`
  const fsUrl = (p: string) => media(`${base}/fs?path=${encodeURIComponent(p)}`, machine)
  const fileUrl = (p: string, run = false) => media(`${base}/file?path=${encodeURIComponent(p)}${run ? '&run=1' : ''}`, machine)
  const [root, setRoot] = useState<string | null>(null)
  const [roots, setRoots] = useState<string[]>([])     // folders outside the session's folder that a link opened
  const [dirs, setDirs] = useState<Record<string, Entry[] | string>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [file, setFile] = useState<{ path: string; size: number; line?: number; at: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [stamp, setStamp] = useState(0)                // a change makes the open file load again
  const want = st.fileOpen[m.id]

  const load = (dir: string) => getJson<Node>(fsUrl(dir))
    .then((n) => { if (n.kind === 'dir') setDirs((d) => ({ ...d, [dir]: n.entries })) })
    .catch((e: Error) => setDirs((d) => ({ ...d, [dir]: e.message })))

  useEffect(() => {
    void getJson<Node>(fsUrl('.')).then((n) => {
      setRoot(n.path)
      if (n.kind === 'dir') setDirs((d) => ({ ...d, [n.path]: n.entries }))
    }).catch((e: Error) => setErr(e.message))
  }, [m.id])

  // A path to show (a link in a reply, or a pick in the list): a folder opens in the tree, a file in the viewer.
  useEffect(() => {
    if (!want || !root) return
    setErr(null)
    void getJson<Node>(fsUrl(want.path)).then((n) => {
      const sep = sepOf(n.path)
      const inRoot = n.path === root || n.path.startsWith(root + sep)
      const top = inRoot ? root : n.kind === 'dir' ? n.path : dirName(n.path)
      if (!inRoot && n.kind === 'dir' && !roots.includes(top)) setRoots((r) => [...r, top])
      // Open the folders down to it.
      const chain: string[] = []
      for (let d = n.kind === 'dir' ? n.path : dirName(n.path); inRoot && d.length >= root.length; d = dirName(d)) { chain.push(d); if (d === root) break }
      if (n.kind === 'dir') { chain.push(n.path); setDirs((d) => ({ ...d, [n.path]: n.entries })) }
      setOpen((o) => new Set([...o, ...chain]))
      for (const d of chain) if (!dirs[d]) void load(d)
      setFile(n.kind === 'file' ? { path: n.path, size: n.size, line: want.line, at: want.at } : null)
    }).catch((e: Error) => { setFile(null); setErr(`${want.path}: ${e.message}`) })
  }, [want?.at, root])

  // When the agent works, the folders and the file on view load again.
  const n = st.events[m.id]?.length ?? 0
  useEffect(() => {
    if (!n || !root) return
    const t = setTimeout(() => {
      for (const d of open) if (dirs[d]) void load(d)
      setStamp((s) => s + 1)
    }, 1500)
    return () => clearTimeout(t)
  }, [n])

  const rel = (p: string) => {
    if (root && p.startsWith(root + sepOf(p))) return p.slice(root.length + 1)
    return st.home && p.startsWith(st.home) ? '~' + p.slice(st.home.length) : p
  }
  const pick = (p: string) => openFile(m.id, p)
  const toggle = (d: string) => setOpen((o) => {
    const x = new Set(o)
    if (x.has(d)) x.delete(d); else { x.add(d); if (!dirs[d]) void load(d) }
    return x
  })

  const tree = (dir: string, depth: number): React.ReactNode => {
    const list = dirs[dir]
    if (list === undefined) return <div className="fb-note muted" style={{ paddingLeft: 8 + depth * 14 }}>Loading…</div>
    if (typeof list === 'string') return <div className="fb-note muted" style={{ paddingLeft: 8 + depth * 14 }}>{list}</div>
    if (!list.length) return <div className="fb-note muted" style={{ paddingLeft: 8 + depth * 14 }}>Empty</div>
    const sep = sepOf(dir)
    return list.map((e) => {
      const p = dir + sep + e.name
      const isOpen = open.has(p)
      return (
        <div key={e.name}>
          <button className={`fb-row${e.dim ? ' dim' : ''}${file?.path === p ? ' on' : ''}`} style={{ paddingLeft: 4 + depth * 14 }}
            disabled={e.secret} onClick={() => e.kind === 'dir' ? toggle(p) : pick(p)}>
            {e.kind === 'dir' ? <span className={`fb-chev${isOpen ? ' open' : ''}`}><ChevronIcon size={10} /></span> : <span className="fb-chev" />}
            {e.kind === 'dir' ? <FolderIcon size={13} /> : <FileIcon size={13} />}
            <span className="fb-name">{e.name}</span>
            {e.secret && <span className="fb-dir muted">can hold keys, not shown</span>}
          </button>
          {e.kind === 'dir' && isOpen && tree(p, depth + 1)}
        </div>
      )
    })
  }

  const changedFiles = changedOf(m.id)
  const attached = filesOf(m.id)
  const flat = (title: string, paths: string[]) => paths.length > 0 && (
    <div className="fb-group">
      <div className="attention-head">{title}</div>
      {paths.map((p) => (
        <button key={p} className={`fb-row${file && (file.path === p || rel(file.path) === p) ? ' on' : ''}`} onClick={() => pick(p)}>
          <FileIcon size={13} /><span className="fb-name">{baseName(p)}</span>
          <span className="fb-dir muted">{ltr(dirName(rel(p)))}</span>
        </button>
      ))}
    </div>
  )
  const split = width >= 720
  const list = (
    <div className="fb-list">
      {flat('Changed in this session', changedFiles.slice(0, 30))}
      {flat('Attached', attached)}
      {root && <div className="fb-group">
        <div className="attention-head">{baseName(root)}</div>
        {tree(root, 0)}
      </div>}
      {roots.map((r) => <div key={r} className="fb-group"><div className="attention-head">{rel(r)}</div>{tree(r, 0)}</div>)}
    </div>
  )
  const close = () => {
    setFile(null)
    setErr(null)
    const { [m.id]: _, ...rest } = state.fileOpen
    state.fileOpen = rest
    changed()
  }
  return (
    <aside className={`attention files-panel file-browser${split ? ' split' : ''}`} style={{ width }}>
      <div className="attention-top">
        <span className="attention-head"><FolderIcon size={12} /> Files</span>
        <button className="icon-btn" data-tip="Hide" onClick={onHide}><XIcon size={13} /></button>
      </div>
      {err && !file && <div className="fb-note error-text">{err}</div>}
      <div className="fb-body">
        {(split || !file) && list}
        {file && <FileView key={file.path} path={file.path} size={file.size} line={file.line} at={file.at} stamp={stamp} rel={rel(file.path)}
          url={fileUrl} canBack={!split} onBack={close} reveal={machine === LOCAL && !st.web ? () => void api('/api/fs/reveal', 'POST', { path: file.path }) : undefined}
          onLink={(href) => pick(dirName(file.path) + sepOf(file.path) + href)} />}
      </div>
    </aside>
  )
}

type ViewProps = {
  path: string; size: number; line?: number; at: number; stamp: number; rel: string
  url(p: string, run?: boolean): string; canBack: boolean; onBack(): void; reveal?(): void; onLink(href: string): void
}

function FileView({ path, size, line, at, stamp, rel, url, canBack, onBack, reveal, onLink }: ViewProps) {
  const kind = mediaKind(path)
  const ext = langOfPath(path)?.toLowerCase() ?? ''
  const isMd = ext === 'md' || ext === 'markdown'
  const isCsv = ext === 'csv' || ext === 'tsv'
  const [source, setSource] = useState(false)
  const [more, setMore] = useState(false)
  const limit = more ? TEXT_MORE : TEXT_MAX
  const [text, setText] = useState<string | null>(null)
  const [binary, setBinary] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const asText = kind === 'file' || (kind === 'page' && source) || (kind === 'image' && ext === 'svg' && source)
  useEffect(() => {
    if (!asText) return
    let gone = false
    fetch(url(path), { headers: size > limit ? { range: `bytes=0-${limit - 1}` } : {} })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText)
        const buf = new Uint8Array(await r.arrayBuffer())
        if (gone) return
        if (buf.subarray(0, 8000).includes(0)) { setBinary(true); return }
        setText(new TextDecoder().decode(buf))
      })
      .catch((e: Error) => { if (!gone) setErr(e.message) })
    return () => { gone = true }
  }, [path, asText, stamp, limit])

  const can = kind === 'page' || isMd || isCsv || ext === 'svg'
  return (
    <div className="fb-view">
      <div className="fb-bar">
        {canBack && <button className="icon-btn" data-tip="Back to the list" onClick={onBack}><BackIcon size={14} /></button>}
        <span className="fb-path mono">{ltr(rel)}</span>
        <span className="muted fb-size">{kb(size)}</span>
        {can && <button className={`fb-toggle${source ? ' on' : ''}`} onClick={() => setSource(!source)}>Source</button>}
        {reveal && <button className="icon-btn" data-tip="Show in Finder" onClick={reveal}><FolderIcon size={13} /></button>}
        <a className="icon-btn" href={url(path, kind === 'page')} target="_blank" rel="noreferrer" data-tip="Open in a new tab"><OpenIcon size={13} /></a>
      </div>
      <div className="fb-content">
        {err ? <div className="fb-note error-text">{err}</div>
          : binary ? <div className="fb-note muted">This file is not text. Use the button at the top right to open it in a new tab.</div>
          : kind === 'image' && !source ? <div className="fb-media"><img src={`${url(path)}&t=${stamp}`} alt={rel} /></div>
          : kind === 'video' ? <div className="fb-media"><video src={url(path)} controls /></div>
          : kind === 'audio' ? <div className="fb-media"><audio src={url(path)} controls /></div>
          : kind === 'pdf' ? <iframe className="fb-frame" src={url(path)} title={rel} />
          : kind === 'page' && !source ? <iframe className="fb-frame" sandbox="allow-scripts allow-popups" src={`${url(path, true)}&t=${stamp}`} title={rel} />
          : text === null ? <div className="fb-note muted">Loading…</div>
          : <>
            {size > limit && <div className="fb-note muted">The file is {kb(size)}. This shows the first {kb(limit)}.{!more && <> <button className="link" onClick={() => setMore(true)}>{size > TEXT_MORE ? `Show the first ${kb(TEXT_MORE)}` : 'Show all'}</button></>}</div>}
            {isMd && !source ? <Markdown text={text} url={url} dir={dirName(path)} onLink={onLink} />
              : isCsv && !source ? <Table text={text} tab={ext === 'tsv'} />
              : <Code text={text} lang={ext} line={line} at={at} />}
          </>}
      </div>
    </div>
  )
}

function Code({ text, lang, line, at }: { text: string; lang: string; line?: number; at: number }) {
  const mark = useRef<HTMLDivElement>(null)
  const html = text.length > HIGHLIGHT_MAX ? highlight(text, undefined) : highlight(text, lang)
  const count = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  useLayoutEffect(() => { mark.current?.scrollIntoView({ block: 'center' }) }, [line, at])
  return (
    <div className="fb-code">
      <pre className="fb-gutter">{Array.from({ length: Math.max(count, 1) }, (_, i) => i + 1).join('\n')}</pre>
      <div className="fb-lines">
        {line && line <= count && <div ref={mark} className="fb-mark" style={{ top: `calc(${line - 1} * var(--fb-lh))` }} />}
        <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
      </div>
    </div>
  )
}

// Images and links with a path relative to the file come from its folder.
function Markdown({ text, url, dir, onLink }: { text: string; url(p: string): string; dir: string; onLink(href: string): void }) {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = el.current
    if (!root) return
    const local = (u: string | null) => !!u && !/^([a-z][a-z0-9+.-]*:|\/\/|#|\/api\/)/i.test(u)
    for (const img of root.querySelectorAll('img')) {
      const src = img.getAttribute('src')
      if (local(src)) img.src = url(dir + sepOf(dir) + decodeURI(src!))
    }
    for (const a of root.querySelectorAll('a')) {
      const href = a.getAttribute('href')
      if (local(href)) a.addEventListener('click', (e) => { e.preventDefault(); onLink(decodeURI(href!.split('#')[0])) })
    }
  }, [text])
  return <div ref={el} className="md fb-md" dangerouslySetInnerHTML={{ __html: renderMd(text) }} />
}

// CSV with quoted fields; the first 2,000 rows.
function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length && rows.length < 2001; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += c }
    else if (c === '"') q = true
    else if (c === sep) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

function Table({ text, tab }: { text: string; tab: boolean }) {
  const [head, ...rows] = parseCsv(text, tab ? '\t' : ',')
  if (!head) return <div className="fb-note muted">Empty</div>
  return (
    <div className="fb-table">
      <table>
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{rows.slice(0, 2000).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
      {rows.length > 2000 && <div className="fb-note muted">This shows the first 2,000 rows.</div>}
    </div>
  )
}
