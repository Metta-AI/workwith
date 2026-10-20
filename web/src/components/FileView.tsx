// The file on view in the Files tab (FileBrowser.tsx): markdown rendered or its source, code with
// colours and line numbers, CSV as a table, images, video, audio, PDF, and HTML in a sandbox. Changes
// shows what changed: git's diff against the last commit, or, where git has none, the edits the
// agent made in this session. Wrap (kept for every file) wraps long lines of code and changes.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { mediaKind } from '../../../shared/media.ts'
import type { Verdict } from '../../../shared/review.ts'
import { highlight, langOfPath } from '../highlight.ts'
import { renderMd } from '../util.ts'
import { BackIcon, FolderIcon, OpenIcon } from './Icons.tsx'
import { localId, state, type LineDraft } from '../store.ts'
import { attribute, mineOf, othersOf, parseDiff, type Author, type Hunk, type Who } from '../authors.ts'
import { addLine, linesOf } from '../review.ts'
import { LineCard, VerdictButtons } from './Review.tsx'

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
type Diff = { status: 'changed' | 'new' | 'same' | 'none'; diff: string; authors?: Author[]; who?: Who | null }

// The file's group for review (Review.tsx): its verdict, and the next file that has none.
export type ReviewOf = { group: string; verdict?: Verdict; sent: boolean; onVerdict(v: Verdict | null): void; next?: { label: string; go(): void } }

type Props = {
  sid: string; path: string; size: number; line?: number; at: number; stamp: number; rel: string; changes: boolean; edits: Edit[]
  url(p: string, run?: boolean): string; tabUrl: string; diffUrl: string; review?: ReviewOf
  canBack: boolean; onBack(): void; reveal?(): void; onLink(href: string): void
}

