import { useRef, useState } from 'react'
import type { SessionMeta } from '../../../shared/types.ts'
import { api, changed, closeSession, select, state, useStore } from '../store.ts'
import { HistoryDialog } from './HistoryDialog.tsx'
import { fatigue, timeAgo } from '../util.ts'
import { Mascot, STATUS_LABEL } from './Mascot.tsx'
import { NewSession } from './NewSession.tsx'
import { BackIcon, GearIcon, XIcon } from './Icons.tsx'
import { SettingsDialog } from './SettingsDialog.tsx'
import { cacheOf, minutes, spendOf, useNow } from '../cache.ts'

// Sessions grouped by directory; sessions spawned for another one nest under it.
// You can drag both into place; until you do, folders go by latest activity and
// sessions by age. Folders you have not placed yet come first.
export function groupSessions(sessions: SessionMeta[], archived: boolean, groupOrder: string[] = []) {
  const workers = sessions.filter((s) => s.kind === 'worker' && s.archived === archived)
  const groups = new Map<string, SessionMeta[]>()
  const place = (s: SessionMeta) => s.order ?? Infinity
  for (const s of workers.sort((a, b) => place(a) - place(b) || a.createdAt - b.createdAt)) groups.set(s.cwd, [...(groups.get(s.cwd) ?? []), s])
  const rank = (cwd: string) => { const i = groupOrder.indexOf(cwd); return i < 0 ? -1 : i }
  const recent = (list: SessionMeta[]) => Math.max(...list.map((s) => s.lastActivity))
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || recent(b[1]) - recent(a[1]))
}

export function treeOf(list: SessionMeta[]): { s: SessionMeta; depth: number; parent: string | null }[] {
  const ids = new Set(list.map((s) => s.id))
  const out: { s: SessionMeta; depth: number; parent: string | null }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const s of list) if ((s.parentId && ids.has(s.parentId) ? s.parentId : null) === parent) { out.push({ s, depth, parent }); walk(s.id, depth + 1) }
  }
  walk(null, 0)
  return out
}

// Press and drag a session (with any nested under it) or a folder's name up or
// down among its siblings, which share a data-sort-key. The others slide aside
// to make room; letting go puts it there.
type Drag = { key: string; id: string; dy: number; shift: Record<string, number> }
function useDragSort(onDrop: (key: string, ids: string[]) => void) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const moved = useRef(false)
  const start = (e: React.PointerEvent, key: string, id: string) => {
    if (e.button !== 0 || (e.target as Element).closest('.row-close, .group-head button')) return
    const nav = (e.currentTarget as HTMLElement).closest('nav')
    if (!nav) return
    const y0 = e.clientY
    moved.current = false
    // Where everything was when the drag began: the slots stay put while things slide.
    const els = [...nav.querySelectorAll<HTMLElement>('[data-sort-key]')].filter((el) => el.dataset.sortKey === key)
    const ids = els.map((el) => el.dataset.sortId!)
    const i = ids.indexOf(id)
    const rects = els.map((el) => el.getBoundingClientRect())
    const size = i + 1 < els.length ? rects[i + 1].top - rects[i].top : rects[i].height + parseFloat(getComputedStyle(els[i]).marginBottom)
    const others = ids.filter((x) => x !== id)
    const mids = rects.filter((_, k) => k !== i).map((r) => r.top + r.height / 2)
    const slot = (dy: number) => { const c = rects[i].top + rects[i].height / 2 + dy; return mids.filter((m) => m < c).length }
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0
      if (!moved.current && Math.abs(dy) < 5) return
      if (!moved.current) { moved.current = true; document.body.classList.add('sorting') }
      const to = slot(dy)
      const shift: Record<string, number> = {}
      others.forEach((x, j) => { if (j < i && j >= to) shift[x] = size; else if (j >= i && j < to) shift[x] = -size })
      setDrag({ key, id, dy, shift })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('sorting')
      setDrag(null)
      if (!moved.current) return
      // The click that ends a drag selects nothing.
      setTimeout(() => { moved.current = false })
      const order = [...others]
      order.splice(slot(ev.clientY - y0), 0, id)
      if (order.some((x, k) => x !== ids[k])) onDrop(key, order)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // Props for one sortable element.
  const sortable = (key: string, id: string) => {
    const on = drag?.key === key
    const dy = !on ? 0 : drag.id === id ? drag.dy : drag.shift[id] ?? 0
    return {
      'data-sort-key': key,
      'data-sort-id': id,
      onClickCapture: (e: React.MouseEvent) => { if (moved.current) { e.stopPropagation(); e.preventDefault() } },
      className: !on ? '' : drag.id === id ? ' dragged' : ' sliding',
      style: dy ? { transform: `translateY(${dy}px)` } : undefined,
    }
  }
  return { start, sortable }
}

const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

