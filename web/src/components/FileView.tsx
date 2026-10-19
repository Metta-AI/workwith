// The file on view in the Files tab (FileBrowser.tsx): markdown rendered or its source, code with
// colours and line numbers, CSV as a table, images, video, audio, PDF, and HTML in a sandbox. Changes
// shows what changed: git's diff against the last commit, or, where git has none, the edits the
// agent made in this session. Wrap (kept for every file) wraps long lines of code and changes.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { mediaKind } from '../../../shared/media.ts'
import { highlight, langOfPath } from '../highlight.ts'
import { renderMd } from '../util.ts'
import { BackIcon, FolderIcon, OpenIcon } from './Icons.tsx'

const TEXT_MAX = 512 * 1024       // the first part of a long text file
const TEXT_MORE = 4 * 1024 * 1024 // and the most that "Show more" loads (through web.codinger.app an answer is one message)
const HIGHLIGHT_MAX = 200 * 1024  // longer text shows without colours

export const sepOf = (p: string) => p.includes('\\') && !p.includes('/') ? '\\' : '/'
export const baseName = (p: string) => p.split(/[\\/]/).pop() || p
export const dirName = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/'), p.lastIndexOf('\\')))
// A path in a box that cuts it at the start (direction: rtl) keeps its slashes where they are.
export const ltr = (p: string) => `‎${p}‎`
const kb = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

// An edit the agent made to a file: the text it replaced (none for a file it wrote) and the new text.
export type Edit = { old?: string; new: string }
type Diff = { status: 'changed' | 'new' | 'same' | 'none'; diff: string }

type Props = {
  path: string; size: number; line?: number; at: number; stamp: number; rel: string; changes: boolean; edits: Edit[]
  url(p: string, run?: boolean): string; tabUrl: string; diffUrl: string
  canBack: boolean; onBack(): void; reveal?(): void; onLink(href: string): void
}

export function FileView({ path, size, line, at, stamp, rel, changes, edits, url, tabUrl, diffUrl, canBack, onBack, reveal, onLink }: Props) {
  const kind = mediaKind(path)
  const ext = langOfPath(path)?.toLowerCase() ?? ''
  const isMd = ext === 'md' || ext === 'markdown'
  const isCsv = ext === 'csv' || ext === 'tsv'
  const [source, setSource] = useState(false)
  const [showDiff, setShowDiff] = useState(changes)
  const [wrap, setWrapState] = useState(() => localStorage.getItem('codinger.fileWrap') === '1')
  const setWrap = (on: boolean) => { localStorage.setItem('codinger.fileWrap', on ? '1' : '0'); setWrapState(on) }
  const [more, setMore] = useState(false)
  const limit = more ? TEXT_MORE : TEXT_MAX
  const [text, setText] = useState<string | null>(null)
  const [binary, setBinary] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [diff, setDiff] = useState<Diff | null>(null)
  useEffect(() => { if (changes) setShowDiff(true) }, [at])

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

  // What git says changed: asked for each file of text, so the Changes button shows only where there are changes.
  useEffect(() => {
    if (kind !== 'file' && kind !== 'page') return
    let gone = false
    fetch(diffUrl).then((r) => r.ok ? r.json() : null).then((d: Diff | null) => { if (!gone) setDiff(d) }).catch(() => {})
    return () => { gone = true }
  }, [path, stamp])
  const gitChanged = !!diff && (diff.status === 'changed' || diff.status === 'new') && !!diff.diff.trim()
  const hasChanges = gitChanged || edits.length > 0
  const diffOn = showDiff && hasChanges

  const can = kind === 'page' || isMd || isCsv || ext === 'svg'
  const codeLike = diffOn || (asText && !(isMd && !source) && !(isCsv && !source))
  return (
    <div className="fb-view">
      <div className="fb-bar">
        {canBack && <button className="icon-btn" data-tip="Back to the list" onClick={onBack}><BackIcon size={14} /></button>}
        <span className="fb-path mono">{ltr(rel)}</span>
        <span className="muted fb-size">{kb(size)}</span>
        {hasChanges && <button className={`fb-toggle${diffOn ? ' on' : ''}`} data-pid="file-changes" onClick={() => setShowDiff(!diffOn)}>Changes</button>}
        {can && !diffOn && <button className={`fb-toggle${source ? ' on' : ''}`} data-pid="file-source" onClick={() => setSource(!source)}>Source</button>}
        {codeLike && <button className={`fb-toggle${wrap ? ' on' : ''}`} data-pid="file-wrap" onClick={() => setWrap(!wrap)}>Wrap</button>}
        {reveal && <button className="icon-btn" data-tip="Show in Finder" onClick={reveal}><FolderIcon size={13} /></button>}
        <a className="icon-btn" href={tabUrl} target="_blank" rel="noreferrer" data-tip="Open in a new tab"><OpenIcon size={13} /></a>
      </div>
      <div className="fb-content">
        {diffOn ? (gitChanged ? <DiffLines diff={diff!.diff} lang={ext} wrap={wrap} /> : <EditLines edits={edits} lang={ext} wrap={wrap} />)
          : err ? <div className="fb-note error-text">{err}</div>
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
              : <Code text={text} lang={ext} line={line} at={at} wrap={wrap} />}
          </>}
      </div>
    </div>
  )
}

