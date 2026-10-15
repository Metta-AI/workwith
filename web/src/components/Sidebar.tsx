import { useEffect, useRef, useState } from 'react'
import type { SessionMeta, Usage } from '../../../shared/types.ts'
import { api, changed, closeSession, currentMachine, LOCAL, localId, machineList, machineOf, offline, select, state, useStore, type Machine, labelOf } from '../store.ts'
import { HistoryDialog } from './HistoryDialog.tsx'
import { fatigue, timeAgo } from '../util.ts'
import { Mascot, STATUS_LABEL } from './Mascot.tsx'
import { NewSession } from './NewSession.tsx'
import { ArchiveIcon, ChevronIcon, DesktopIcon, GearIcon, GlobeIcon, LaptopIcon, TerminalIcon, XIcon } from './Icons.tsx'
import { TasksDialog } from './TasksDialog.tsx'
import { ArtifactIcon } from './Artifacts.tsx'
import { SettingsDialog } from './SettingsDialog.tsx'
import { cacheOf, minutes, spendOf, useNow, usd } from '../cache.ts'
import { CostBanner } from './CostPanel.tsx'
import type { Page } from './SettingsDialog.tsx'
import { shortPath } from './DirPicker.tsx'

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
    if (e.button !== 0 || (e.target as Element).closest('.row-close, .group-head button, .machine-head button')) return
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
    // A sibling slides aside once the dragged one covers most of it, whatever their heights.
    const slot = (dy: number) => {
      const top = rects[i].top + dy, bottom = rects[i].bottom + dy
      return rects.filter((r, k) => k < i ? top > r.bottom - 0.6 * r.height : k > i && bottom > r.top + 0.6 * r.height).length
    }
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

const short = shortPath

