// The command palette: ⌘K (Ctrl+K off a Mac) opens a search over the sessions (archived ones
// too), the artifacts, the tasks, the files of the open session's folder and the folders of the
// sessions. Each type has its own tab, and All shows a few of each under a head. The tabs sit in
// a row of columns as wide as the palette, so one shows at a time, and a change of tab slides the
// row sideways. Each tab shows the most recent first, also for a query; a button changes a query's
// order to the best matches first. Down goes from the field into the results, and up from the
// first result goes back to the field. In the results, left and right change the tab; in the field
// they move the caret. Tab changes the tab anywhere, and Enter opens the result marked (from the
// field, the first). On a phone, a fast circle drawn with one finger opens the palette.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useEscape } from '../escape.ts'
import type { Event, SessionMeta, Task } from '../../../shared/types.ts'
import type { Artifact } from '../../../shared/artifacts.ts'
import { artifactsBase, changed, here, labelOf, localId, machineOf, media, select, showArchive, state, useStore } from '../store.ts'
import { fatigue, holdKeyboard, timeAgo } from '../util.ts'
import { onCircle } from '../../../shared/circle.ts'
import { Mascot } from './Mascot.tsx'
import { ArtifactIcon, openArtifact } from './Artifacts.tsx'
import { FolderIcon, SearchIcon, TerminalIcon, XIcon } from './Icons.tsx'
import { StateMark, TasksDialog } from './TasksDialog.tsx'
import { NewSession } from './NewSession.tsx'
import { FileTypeIcon, openFile } from './FileBrowser.tsx'
import { filesIn } from '../../../shared/files.ts'
import { baseName, dirName, ltr } from './FileView.tsx'

type Tab = 'all' | 'sessions' | 'artifacts' | 'tasks' | 'files' | 'folders'
const TABS: { id: Tab; label: string }[] = [
  // Folders next to Sessions: a folder is where sessions run, and a pick on one starts a session there.
  { id: 'all', label: 'All' }, { id: 'sessions', label: 'Sessions' }, { id: 'folders', label: 'Folders' },
  { id: 'artifacts', label: 'Artifacts' }, { id: 'tasks', label: 'Tasks' }, { id: 'files', label: 'Files' },
]
// How many of each type the All tab shows.
const ALL_MAX = 5

type Folder = { cwd: string; machine: string; count: number; last: number }
// why: the field a query matched when the row does not show it ("Last reply: …"), shown in its place.
type Row = { key: string; why?: string } & (
  | { kind: 'sessions'; s: SessionMeta }
  | { kind: 'artifacts'; a: Artifact }
  | { kind: 'tasks'; t: Task }
  | { kind: 'files'; path: string }
  | { kind: 'folders'; f: Folder })