export function FileView({ sid, path, size, line, at, stamp, rel, changes, edits, url, tabUrl, diffUrl, review, canBack, onBack, reveal, onLink }: Props) {
  const kind = mediaKind(path)
  const ext = langOfPath(path)?.toLowerCase() ?? ''
  const isMd = ext === 'md' || ext === 'markdown'
  const isCsv = ext === 'csv' || ext === 'tsv'
  const [source, setSource] = useState(false)
  const [showDiff, setShowDiff] = useState(changes)
  const [allChanges, setAllChanges] = useState(false)   // also the changes of other sessions
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
  // git's changes by session: this session's only, until you ask for all of them.
  const me = localId(sid)
  const hunks = useMemo(() => { const h = parseDiff(diff?.diff ?? ''); attribute(h, diff?.authors ?? [], diff?.who); return h }, [diff])
  const others = othersOf(hunks, me)
  const names: Names = new Map([...(diff?.authors ?? []).map((a, i) => [a.id, { title: a.id === me ? 'This session' : a.title, n: i }] as const), ['you', { title: 'You', n: -1 }]])
  const shownHunks = allChanges ? hunks : mineOf(hunks, me)
  const hasChanges = gitChanged || edits.length > 0
  const diffOn = showDiff && hasChanges

  const can = kind === 'page' || isMd || isCsv || ext === 'svg'
  // Markdown shows its changes rendered too; Source shows them as lines (with comments on lines).
  const mdDiff = diffOn && isMd && !source
  const codeLike = (diffOn && !mdDiff) || (asText && !(isMd && !source) && !(isCsv && !source))
  // Comments on lines: a click or a drag on the line numbers starts one.
  const lines = linesOf(sid, path)
  const focus = state.focus
  const notes: Notes = {
    list: lines,
    card: (d) => <LineCard key={d.id} sid={sid} d={d} focus={focus === d.id} />,
    pick: (s) => addLine(sid, { ...s, group: review?.group, path, rel, verdict: 'unsure', text: '' }),
  }
  return (
    <div className="fb-view">
      <div className="fb-bar">
        {canBack && <button className="icon-btn" data-tip="Back to the list" onClick={onBack}><BackIcon size={14} /></button>}
        <span className="fb-path mono">{ltr(rel)}</span>
        <span className="muted fb-size">{kb(size)}</span>
        {hasChanges && <button className={`fb-toggle${diffOn ? ' on' : ''}`} data-pid="file-changes" onClick={() => setShowDiff(!diffOn)}>Changes</button>}
        {diffOn && gitChanged && others.size > 0 && <button className={`fb-toggle${allChanges ? ' on' : ''}`} data-pid="file-all-changes"
          data-tip={`Also changed by ${[...others].map((id) => id === 'you' ? 'you' : names.get(id)?.title ?? id).join(', ')}`} onClick={() => setAllChanges(!allChanges)}>All changes</button>}
        {can && (!diffOn || isMd) && <button className={`fb-toggle${source ? ' on' : ''}`} data-pid="file-source" onClick={() => setSource(!source)}>Source</button>}
        {codeLike && <button className={`fb-toggle${wrap ? ' on' : ''}`} data-pid="file-wrap" onClick={() => setWrap(!wrap)}>Wrap</button>}
        {reveal && <button className="icon-btn" data-tip="Show in Finder" onClick={reveal}><FolderIcon size={13} /></button>}
        <a className="icon-btn" href={tabUrl} target="_blank" rel="noreferrer" data-tip="Open in a new tab"><OpenIcon size={13} /></a>
      </div>
      {review && (
        <div className="fb-bar rv-bar" data-pid="file-review">
          {review.next && <button className="link rv-next" data-pid="review-next" onClick={review.next.go}>Next: {review.next.label} →</button>}
          <span className="grow" />
          {review.sent && <span className="muted rv-sent">sent</span>}
          <VerdictButtons value={review.verdict} sent={review.sent} onSet={review.onVerdict} label />
        </div>
      )}
      <div className="fb-content">
        {codeLike && review && !lines.length && <div className="fb-note muted rv-hint">To comment on lines, click or drag their numbers.</div>}
        {diffOn && gitChanged && !shownHunks.length && <div className="fb-note muted">This session did not change this file. Other sessions did: use All changes to see them.</div>}
        {mdDiff ? <MarkdownChanges chunks={gitChanged ? diffChunks(shownHunks) : editChunks(edits)} edits={!gitChanged} url={url} dir={dirName(path)} onLink={onLink} />
          : diffOn ? (gitChanged ? <DiffLines hunks={shownHunks} me={me} all={allChanges} names={names} lang={ext} wrap={wrap} notes={notes} /> : <EditLines edits={edits} lang={ext} wrap={wrap} />)
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
              : <Code text={text} lang={ext} line={line} at={at} wrap={wrap} notes={notes} />}
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

// Rows of code, each with its numbers; HTML strings, so a long file is quick to show. ln: the line
// a comment names (old: a line the change removed, by its number before); text: its code.
type Row = { cls?: string; nums: (number | string)[]; html: string; ln?: number; old?: boolean; text?: string }
// Comments on lines: each shows below the last of its lines; pick: you chose lines for a new one.
type Pick = { line: number; end: number; old?: boolean; code: string }
type Notes = { list: LineDraft[]; card(d: LineDraft): React.ReactNode; pick(s: Pick): void }

function Rows({ rows, wrap, mark, at, notes }: { rows: Row[]; wrap: boolean; mark?: number; at?: number; notes?: Notes }) {
  const el = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { el.current?.querySelector('.fb-ln.mark')?.scrollIntoView({ block: 'center' }) }, [mark, at])
  const cols = rows[0]?.nums.length ?? 1
  const width = Math.max(2, ...rows.map((r) => Math.max(...r.nums.map((n) => String(n).length))))
  // The rows of each comment, and the row it shows after (-1: its lines are not on view, so at the top).
  const sel = new Set<number>()
  const after = new Map<number, LineDraft[]>()
  for (const d of notes?.list ?? []) {
    let last = -1
    rows.forEach((r, i) => { if (r.ln != null && !!r.old === !!d.old && r.ln >= d.line && r.ln <= d.end) { sel.add(i); last = i } })
    after.set(last, [...after.get(last) ?? [], d])
  }
  const html = rows.map((r, i) => `<div class="fb-ln${r.cls ? ` ${r.cls}` : ''}${mark === i + 1 ? ' mark' : ''}${sel.has(i) ? ' sel' : ''}${notes && r.ln != null ? ' pickable' : ''}" data-i="${i}">${r.nums.map((n) => `<span class="fb-n">${n}</span>`).join('')}<span class="fb-c">${r.html || ' '}</span></div>`)
  const cuts = [...after.keys()].filter((i) => i >= 0).sort((a, b) => a - b)
  const segs: [number, number][] = []
  let from = 0
  for (const c of cuts) { segs.push([from, c + 1]); from = c + 1 }
  segs.push([from, rows.length])

  // A press on a line number chooses that line; a drag, the lines between; Shift, from the last one chosen.
  const anchor = useRef<number | null>(null)
  const down = (e: React.PointerEvent) => {
    if (!notes || e.button !== 0) return
    const n = (e.target as HTMLElement).closest('.fb-n')
    const i = Number(n?.parentElement?.dataset.i)
    if (!n || !rows[i] || rows[i].ln == null) return
    e.preventDefault()
    const start = e.shiftKey && anchor.current != null ? anchor.current : i
    anchor.current = start
    let end = i
    const live = (a: number, b: number) => {
      for (const x of el.current?.querySelectorAll('.fb-ln.live') ?? []) x.classList.remove('live')
      for (let j = Math.min(a, b); j <= Math.max(a, b); j++) el.current?.querySelector(`.fb-ln[data-i="${j}"]`)?.classList.add('live')
    }
    live(start, end)
    const move = (ev: PointerEvent) => {
      const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.fb-ln[data-i]')
      if (row && el.current?.contains(row)) { end = Number(row.dataset.i); live(start, end) }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      for (const x of el.current?.querySelectorAll('.fb-ln.live') ?? []) x.classList.remove('live')
      const picked = rows.slice(Math.min(start, end), Math.max(start, end) + 1).filter((r) => r.ln != null)
      // Lines on both sides of a change are named by their numbers after it.
      const side = picked.some((r) => !r.old) ? picked.filter((r) => !r.old) : picked
      if (!side.length) return
      const nums = side.map((r) => r.ln!)
      notes.pick({ line: Math.min(...nums), end: Math.max(...nums), ...(side[0].old ? { old: true } : {}), code: side.find((r) => r.text?.trim())?.text ?? '' })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div ref={el} className={`fb-code hljs${wrap ? ' wrap' : ''}${notes ? ' notes' : ''}`} style={{ '--fb-nw': `${width + 1}ch`, '--fb-cols': cols } as React.CSSProperties} onPointerDown={down}>
      {after.get(-1)?.map((d) => notes!.card(d))}
      {segs.map(([a, b]) => (
        <Fragment key={a}>
          <div dangerouslySetInnerHTML={{ __html: html.slice(a, b).join('') }} />
          {after.get(b - 1)?.map((d) => notes!.card(d))}
        </Fragment>
      ))}
    </div>
  )
}

function Code({ text, lang: l, line, at, wrap, notes }: { text: string; lang: string; line?: number; at: number; wrap: boolean; notes?: Notes }) {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const raw = body.split('\n')
  const lines = htmlLines(highlight(body, lang(text, l)))
  return <Rows rows={lines.map((html, i) => ({ nums: [i + 1], html, ln: i + 1, text: raw[i] }))} wrap={wrap} mark={line} at={at} notes={notes} />
}

// A unified diff: each line with its number before and after, a removed line red, an added one green.
// Without all, a run of lines that another session changed folds to one line with its name. With all
// (All changes), each run has the name of its session above it and a line of its colour at its left.
type Names = Map<string, { title: string; n: number }>
function DiffLines({ hunks, me, all, names, lang: l, wrap, notes }: { hunks: Hunk[]; me: string; all: boolean; names: Names; lang: string; wrap: boolean; notes?: Notes }) {
  const rows: Row[] = []
  const size = hunks.reduce((t, h) => t + h.rows.reduce((u, r) => u + r.text.length, 0), 0)
  const hl = (s: string) => htmlLines(highlight(s, size > HIGHLIGHT_MAX ? undefined : l))[0] ?? ''
  const label = (who: string | null | undefined) => who ? names.get(who)?.title ?? 'Another session' : 'Codinger does not know who changed these lines'
  const tone = (who: string | null | undefined) => who === me ? ' who-me' : who === 'you' ? ' who-you' : who ? ` who-${(names.get(who)?.n ?? 0) % 6}` : ''
  for (const h of hunks) {
    rows.push({ cls: 'hunk', nums: ['', ''], html: escapeHtml(h.head) })
    let prev: string | null | undefined = undefined
    let folded = null as { who: string; n: number; row: Row } | null
    for (const r of h.rows) {
      if (r.kind === 'ctx') { prev = undefined; folded = null; rows.push({ nums: [r.o, r.n], html: hl(r.text), ln: r.n, text: r.text }); continue }
      if (!all && r.who && r.who !== me) {
        if (folded?.who !== r.who) { folded = { who: r.who, n: 0, row: { cls: `who fold${tone(r.who)}`, nums: ['', ''], html: '' } }; rows.push(folded.row) }
        folded.n++
        folded.row.html = escapeHtml(`${folded.n} ${folded.n === 1 ? 'line' : 'lines'} changed by ${r.who === 'you' ? 'you' : label(r.who)}`)
        prev = r.who
        continue
      }
      folded = null
      if (all && r.who !== prev) rows.push({ cls: `who${tone(r.who)}`, nums: ['', ''], html: escapeHtml(label(r.who)) })
      prev = r.who
      const t = all ? tone(r.who) : ''
      if (r.kind === 'add') rows.push({ cls: `add${t}`, nums: ['', r.n], html: hl(r.text), ln: r.n, text: r.text })
      else rows.push({ cls: `del${t}`, nums: [r.o, ''], html: hl(r.text), ln: r.o, old: true, text: r.text })
    }
  }
  return <Rows rows={rows} wrap={wrap} notes={notes} />
}

// The agent's edits, where git has no changes to show (no repository, or they are committed).
function EditLines({ edits, lang: l, wrap }: { edits: Edit[]; lang: string; wrap: boolean }) {
  const rows: Row[] = []
  edits.forEach((e, i) => {
    rows.push({ cls: 'hunk', nums: [''], html: e.old == null ? `The agent wrote the file (${i + 1} of ${edits.length})` : `Edit ${i + 1} of ${edits.length}` })
    // A last newline is the end of the last line, not a line of its own.
    const trim = (t: string) => t.endsWith('\n') ? t.slice(0, -1) : t
    const add = (t: string, cls: 'del' | 'add') => {
      const raw = trim(t).split('\n')
      htmlLines(highlight(trim(t), lang(t, l))).forEach((h, j) => rows.push({ cls, nums: [cls === 'del' ? '−' : '+'], html: h, text: raw[j] }))
    }
    if (e.old != null) add(e.old, 'del')
    add(e.new, 'add')
  })
  return (
    <>
      <div className="fb-note muted">Git shows no changes to this file, so these are the agent's edits in this session.</div>
      <Rows rows={rows} wrap={wrap} />
    </>
  )
}

// The changes of a markdown file as runs of lines of one kind (unchanged, removed, added), each run
// rendered on its own; a gap between hunks of the diff ends a run too.
type Chunk = { cls: '' | 'add' | 'del' | 'gap'; text: string }
function chunked(lines: { cls: Chunk['cls']; text: string }[]): Chunk[] {
  const out: Chunk[] = []
  for (const x of lines) {
    const last = out.at(-1)
    if (last && last.cls === x.cls && x.cls !== 'gap') last.text += '\n' + x.text
    else out.push({ ...x })
  }
  return out
}
function diffChunks(hunks: Hunk[]): Chunk[] {
  return chunked(hunks.flatMap((h, i) => [
    ...(i ? [{ cls: 'gap' as const, text: '' }] : []),
    ...h.rows.map((r) => ({ cls: r.kind === 'ctx' ? '' as const : r.kind, text: r.text })),
  ]))
}
function editChunks(edits: Edit[]): Chunk[] {
  return edits.flatMap((e, i): Chunk[] => [
    ...(i ? [{ cls: 'gap' as const, text: '' }] : []),
    ...(e.old != null ? [{ cls: 'del' as const, text: e.old }] : []),
    { cls: 'add', text: e.new },
  ])
}

function MarkdownChanges({ chunks, edits, url, dir, onLink }: { chunks: Chunk[]; edits: boolean; url(p: string): string; dir: string; onLink(href: string): void }) {
  return (
    <div className="fb-mdiff">
      {edits && <div className="fb-note muted">Git shows no changes to this file, so these are the agent's edits in this session.</div>}
      {chunks.map((c, i) => c.cls === 'gap' ? <div key={i} className="fb-mgap" />
        : <div key={i} className={`fb-mchunk ${c.cls}`}><Markdown text={c.text} url={url} dir={dir} onLink={onLink} /></div>)}
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