// highlight's HTML cut into lines: a span open at the end of a line closes there and opens again on the next.
function htmlLines(html: string): string[] {
  const out: string[] = []
  const open: string[] = []
  let cur = ''
  for (const m of html.matchAll(/(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g)) {
    if (m[1]) { open.push(m[1]); cur += m[1] }
    else if (m[2]) { open.pop(); cur += m[2] }
    else if (m[3]) { out.push(cur + '</span>'.repeat(open.length)); cur = open.join('') }
    else cur += m[4]
  }
  out.push(cur + '</span>'.repeat(open.length))
  return out
}

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)
const lang = (text: string, l: string) => text.length > HIGHLIGHT_MAX ? undefined : l

// Rows of code, each with its numbers; one HTML string, so a long file is quick to show.
type Row = { cls?: string; nums: (number | string)[]; html: string }
function Rows({ rows, wrap, mark, at }: { rows: Row[]; wrap: boolean; mark?: number; at?: number }) {
  const el = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { el.current?.querySelector('.fb-ln.mark')?.scrollIntoView({ block: 'center' }) }, [mark, at])
  const cols = rows[0]?.nums.length ?? 1
  const width = Math.max(2, ...rows.map((r) => Math.max(...r.nums.map((n) => String(n).length))))
  const html = rows.map((r, i) => `<div class="fb-ln${r.cls ? ` ${r.cls}` : ''}${mark === i + 1 ? ' mark' : ''}">${r.nums.map((n) => `<span class="fb-n">${n}</span>`).join('')}<span class="fb-c">${r.html || ' '}</span></div>`).join('')
  return <div ref={el} className={`fb-code hljs${wrap ? ' wrap' : ''}`} style={{ '--fb-nw': `${width + 1}ch`, '--fb-cols': cols } as React.CSSProperties} dangerouslySetInnerHTML={{ __html: html }} />
}

function Code({ text, lang: l, line, at, wrap }: { text: string; lang: string; line?: number; at: number; wrap: boolean }) {
  const lines = htmlLines(highlight(text.endsWith('\n') ? text.slice(0, -1) : text, lang(text, l)))
  return <Rows rows={lines.map((html, i) => ({ nums: [i + 1], html }))} wrap={wrap} mark={line} at={at} />
}

// A unified diff: each line with its number before and after, a removed line red, an added one green.
function DiffLines({ diff, lang: l, wrap }: { diff: string; lang: string; wrap: boolean }) {
  const rows: Row[] = []
  let o = 0, n = 0
  const hl = (s: string) => htmlLines(highlight(s, lang(diff, l)))[0] ?? ''
  for (const line of diff.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (h) { o = Number(h[1]); n = Number(h[2]); rows.push({ cls: 'hunk', nums: ['', ''], html: escapeHtml(line) }); continue }
    if (!o && !n) continue   // the header: diff --git, index, ---, +++
    if (line.startsWith('+')) rows.push({ cls: 'add', nums: ['', n++], html: hl(line.slice(1)) })
    else if (line.startsWith('-')) rows.push({ cls: 'del', nums: [o++, ''], html: hl(line.slice(1)) })
    else if (line.startsWith(' ')) rows.push({ nums: [o++, n++], html: hl(line.slice(1)) })
  }
  return <Rows rows={rows} wrap={wrap} />
}

// The agent's edits, where git has no changes to show (no repository, or they are committed).
function EditLines({ edits, lang: l, wrap }: { edits: Edit[]; lang: string; wrap: boolean }) {
  const rows: Row[] = []
  edits.forEach((e, i) => {
    rows.push({ cls: 'hunk', nums: [''], html: e.old == null ? `The agent wrote the file (${i + 1} of ${edits.length})` : `Edit ${i + 1} of ${edits.length}` })
    // A last newline is the end of the last line, not a line of its own.
    const trim = (t: string) => t.endsWith('\n') ? t.slice(0, -1) : t
    if (e.old != null) for (const h of htmlLines(highlight(trim(e.old), lang(e.old, l)))) rows.push({ cls: 'del', nums: ['−'], html: h })
    for (const h of htmlLines(highlight(trim(e.new), lang(e.new, l)))) rows.push({ cls: 'add', nums: ['+'], html: h })
  })
  return (
    <>
      <div className="fb-note muted">Git shows no changes to this file, so these are the agent's edits in this session.</div>
      <Rows rows={rows} wrap={wrap} />
    </>
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
