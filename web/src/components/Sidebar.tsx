import { useEffect, useRef, useState } from 'react'
import type { SessionMeta, Usage } from '../../../shared/types.ts'
import { api, changed, closeSession, select, state, useStore } from '../store.ts'
import { HistoryDialog } from './HistoryDialog.tsx'
import { fatigue, timeAgo } from '../util.ts'
import { Mascot, STATUS_LABEL } from './Mascot.tsx'
import { NewSession } from './NewSession.tsx'
import { ArchiveIcon, GearIcon, TerminalIcon, XIcon } from './Icons.tsx'
import { TasksDialog } from './TasksDialog.tsx'
import { SettingsDialog } from './SettingsDialog.tsx'
import { cacheOf, minutes, spendOf, useNow, usd } from '../cache.ts'
import { CostBanner } from './CostPanel.tsx'
import type { Page } from './SettingsDialog.tsx'

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
  const [settings, setSettings] = useState<Page | true | false>(false)
  const [tasks, setTasks] = useState(false)
  const [menu, setMenu] = useState<RowMenuAt | null>(null)
  const openMenu = (s: SessionMeta, e: React.MouseEvent) => { e.preventDefault(); setMenu({ s, x: e.clientX, y: e.clientY }) }
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
        {st.agent?.avatar && <img className="brand-avatar" src="/agent/avatar" alt="" />}
        <span>{st.agent?.name ?? 'Codiner'}</span>
        <span className={`conn ${st.connected ? 'on' : 'off'}`} title={st.connected ? 'Connected' : 'Reconnecting…'} />
      </div>
      {lead && <Row s={lead} label="Lead" active={st.selected === lead.id} onMenu={openMenu} />}
      <div className="side-actions">
        <button className="primary" onClick={() => setNewIn('')}>+ New session</button>
        <button onClick={() => setHistory(true)} title="Continue any Claude Code conversation on this machine, including terminal ones">Resume…</button>
      </div>
      <nav className={`tree${st.showArchived ? ' archived' : ''}`}>
        {st.showArchived && <div className="archive-banner"><ArchiveIcon size={13} /> Archived sessions<button className="icon-btn" title="Back to active sessions" onClick={() => { state.showArchived = false; changed() }}><XIcon size={12} /></button></div>}
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
                <Row s={x} depth={depth} active={st.selected === x.id} onPointerDown={(e) => start(e, key, x.id)} onMenu={openMenu} />
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
      <CostBanner open={() => setSettings('cost')} />
      <div className="side-foot">
        {/* Floats above the line, so it takes no room from the footer. */}
        {custom && <button className="reset-order" title="Sort folders by latest activity, sessions oldest first" onClick={() => void api('/api/sessions/order', 'DELETE')}>Reset order</button>}
        <button className="link" title="Settings" onClick={() => setSettings(true)}><GearIcon size={14} /></button>
        <div className="side-foot-mid">
          {st.billing === 'api' && <ApiSpend sessions={st.sessions} open={() => setSettings('cost')} />}
          {st.billing !== 'api' && (u.fiveHour != null || u.sevenDay != null) && (
            <div className="usage" data-tip={limitsTip(u)} onClick={() => setSettings('cost')}>
              {u.fiveHour != null && <span className={level(u.fiveHour)}>5h {limitLabel(u.fiveHour, u.rate?.fiveHour, st.money)}</span>}
              {u.fiveHour != null && u.sevenDay != null && <span className="usage-dot">·</span>}
              {u.sevenDay != null && <span className={level(u.sevenDay)}>7d {limitLabel(u.sevenDay, u.rate?.sevenDay, st.money)}</span>}
            </div>
          )}
        </div>
        {st.tasks.length > 0 && (() => {
          const running = st.tasks.filter((t) => !t.ended).length
          return <button className="link side-tasks" title={`Tasks: ${running} running`} onClick={() => setTasks(true)}><TerminalIcon size={14} />{running > 0 && <span>{running}</span>}</button>
        })()}
        {/* One toggle: pressed while the list shows archived sessions. */}
        <button className={`link archive-toggle${st.showArchived ? ' on' : ''}`} title={st.showArchived ? 'Show active sessions' : 'Show archived sessions'} onClick={() => { state.showArchived = !state.showArchived; changed() }}><ArchiveIcon size={14} /></button>
      </div>
      {newIn !== null && <NewSession cwd={newIn} onClose={() => setNewIn(null)} />}
      {history && <HistoryDialog onClose={() => setHistory(false)} />}
      {settings && <SettingsDialog page={settings === true ? undefined : settings} onClose={() => setSettings(false)} />}
      {tasks && <TasksDialog onClose={() => setTasks(false)} />}
      {menu && <RowMenu at={menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}

// Billed per token (Bedrock, Vertex): what all sessions spent today and in 7 days, at API prices.
function ApiSpend({ sessions, open }: { sessions: SessionMeta[]; open(): void }) {
  useNow(60_000)
  const day = new Date(); day.setHours(0, 0, 0, 0)
  const since = (t: number) => sessions.reduce((sum, m) => sum + (m.spend?.hours ?? []).reduce((a, [h, d]) => a + (h >= t ? d : 0), 0), 0)
  const today = since(day.getTime()), week = since(Date.now() - 7 * 86_400_000)
  return (
    <div className="usage" data-tip={`API spend at list prices, all sessions here, notes and keep-warm calls included.\nToday: ${usd(today)}\nLast 7 days: ${usd(week)}`} onClick={open}>
      <span>today {usd(today)}</span><span className="usage-dot">·</span><span>7d {usd(week)}</span>
    </div>
  )
}

function Row({ s, depth = 0, active, label, onPointerDown, onMenu }: { s: SessionMeta; depth?: number; active: boolean; label?: string; onPointerDown?(e: React.PointerEvent): void; onMenu?(s: SessionMeta, e: React.MouseEvent): void }) {
  return (
    <button className={`row${active ? ' active' : ''}${s.unread ? ' unread' : ''}`} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => select(s.id)} onPointerDown={onPointerDown} onContextMenu={onMenu && ((e) => onMenu(s, e))}>
      <Mascot status={s.status} look={s.look} fatigue={fatigue(s.context.used, s.context.window)} size={26} title={STATUS_LABEL[s.status]} />
      <span className="row-main">
        <span className="row-title">{label ?? s.title}</span>
        <span className="row-sub">{s.compacting ? 'compacting' : STATUS_LABEL[s.status]} · {timeAgo(s.lastActivity)}<SpendHint s={s} /><CacheHint s={s} /></span>
      </span>
      {s.inbox.length > 0 && <span className="count" title="Drafts from the lead">{s.inbox.length}</span>}
      {s.kind === 'worker' && !s.archived && (
        <span className="row-close" role="button" title="Archive session" onClick={(e) => { e.stopPropagation(); void closeSession(s.id) }}><XIcon size={12} /></span>
      )}
    </button>
  )
}