// How well text matches the query: lower is better, -1 is no match. The start of the text, then
// the start of a word, then anywhere; with fuzzy, last, its letters in order.
function score(text: string, q: string, fuzzy: boolean): number {
  if (!q) return 0
  const t = text.toLowerCase()
  if (t.startsWith(q)) return 0
  const at = t.indexOf(q)
  if (at > 0 && /[\s/._-]/.test(t[at - 1])) return 1
  if (at >= 0) return 2
  if (!fuzzy) return -1
  let i = 0
  for (const c of t) if (c === q[i]) i++
  return i === q.length ? 9 : -1
}
// The fields a result is searched by, in order of weight: its title, the line under it, then
// fields the row does not show, each with the name that shows when a query matches it.
type Field = [label: string, text: string | undefined]
// Each word of the query must match some field; the score adds up the best of each. The first
// field (a title) counts most and alone matches by its letters in order. A field the row does not
// show matches only at the start of a word, so a long one (a reply) does not match inside words.
function match(q: string, fields: Field[], fuzzy: boolean): { s: number; why?: string } | null {
  let total = 0, why: string | undefined
  for (const w of q.split(/\s+/).filter(Boolean)) {
    let top = -1, at = 0
    fields.forEach(([, t], i) => { let s = t ? score(t, w, fuzzy && i === 0) : -1; if (i >= 2 && s > 1) s = -1; if (s >= 0 && (top < 0 || s + i * 3 < top)) { top = s + i * 3; at = i } })
    if (top < 0) return null
    total += top
    if (at >= 2 && !why) why = `${fields[at][0]}: ${snippet(fields[at][1]!, w)}`
  }
  return { s: total, why }
}
// A short piece of a long text around where the word is, on one line.
function snippet(text: string, w: string): string {
  const t = text.replace(/\s+/g, ' ').trim(), at = Math.max(0, t.toLowerCase().indexOf(w))
  const from = Math.max(0, at - 30), to = Math.min(t.length, at + w.length + 50)
  return `${from > 0 ? '…' : ''}${t.slice(from, to)}${to < t.length ? '…' : ''}`
}
// The results that match, in the list's order (the most recent first), or with best, the best
// matches first. Only best matches a title by its letters in order: among the most recent first,
// such a weak match would sit above good ones.
function ranked<T>(list: T[], q: string, best: boolean, fields: (x: T) => Field[]): { x: T; why?: string }[] {
  if (!q) return list.map((x) => ({ x }))
  const found = list.flatMap((x, i) => { const m = match(q, fields(x), best); return m ? [{ x, i, ...m }] : [] })
  if (best) found.sort((a, b) => a.s - b.s || a.i - b.i)
  return found.map(({ x, why }) => ({ x, why }))
}

// The order of the results for a query: the most recent first, or the best matches first. Kept for next time.
const SORT_KEY = 'codinger.paletteSort'

export function Palette() {
  const [open, setOpen] = useState(false)
  // What a pick opens after the palette closes: a task in the Tasks dialog, or a new session in a folder.
  const [task, setTask] = useState<string | null>(null)
  const [newIn, setNewIn] = useState<Folder | null>(null)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      e.preventDefault()
      setOpen((o) => !o)
    }
    // The sidebar's search button, for a screen with no keyboard. On a phone the field mounts after
    // the tap, too late for iOS to bring up the keyboard: a hidden field takes the focus now (holdKeyboard).
    const show = () => { holdKeyboard(); setOpen(true) }
    document.addEventListener('keydown', key)
    window.addEventListener('codinger:palette', show)
    const stop = onCircle(show)
    // The same circle in an artifact's frame, which the artifact server's script tells of.
    const fromFrame = (e: MessageEvent) => {
      const base = artifactsBase(state.artifactsPort)
      if (e.data?.codinger === 'palette' && base && e.origin === new URL(base).origin) setOpen(true)
    }
    window.addEventListener('message', fromFrame)
    return () => { document.removeEventListener('keydown', key); window.removeEventListener('codinger:palette', show); window.removeEventListener('message', fromFrame); stop() }
  }, [])
  return <>
    {open && <PaletteDialog onClose={() => setOpen(false)} onTask={setTask} onFolder={setNewIn} />}
    {task && <TasksDialog first={task} onClose={() => setTask(null)} />}
    {newIn && <NewSession cwd={newIn.cwd} machine={newIn.machine} onClose={() => setNewIn(null)} />}
  </>
}

// The files the agent wrote or edited and the files you attached, the one touched last first.
function recentFiles(events: Event[]): string[] {
  const out: string[] = []
  const add = (p: unknown) => { if (typeof p === 'string') out.push(p) }
  for (const e of events) {
    if (e.t === 'user') for (const p of e.parts) filesIn(p.text ?? '').forEach(add)
    else if (e.t === 'assistant') for (const b of e.blocks) if (b.type === 'tool_use' && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name)) add(b.input?.file_path ?? b.input?.notebook_path)
  }
  return [...new Set(out.reverse())]
}