export function Sidebar({ width }: { width: number }) {
  const st = useStore()
  const [newIn, setNewIn] = useState<string | null>(null)
  const [history, setHistory] = useState(false)
  const [settings, setSettings] = useState(false)
  const lead = st.sessions.find((s) => s.kind === 'lead')
  const groups = groupSessions(st.sessions, st.showArchived, st.settings.groupOrder)
  const { start, sortable } = useDragSort((key, ids) => {
    if (key === 'groups') {
      // Folders not on screen (the other of active and archived) keep their place after these.
      const groupOrder = [...ids, ...(st.settings.groupOrder ?? []).filter((c) => !ids.includes(c))]
      state.settings = { ...state.settings, groupOrder }
      void api('/api/settings', 'PUT', { groupOrder })
    } else {
      state.sessions = state.sessions.map((s) => ids.includes(s.id) ? { ...s, order: ids.indexOf(s.id) } : s)
      void api('/api/sessions/order', 'PUT', { ids })
    }
    changed()
  })
  const custom = !!st.settings.groupOrder?.length || st.sessions.some((x) => x.order != null)
  const u = st.usage
  return (
    <aside className="sidebar" style={{ width }}>
      <div className="brand">
        <span>Codiner</span>
        <span className={`conn ${st.connected ? 'on' : 'off'}`} title={st.connected ? 'Connected' : 'Reconnecting…'} />
      </div>
      {lead && <Row s={lead} label="Lead" active={st.selected === lead.id} />}
      <div className="side-actions">
        <button className="primary" onClick={() => setNewIn('')}>+ New session</button>
        <button onClick={() => setHistory(true)} title="Pick up any Claude Code conversation on this machine, including ones from the terminal">Resume…</button>
      </div>
      <nav className="tree">
        {groups.map(([cwd, list]) => {
          const g = sortable('groups', cwd)
          // A session and those nested under it move as one.
          const ids = new Set(list.map((x) => x.id))
          const kids = (parent: string | null) => list.filter((x) => (x.parentId && ids.has(x.parentId) ? x.parentId : null) === parent)
          const branch = (x: SessionMeta, depth: number): React.ReactNode => {
            const key = `${cwd}|${x.parentId && ids.has(x.parentId) ? x.parentId : ''}`
            const b = sortable(key, x.id)
            return (
              <div key={x.id} {...b} className={`branch${b.className}`}>
                <Row s={x} depth={depth} active={st.selected === x.id} onPointerDown={(e) => start(e, key, x.id)} />
                {kids(x.id).map((k) => branch(k, depth + 1))}
              </div>
            )
          }
          return (
            <div key={cwd} {...g} className={`group${g.className}`}>
              <div className="group-head" title={`${cwd}\nDrag to move`} onPointerDown={(e) => start(e, 'groups', cwd)}>
                <span>{cwd.split('/').pop()}</span>
                <button className="link" title={`New session in ${short(cwd)}`} onClick={() => setNewIn(cwd)}>+</button>
              </div>
              {kids(null).map((x) => branch(x, 0))}
            </div>
          )
        })}
        {!groups.length && <div className="muted pad">{st.showArchived ? 'No archived sessions.' : 'No sessions yet.'}</div>}
      </nav>
      <div className="side-foot">
        {/* Floats above the line, so it takes no room from the footer. */}
        {custom && <button className="reset-order" title="Folders go back to latest activity first, and sessions to oldest first" onClick={() => void api('/api/sessions/order', 'DELETE')}>Reset order</button>}
        <div className="side-foot-left">
          <button className="link" title="Settings" onClick={() => setSettings(true)}><GearIcon size={14} /></button>
          {(u.fiveHour != null || u.sevenDay != null) && (
            <div className="usage" title="Your Claude plan's usage windows, as Claude Code reports them">
              {u.fiveHour != null && <span>5h {Math.round(u.fiveHour * 100)}%</span>}
              {u.sevenDay != null && <span>7d {Math.round(u.sevenDay * 100)}%</span>}
            </div>
          )}
        </div>
        <button className="link" onClick={() => { state.showArchived = !state.showArchived; changed() }}>{st.showArchived ? <><BackIcon size={12} /> Active sessions</> : 'Archived'}</button>
      </div>
      {newIn !== null && <NewSession cwd={newIn} onClose={() => setNewIn(null)} />}
      {history && <HistoryDialog onClose={() => setHistory(false)} />}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    </aside>
  )
}

function Row({ s, depth = 0, active, label, onPointerDown }: { s: SessionMeta; depth?: number; active: boolean; label?: string; onPointerDown?(e: React.PointerEvent): void }) {
  return (
    <button className={`row${active ? ' active' : ''}${s.unread ? ' unread' : ''}`} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => select(s.id)} onPointerDown={onPointerDown}>
      <Mascot status={s.status} look={s.look} fatigue={fatigue(s.context.used, s.context.window)} size={26} title={STATUS_LABEL[s.status]} />
      <span className="row-main">
        <span className="row-title">{label ?? s.title}</span>
        <span className="row-sub">{s.compacting ? 'compacting' : STATUS_LABEL[s.status]} · {timeAgo(s.lastActivity)}<SpendHint s={s} /><CacheHint s={s} /></span>
      </span>
      {s.inbox.length > 0 && <span className="count" title="Drafts from the lead">{s.inbox.length}</span>}
      {s.kind === 'worker' && !s.archived && (
        <span className="row-close" role="button" title="Close (moves to Archived, reopenable)" onClick={(e) => { e.stopPropagation(); void closeSession(s.id) }}><XIcon size={12} /></span>
      )}
    </button>
  )
}

// What the conversation has cost so far. Only a label: the session's own pill explains it.
function SpendHint({ s }: { s: SessionMeta }) {
  useStore()
  const x = spendOf(s)
  if (!x) return null
  return <span className="row-spend"> · {x.label}</span>
}

// A cache about to expire, or one that has expired with a lot in it.
function CacheHint({ s }: { s: SessionMeta }) {
  const c = cacheOf(s, useNow())
  if (c.left == null || s.status === 'working') return null
  if (c.blocked) return <span className="cache-hint cold" title="The prompt cache has expired: the next message re-caches the whole context"> · cache expired</span>
  if (!c.cold && c.left < (c.ttl >= 3_600_000 ? 10 : 2) * 60_000) return <span className="cache-hint soon" title="The prompt cache expires soon"> · cache {minutes(c.left)}</span>
  return null
}