type RowMenuAt = { s: SessionMeta; x: number; y: number }

// The menu a right click on a session opens, where the pointer is.
function RowMenu({ at, onClose }: { at: RowMenuAt; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    document.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
      document.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])
  const { s } = at
  const act = (f: () => unknown) => () => { onClose(); void f() }
  return (
    <div className="menu ctx-menu" ref={box} style={{ left: at.x, top: at.y }} onContextMenu={(e) => e.preventDefault()}>
      {s.unread
        ? <button onClick={act(() => api(`/api/sessions/${s.id}/seen`))}>Mark as read</button>
        : <button onClick={act(() => api(`/api/sessions/${s.id}/unread`))}>Mark as unread</button>}
    </div>
  )
}

// A usage window in dollars at API prices, once the meter knows what a dollar uses:
// the meter's rate is the share of the limit one dollar uses, so the whole limit is 1 / rate.
function limitLabel(used: number, rate: number | undefined, mode: string) {
  if (mode !== 'usd' || !rate) return `${Math.round(used * 100)}%`
  return `${dollars(used / rate)}/${dollars(1 / rate)}`
}

// A limit close to used up: yellow from 80%, red from 90%.
const level = (used: number) => used >= 0.9 ? 'usage-bad' : used >= 0.8 ? 'usage-warn' : ''

// Dollars in few characters: $4.7, $48, $282, $1.8k, $18k.
function dollars(x: number): string {
  if (x >= 1000) return `$${+(x / 1000).toPrecision(2)}k`
  if (x >= 10) return `$${Math.round(x)}`
  return `$${+x.toPrecision(2)}`
}

function limitsTip(u: Usage) {
  const line = (name: string, used: number | undefined, rate: number | undefined) => used == null ? '' : rate
    ? `The ${name} limit is about ${usd(1 / rate)} at API prices. You used ${Math.round(used * 100)}% (about ${usd(used / rate)}); about ${usd((1 - used) / rate)} is left.`
    : `You used ${Math.round(used * 100)}% of your ${name} limit. Codiner does not know its dollar value yet.`
  return [line('5-hour', u.fiveHour, u.rate?.fiveHour), line('weekly', u.sevenDay, u.rate?.sevenDay)].filter(Boolean).join('\n\n')
    + `\n\nDollar values are estimates: Codiner compares Claude Code's spend at API prices with how far the percentages move (${u.rate?.pairs ?? 0} measurements). Click to see what your plan costs you.`
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
  if (c.blocked) return <span className="cache-hint cold" title="Prompt cache expired. The next message re-caches the whole context"> · cache expired</span>
  if (!c.cold && c.left < (c.ttl >= 3_600_000 ? 10 : 2) * 60_000) return <span className="cache-hint soon" title="Prompt cache expires soon"> · cache {minutes(c.left)}</span>
  return null
}