function PaletteDialog({ onClose, onTask, onFolder }: { onClose(): void; onTask(id: string): void; onFolder(f: Folder): void }) {
  useEscape(onClose)
  const st = useStore()
  const [q, setQ] = useState('')
  const [best, setBest] = useState(() => localStorage.getItem(SORT_KEY) === 'best')
  const sortBy = (on: boolean) => { setBest(on); localStorage.setItem(SORT_KEY, on ? 'best' : 'recent') }
  const [tab, setTab] = useState<Tab>('all')
  // The result marked (-1: none), and whether the keys work in the results or in the field.
  const [active, setActive] = useState(-1)
  const [inList, setInList] = useState(false)
  const query = q.trim().toLowerCase()
  const sel = st.sessions.find((s) => s.id === st.selected && s.kind === 'worker')

  // The files: with no query, those the agent changed and those you attached; else a search of the folder.
  const [found, setFound] = useState<string[] | null>(null)
  useEffect(() => {
    if (!sel || !query) { setFound(null); return }
    let gone = false
    const t = setTimeout(() => void fetch(media(`/api/sessions/${localId(sel.id)}/find?q=${encodeURIComponent(query)}`, machineOf(sel.id)))
      .then((r) => r.ok ? r.json() : []).then((r: string[]) => { if (!gone) setFound(r) }).catch(() => { if (!gone) setFound([]) }), 120)
    return () => { gone = true; clearTimeout(t) }
  }, [query, sel?.id])

  const rows = useMemo(() => {
    const workers = st.sessions.filter((s) => s.kind === 'worker')
    const byId = new Map(workers.map((s) => [s.id, s]))
    const groupOf = (s: SessionMeta) => st.machines[machineOf(s.id)]?.settings.groups?.find((g) => g.id === s.group)?.name
    const titles = (sids: Iterable<string>) => [...new Set([...sids].map((id) => byId.get(id)?.title).filter(Boolean))].join(', ')
    // Each tab lists the most recent first, and a query keeps that order unless you pick Best match.
    const sessions = ranked([...workers].sort((a, b) => b.lastActivity - a.lastActivity), query, best, (s) => [
      ['', s.title], ['', s.cwd], ['Group', groupOf(s)], ['Sub-task of', s.parentId ? byId.get(s.parentId)?.title : undefined],
      ['Model', s.model ?? s.expectedModel], ['Machine', machineOf(s.id) ? labelOf(machineOf(s.id)) : undefined],
      ['Last reply', s.lastText], ['Id', query.length >= 4 ? localId(s.id) : undefined],
    ])
    const artifacts = ranked([...st.artifacts].sort((a, b) => b.mtime - a.mtime), query, best, (a) => {
      const made = new Set([...(a.created ? [a.created] : []), ...a.edits].map((e) => here(e.sid)))
      return [
        ['', a.title], ['', a.description], ['Folder', a.name], ['Made in', titles(made)],
        ['Made in', [...made].map((id) => byId.get(id)?.cwd).filter(Boolean).join(', ')], ['Published', a.published?.url],
      ]
    })
    // A running task is active now, so it counts as the most recent.
    const tasks = ranked([...st.tasks].sort((a, b) => Number(!!a.ended) - Number(!!b.ended) || (b.ended ?? b.started) - (a.ended ?? a.started)), query, best, (t) => [
      ['', t.title], ['', t.command], ['Folder', t.cwd], ['Session', byId.get(here(t.sid))?.title],
    ])
    const byDir = new Map<string, Folder & { sids: string[] }>()
    for (const s of workers) {
      const k = `${machineOf(s.id)}\n${s.cwd}`
      const f = byDir.get(k) ?? { cwd: s.cwd, machine: machineOf(s.id), count: 0, last: 0, sids: [] }
      f.count++; f.last = Math.max(f.last, s.lastActivity); f.sids.push(s.id)
      byDir.set(k, f)
    }
    const folders = ranked([...byDir.values()].sort((a, b) => b.last - a.last), query, best, (f) => [
      ['', baseName(f.cwd)], ['', f.cwd], ['Group', [...new Set(f.sids.map((id) => groupOf(byId.get(id)!)).filter(Boolean))].join(', ')],
      ['Sessions', titles(f.sids)],
    ])
    const files = !sel ? [] : query ? found ?? [] : recentFiles(st.events[sel.id] ?? [])
    return {
      sessions: sessions.map(({ x: s, why }): Row => ({ kind: 'sessions', key: s.id, s, why })),
      artifacts: artifacts.map(({ x: a, why }): Row => ({ kind: 'artifacts', key: a.name, a, why })),
      tasks: tasks.map(({ x: t, why }): Row => ({ kind: 'tasks', key: t.id, t, why })),
      files: files.map((p): Row => ({ kind: 'files', key: p, path: p })),
      folders: folders.map(({ x: f, why }): Row => ({ kind: 'folders', key: `${f.machine}\n${f.cwd}`, f, why })),
    }
  }, [st.sessions, st.artifacts, st.tasks, st.events, query, best, found, sel?.id])
  // The rows of a tab, in the order the keys move through them.
  const rowsOf = (t: Tab): Row[] => t === 'all' ? TABS.slice(1).flatMap((x) => rows[x.id as Exclude<Tab, 'all'>].slice(0, ALL_MAX)) : rows[t]
  const list = rowsOf(tab)
  useEffect(() => setActive(inList ? 0 : -1), [query, tab])

  const pick = (r: Row) => {
    onClose()
    if (r.kind === 'sessions') {
      // An archived session shows with the archived list beside it, so the sidebar marks it.
      if (!!r.s.archived !== state.showArchived) showArchive(!!r.s.archived)
      select(r.s.id)
    } else if (r.kind === 'artifacts') openArtifact(r.a.name)
    else if (r.kind === 'tasks') onTask(r.t.id)
    else if (r.kind === 'files' && sel) {
      state.page = null; state.sideOpen = false
      openFile(sel.id, r.path)
    } else if (r.kind === 'folders') onFolder(r.f)
  }

  // The tabs go round: right from the last tab goes to the first, and left from the first to the
  // last. The row has a copy of the last tab before the first and a copy of the first after the
  // last, so the row slides on into the copy (slot), then moves to the real tab with no slide (jump).
  // A drag past an end shows the copy too.
  const [jump, setJump] = useState(false)
  const [slot, setSlot] = useState<number | null>(null)
  const snap = useRef(0)
  const move = (d: number) => {
    const i = TABS.findIndex((x) => x.id === tab), n = i + d
    const round = n < 0 || n >= TABS.length
    clearTimeout(snap.current)
    setJump(false)
    setTab(TABS[(n + TABS.length) % TABS.length].id)
    if (!round || matchMedia('(prefers-reduced-motion: reduce)').matches) { setSlot(null); return }
    setSlot(n < 0 ? 0 : TABS.length + 1)
    snap.current = window.setTimeout(() => { setJump(true); setSlot(null) }, 240)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!list.length) return
      if (!inList) { setInList(true); setActive((a) => Math.max(0, a)) }
      else setActive((a) => Math.min(list.length - 1, a + 1))
    } else if (e.key === 'ArrowUp' && inList) {
      e.preventDefault()
      if (active <= 0) { setInList(false); setActive(-1) }
      else setActive(active - 1)
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && inList && !e.shiftKey) {
      e.preventDefault(); move(e.key === 'ArrowRight' ? 1 : -1)
    } else if (e.key === 'Tab') {
      e.preventDefault(); move(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = list[active] ?? list[0]
      if (r) pick(r)
    }
  }

  // On a touch screen only the list scrolls, never the page under the palette. A move on the list
  // scrolls it until it reaches an end, then stops there; a move sideways on the tabs scrolls them;
  // any other move does nothing. And with the keyboard up, the palette fills the part of the screen
  // above it (visualViewport), so iOS does not pan the page to show the field.
  const back = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = back.current, vv = window.visualViewport
    if (!el || !matchMedia('(pointer: coarse)').matches) return
    const fit = () => {
      if (!vv) return
      el.style.top = `${vv.offsetTop}px`; el.style.height = `${vv.height}px`; el.style.bottom = 'auto'
    }
    fit()
    vv?.addEventListener('resize', fit)
    vv?.addEventListener('scroll', fit)
    let last: { x: number; y: number } | null = null
    const start = (e: TouchEvent) => { last = { x: e.touches[0].clientX, y: e.touches[0].clientY } }
    const move = (e: TouchEvent) => {
      const t = e.touches[0]
      const dx = t.clientX - (last?.x ?? t.clientX), dy = t.clientY - (last?.y ?? t.clientY)
      last = { x: t.clientX, y: t.clientY }
      const at = e.target as Element, col = at.closest<HTMLElement>('.pal-col')
      if (col && Math.abs(dy) >= Math.abs(dx)) {
        const top = col.scrollTop <= 0, end = col.scrollTop + col.clientHeight >= col.scrollHeight - 1
        if ((dy > 0 && top) || (dy < 0 && end)) e.preventDefault()
        return
      }
      if (at.closest('.pal-tabs') && Math.abs(dx) > Math.abs(dy)) return
      e.preventDefault()
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    return () => {
      vv?.removeEventListener('resize', fit); vv?.removeEventListener('scroll', fit)
      el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move)
    }
  }, [])

  // The width of one tab's column: the palette's.
  const body = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setW(body.current?.clientWidth ?? 0))
    if (body.current) ro.observe(body.current)
    return () => ro.disconnect()
  }, [])
  const col = w
  const at = TABS.findIndex((x) => x.id === tab)

  // On a touch screen a drag sideways on the results moves the row of tabs under the finger. Let go
  // past a quarter of the width, or with a flick, and it goes on to the next tab (round, as the keys
  // do); else it goes back. A drag up or down scrolls the list as before (touch-action: pan-y).
  // The touches stop here, so the page's own (a pull of the sidebar, a circle) do not see them.
  const drag = useRef<{ x0: number; y0: number; x: number; t: number; v: number; side: boolean | null } | null>(null)
  const [dx, setDx] = useState<number | null>(null)
  const touch = {
    onTouchStart: (e: React.TouchEvent) => {
      e.stopPropagation()
      const p = e.touches[0]
      drag.current = e.touches.length === 1 ? { x0: p.clientX, y0: p.clientY, x: p.clientX, t: e.timeStamp, v: 0, side: null } : null
    },
    onTouchMove: (e: React.TouchEvent) => {
      e.stopPropagation()
      const d = drag.current, p = e.touches[0]
      if (!d || e.touches.length !== 1) return
      const ddx = p.clientX - d.x0, ddy = p.clientY - d.y0
      if (d.side === null) {
        if (Math.abs(ddx) < 10 && Math.abs(ddy) < 10) return
        d.side = Math.abs(ddx) > Math.abs(ddy)
      }
      if (!d.side) return
      // The speed in px/ms, smoothed over the last moves.
      const dt = e.timeStamp - d.t
      if (dt > 0) d.v = 0.6 * (p.clientX - d.x) / dt + 0.4 * d.v
      d.x = p.clientX; d.t = e.timeStamp
      setDx(ddx)
    },
    onTouchEnd: (e: React.TouchEvent) => {
      e.stopPropagation()
      const d = drag.current
      drag.current = null
      if (!d?.side) return
      const off = d.x - d.x0, v = e.timeStamp - d.t < 100 ? d.v : 0  // a finger that stopped before it let go has no flick
      const go = off < -col / 4 || v < -0.3 ? 1 : off > col / 4 || v > 0.3 ? -1 : 0
      if (go && e.type === 'touchend') move(go)
      else setJump(false)
      setDx(null)
    },
  }

  // The marked row stays in view in its column, and the current tab in the bar of tabs. Not with
  // scrollIntoView, which would also scroll the row of columns sideways.
  const tabs = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const r = body.current?.querySelector<HTMLElement>(`.pal-col.on .pal-row[data-i="${active}"]`), c = r?.parentElement?.closest<HTMLElement>('.pal-col')
    if (r && c) {
      // The column is positioned, so offsetTop counts from its top; the first row keeps its section's head in view.
      const top = r.offsetTop - (active === 0 && r.closest('.pal-section') ? 30 : 6), end = r.offsetTop + r.offsetHeight + 6
      if (top < c.scrollTop) c.scrollTop = top
      else if (end > c.scrollTop + c.clientHeight) c.scrollTop = end - c.clientHeight
    }
    const t = tabs.current?.querySelector<HTMLElement>('.pal-tab.on'), bar = tabs.current
    if (t && bar) {
      if (t.offsetLeft - bar.offsetLeft < bar.scrollLeft) bar.scrollLeft = t.offsetLeft - bar.offsetLeft - 10
      else if (t.offsetLeft - bar.offsetLeft + t.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = t.offsetLeft - bar.offsetLeft + t.offsetWidth + 10 - bar.clientWidth
    }
  }, [active, tab])

  const count = (t: Tab) => t === 'all' ? null : rows[t].length
  const home = (p: string) => st.home && p.startsWith(st.home) ? '~' + p.slice(st.home.length) : p
  const rel = (p: string) => sel && p.startsWith(sel.cwd + '/') ? p.slice(sel.cwd.length + 1) : home(p)

  // The line under a title: what the query matched, if the row does not show it, else its own.
  const sub = (r: Row, own?: string) => r.why ? <span className="pal-sub pal-why">{r.why}</span> : own ? <span className="pal-sub">{own}</span> : null
  const row = (r: Row, i: number, on: boolean) => {
    const props = {
      key: `${r.kind}:${r.key}`, 'data-i': i,
      className: `pal-row${on && i === active ? ' active' : ''}`,
      onMouseMove: on ? () => { if (i !== active) setActive(i) } : undefined,
      onClick: () => pick(r),
    }
    switch (r.kind) {
      case 'sessions': return (
        <button {...props}>
          <Mascot status={r.s.status} look={r.s.look} fatigue={fatigue(r.s.context.used, r.s.context.window)} size={20} child={!!r.s.parentId} />
          <span className="pal-main"><span className="pal-title">{r.s.title}</span>{sub(r, ltr(home(r.s.cwd)))}</span>
          <span className="pal-meta">{r.s.archived && <span className="pal-tag">Archived</span>}{timeAgo(r.s.lastActivity)}</span>
        </button>
      )
      case 'artifacts': return (
        <button {...props}>
          <span className="pal-icon"><ArtifactIcon size={15} /></span>
          <span className="pal-main"><span className="pal-title">{r.a.title || r.a.name}</span>{sub(r, r.a.description)}</span>
          <span className="pal-meta">{timeAgo(r.a.mtime)}</span>
        </button>
      )
      case 'tasks': return (
        <button {...props}>
          <span className="pal-icon"><TerminalIcon size={15} /></span>
          <span className="pal-main"><span className="pal-title">{r.t.title}</span>{r.why ? sub(r) : <span className="pal-sub mono">{r.t.command}</span>}</span>
          <span className="pal-meta"><StateMark t={r.t} /></span>
        </button>
      )
      case 'files': return (
        <button {...props}>
          <span className="pal-icon"><FileTypeIcon name={r.path} /></span>
          <span className="pal-main"><span className="pal-title">{baseName(r.path)}</span><span className="pal-sub">{ltr(dirName(rel(r.path)) || '.')}</span></span>
        </button>
      )
      case 'folders': return (
        <button {...props}>
          <span className="pal-icon"><FolderIcon size={15} /></span>
          <span className="pal-main"><span className="pal-title">{baseName(r.f.cwd)}</span>{sub(r, ltr(home(r.f.cwd)))}</span>
          <span className="pal-meta">{r.f.machine && <span className="pal-tag">{r.f.machine}</span>}{r.f.count} {r.f.count === 1 ? 'session' : 'sessions'}</span>
        </button>
      )
    }
  }

  // What a tab with no rows says.
  const none = (t: Tab) => t === 'files' && !sel ? 'Open a session to search the files in its folder.'
    : t === 'files' && !query ? 'Type to search the files in this session’s folder.'
    : t === 'files' && found === null ? 'Searching…'
    : query ? 'Nothing matches.' : `No ${TABS.find((x) => x.id === t)!.label.toLowerCase()} yet.`

  // copy: one of the two copies at the ends of the row, never the current column.
  const column = (t: Tab, copy = false) => {
    const on = t === tab && !copy
    let content: React.ReactNode
    if (t === 'all') {
      let n = 0
      const parts = TABS.slice(1).map((x) => {
        const shown = rows[x.id as Exclude<Tab, 'all'>].slice(0, ALL_MAX)
        if (!shown.length) return null
        const start = n
        n += shown.length
        const more = rows[x.id as Exclude<Tab, 'all'>].length - shown.length
        return (
          <div key={x.id} className="pal-section">
            <button className="pal-section-head" tabIndex={-1} onClick={() => { setJump(false); setTab(x.id) }}>
              <span>{x.label}</span>{more > 0 && <span className="pal-more">{more} more</span>}
            </button>
            {shown.map((r, j) => row(r, start + j, on))}
          </div>
        )
      }).filter(Boolean)
      content = parts.length ? parts : <div className="pal-none muted">{query ? 'Nothing matches.' : 'Nothing here yet.'}</div>
    } else {
      const rs = rowsOf(t)
      content = rs.length ? rs.map((r, j) => row(r, j, on)) : <div className="pal-none muted">{none(t)}</div>
    }
    return (
      <div key={copy ? `copy-${t}` : t} className={`pal-col${on ? ' on' : ''}`} style={{ width: col }} aria-hidden={!on}>
        {content}
      </div>
    )
  }

  return (
    <div className="modal-back pal-back" ref={back} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      {/* A click outside the field keeps the focus in it, so the keys always work. */}
      <div className={`modal palette${inList ? ' in-list' : ''}`} data-pid="palette" onMouseDown={(e) => { if (!(e.target as Element).closest('input')) e.preventDefault() }}>
        <div className="pal-search">
          <SearchIcon size={15} />
          <input autoFocus value={q} placeholder="Search everything" data-pid="palette-search"
            onChange={(e) => { setQ(e.target.value); setInList(false) }} onKeyDown={onKey} spellCheck={false} autoComplete="off" />
          {/* Only a query has an order to change: with none, every tab shows the most recent first. */}
          {query && <button className="pal-sort" data-pid="palette-sort" onClick={() => sortBy(!best)}>{best ? 'Best match' : 'Most recent'}</button>}
          <kbd className="pal-kbd">esc</kbd>
          {/* On a phone the palette fills the screen, with no Esc key and nothing outside it to tap. */}
          <button className="icon-btn pal-close" aria-label="Close" onClick={onClose}><XIcon size={16} /></button>
        </div>
        <div className="pal-tabs" ref={tabs} role="tablist" data-pid="palette-tabs">
          {TABS.map((x) => (
            <button key={x.id} role="tab" aria-selected={x.id === tab} className={`pal-tab${x.id === tab ? ' on' : ''}`} tabIndex={-1} onClick={() => { setJump(false); setTab(x.id) }}>
              {x.label}{count(x.id) != null && <span className="pal-count">{count(x.id)}</span>}
            </button>
          ))}
        </div>
        <div className="pal-body" ref={body} {...touch} onTouchCancel={touch.onTouchEnd}>
          <div className={`pal-track${jump || dx !== null ? ' jump' : ''}`} style={{ transform: `translateX(${-(slot ?? at + 1) * col + (dx ?? 0)}px)` }}>
            {w > 0 && <>
              {column(TABS[TABS.length - 1].id, true)}
              {TABS.map((x) => column(x.id))}
              {column(TABS[0].id, true)}
            </>}
          </div>
        </div>
      </div>
    </div>
  )
}