export function Sidebar({ width }: { width: number }) {
  const st = useStore()
  const [newIn, setNewIn] = useState<{ cwd: string; machine?: string } | null>(null)
  const [history, setHistory] = useState(false)
  const [settings, setSettings] = useState<Page | true | false>(false)
  const [tasks, setTasks] = useState(false)
  const [menu, setMenu] = useState<RowMenuAt | null>(null)
  const openMenu = (s: SessionMeta, e: React.MouseEvent) => { e.preventDefault(); setMenu({ s, x: e.clientX, y: e.clientY }) }
  const local = st.machines[LOCAL]
  const others = machineList().filter((m) => m.name !== LOCAL)
  const away = offline()
  const custom = !!st.settings.groupOrder?.length || st.sessions.some((x) => x.order != null)
  const u = st.usage
  const tab = st.web || !local ? 'remote' : st.sideTab
  // Machines move like folders: drag one by its head.
  const drag = useDragSort((_key, names) => { state.machineOrder = names; changed() })
  const tree = (machine: string) => <MachineTree machine={machine} onNew={(cwd) => setNewIn({ cwd, machine })} onMenu={openMenu} />
  return (
    <aside className="sidebar" style={{ width }}>
      <div className="brand">
        <span>Codinger</span>
        <span className={`conn ${st.connected ? 'on' : 'off'}`} title={st.connected ? 'Connected' : 'Reconnecting…'} />
        <button className="icon-btn side-hide" aria-label="Hide sessions" onClick={() => { state.sideOpen = false; changed() }}><XIcon size={18} /></button>
      </div>
      <div className="side-actions">
        <button className="primary" onClick={() => setNewIn({ cwd: '', machine: tab === 'local' ? LOCAL : others[0]?.name })}>+ New session</button>
        <button onClick={() => setHistory(true)} title={`Continue any Claude Code conversation on ${st.web ? currentMachine() : 'this machine'}, including terminal ones`}>Resume…</button>
      </div>
      {/* On a machine's own page: its sessions, and the other machines'. On the web, every machine is remote. */}
      {!st.web && (others.length > 0 || away.length > 0 || !!local?.remote?.linked) && (
        <div className="side-tabs">
          {(['local', 'remote'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => { state.sideTab = t; changed() }}>{t === 'local' ? <>{local && <DeviceIcon m={local} tip={false} />} Local</> : <><GlobeIcon size={13} /> Remote</>}</button>)}
        </div>
      )}
      <nav className={`tree${st.showArchived ? ' archived' : ''}`}>
        {st.showArchived && <div className="archive-banner"><ArchiveIcon size={13} /> Archived sessions<button className="icon-btn" title="Back to active sessions" onClick={() => { state.showArchived = false; changed() }}><XIcon size={12} /></button></div>}
        {tab === 'local' ? local && tree(LOCAL) : <>
          {others.map((m) => {
            const d = drag.sortable('machines', m.name)
            const shut = st.collapsed.includes(m.name)
            return (
              <div key={m.name} {...d} className={`machine${shut ? ' shut' : ''}${d.className}`}>
                <div className="machine-head"
                  onPointerDown={(e) => drag.start(e, 'machines', m.name)}
                  onClick={() => { state.collapsed = shut ? state.collapsed.filter((n) => n !== m.name) : [...state.collapsed, m.name]; changed() }}>
                  <ChevronIcon size={11} className="machine-chevron" />
                  <DeviceIcon m={m} />
                  <span className="machine-name">{labelOf(m.name)}</span>
                  {!m.connected && <span className="conn off" />}
                  <button className="link" title={`New session on ${m.name}`} onClick={(e) => { e.stopPropagation(); setNewIn({ cwd: '', machine: m.name }) }}>+</button>
                </div>
                {!shut && tree(m.name)}
              </div>
            )
          })}
          {away.map((name) => <div key={name} className="machine off"><div className="machine-head"><span className="machine-name">{labelOf(name)}</span><span className="muted">not connected</span></div></div>)}
          {!others.length && !away.length && <div className="muted pad">No other machines. Connect one in Settings → Remote access on that machine.</div>}
        </>}
        {tab === 'local' && !local?.sessions.some((s) => s.kind === 'worker' && s.archived === st.showArchived) && <div className="muted pad">{st.showArchived ? 'No archived sessions.' : 'No sessions yet.'}</div>}
      </nav>
      <CostBanner open={() => setSettings('cost')} />
      <div className="side-foot">
        {/* Floats above the line, so it takes no room from the footer. */}
        {custom && <button className="reset-order" title="Sort folders by latest activity, sessions oldest first" onClick={() => void api('/api/sessions/order', 'DELETE')}>Reset order</button>}
        <button className="link" title={st.web ? `Settings of ${currentMachine()}` : 'Settings'} onClick={() => setSettings(true)}><GearIcon size={14} /></button>
        <div className="side-foot-mid">
          {(u.fiveHour != null || u.sevenDay != null) && (
            <div className="usage" data-tip={limitsTip(u)} onClick={() => setSettings('cost')}>
              {u.fiveHour != null && <span className={level(u.fiveHour)}>5h {limitLabel(u.fiveHour, u.rate?.fiveHour, st.money)}</span>}
              {u.fiveHour != null && u.sevenDay != null && <span className="usage-dot">·</span>}
              {u.sevenDay != null && <span className={level(u.sevenDay)}>7d {limitLabel(u.sevenDay, u.rate?.sevenDay, st.money)}</span>}
            </div>
          )}
        </div>
        {st.artifacts.length > 0 && <button className={`link side-artifacts${st.page === 'artifacts' ? ' on' : ''}`} title={`Artifacts: ${st.artifacts.length}`} onClick={() => { state.page = state.page === 'artifacts' ? null : 'artifacts'; state.sideOpen = false; changed() }}><ArtifactIcon size={14} /></button>}
        {st.tasks.length > 0 && (() => {
          const running = st.tasks.filter((t) => !t.ended).length
          return <button className="link side-tasks" title={`Tasks: ${running} running`} onClick={() => setTasks(true)}><TerminalIcon size={14} />{running > 0 && <span>{running}</span>}</button>
        })()}
        {/* One toggle: pressed while the list shows archived sessions. */}
        <button className={`link archive-toggle${st.showArchived ? ' on' : ''}`} title={st.showArchived ? 'Show active sessions' : 'Show archived sessions'} onClick={() => { state.showArchived = !state.showArchived; changed() }}><ArchiveIcon size={14} /></button>
      </div>
      {newIn !== null && <NewSession cwd={newIn.cwd} machine={newIn.machine} onClose={() => setNewIn(null)} />}
      {history && <HistoryDialog onClose={() => setHistory(false)} />}
      {settings && <SettingsDialog page={settings === true ? undefined : settings} onClose={() => setSettings(false)} />}
      {tasks && <TasksDialog onClose={() => setTasks(false)} />}
      {menu && <RowMenu at={menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}

// A machine's icon: laptop or desktop, and what it runs.
const OS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
function DeviceIcon({ m, tip = true }: { m: Machine; tip?: boolean }) {
  // The only tooltip on a machine's head: on its icon, not on the head you click and drag.
  const title = `${labelOf(m.name)}${labelOf(m.name) !== m.name ? ` (${m.name})` : ''}: ${m.device === 'laptop' ? 'laptop' : m.device === 'desktop' ? 'desktop' : 'computer'}${OS[m.platform] ? `, ${OS[m.platform]}` : ''}, ${m.connected ? 'connected through web.codinger.app' : 'reconnecting…'}`
  const Icon = m.device === 'desktop' ? DesktopIcon : LaptopIcon
  return <span className="device" data-tip={tip ? title : undefined}><Icon os={m.platform} size={tip ? 18 : 15} /></span>
}

// One machine's sessions, by folder. Its folder order and session order are its own.
function MachineTree({ machine, onNew, onMenu }: { machine: string; onNew(cwd: string): void; onMenu(s: SessionMeta, e: React.MouseEvent): void }) {
  const st = useStore()
  const m = st.machines[machine]
  const groupOrder = m?.settings.groupOrder
  const groups = groupSessions(m?.sessions ?? [], st.showArchived, groupOrder)
  const { start, sortable } = useDragSort((key, ids) => {
    if (!m) return
    if (key === `${machine}|groups`) {
      // Folders not on screen (the other of active and archived) keep their place after these.
      const order = [...ids, ...(groupOrder ?? []).filter((c) => !ids.includes(c))]
      m.settings = { ...m.settings, groupOrder: order }
      void api('/api/settings', 'PUT', { groupOrder: order }, machine)
    } else {
      m.sessions = m.sessions.map((s) => ids.includes(s.id) ? { ...s, order: ids.indexOf(s.id) } : s)
      void api('/api/sessions/order', 'PUT', { ids: ids.map(localId) }, machine)
    }
    changed()
  })
  return <>{groups.map(([cwd, list]) => {
    const g = sortable(`${machine}|groups`, cwd)
    // A session and those nested under it move as one.
    const ids = new Set(list.map((x) => x.id))
    const kids = (parent: string | null) => list.filter((x) => (x.parentId && ids.has(x.parentId) ? x.parentId : null) === parent)
    const branch = (x: SessionMeta, depth: number): React.ReactNode => {
      const key = `${machine}|${cwd}|${x.parentId && ids.has(x.parentId) ? x.parentId : ''}`
      const b = sortable(key, x.id)
      return (
        <div key={x.id} {...b} className={`branch${b.className}`}>
          <Row s={x} depth={depth} active={st.selected === x.id} onPointerDown={(e) => start(e, key, x.id)} onMenu={onMenu} />
          {kids(x.id).map((k) => branch(k, depth + 1))}
        </div>
      )
    }
    return (
      <div key={cwd} {...g} className={`group${g.className}`}>
        <div className="group-head" onPointerDown={(e) => start(e, `${machine}|groups`, cwd)}>
          <span>{cwd.split(/[\\/]/).pop()}</span>
          <button className="link" title={`New session in ${machine ? cwd : short(cwd)}`} onClick={() => onNew(cwd)}>+</button>
        </div>
        {kids(null).map((x) => branch(x, 0))}
      </div>
    )
  })}</>
}

function Row({ s, depth = 0, active, label, onPointerDown, onMenu }: { s: SessionMeta; depth?: number; active: boolean; label?: string; onPointerDown?(e: React.PointerEvent): void; onMenu?(s: SessionMeta, e: React.MouseEvent): void }) {
  const parent = useStore().sessions.find((x) => x.id === s.parentId)
  return (
    <button className={`row${active ? ' active' : ''}${s.unread ? ' unread' : ''}`} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => select(s.id)} onPointerDown={onPointerDown} onContextMenu={onMenu && ((e) => onMenu(s, e))}>
      <Mascot status={s.status} look={s.look} fatigue={fatigue(s.context.used, s.context.window)} size={26} title={STATUS_LABEL[s.status]} child={!!s.parentId} />
      <span className="row-main">
        <span className="row-title">{machineOf(s.id) !== LOCAL && <GlobeIcon size={11} className="row-remote" title={`On ${machineOf(s.id)}`} />}{label ?? s.title}{parent && <span className="row-from"> (from {parent.title})</span>}</span>
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
    : `You used ${Math.round(used * 100)}% of your ${name} limit. Codinger does not know its dollar value yet.`
  return [line('5-hour', u.fiveHour, u.rate?.fiveHour), line('weekly', u.sevenDay, u.rate?.sevenDay)].filter(Boolean).join('\n\n')
    + `\n\nDollar values are estimates: Codinger compares Claude Code's spend at API prices with how far the percentages move (${u.rate?.pairs ?? 0} measurements). Click to see what your plan costs you.`
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
