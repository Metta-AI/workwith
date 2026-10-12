import { useState } from 'react'
import type { SessionMeta } from '../../../shared/types.ts'
import { changed, closeSession, select, state, useStore } from '../store.ts'
import { HistoryDialog } from './HistoryDialog.tsx'
import { fatigue, timeAgo } from '../util.ts'
import { Mascot, STATUS_LABEL } from './Mascot.tsx'
import { NewSession } from './NewSession.tsx'
import { BackIcon, GearIcon, XIcon } from './Icons.tsx'
import { SettingsDialog } from './SettingsDialog.tsx'

// Sessions grouped by directory; sessions spawned for another one nest under it.
export function groupSessions(sessions: SessionMeta[], archived: boolean) {
  const workers = sessions.filter((s) => s.kind === 'worker' && s.archived === archived)
  const groups = new Map<string, SessionMeta[]>()
  for (const s of workers.sort((a, b) => a.createdAt - b.createdAt)) groups.set(s.cwd, [...(groups.get(s.cwd) ?? []), s])
  return [...groups.entries()].sort((a, b) => Math.max(...b[1].map((s) => s.lastActivity)) - Math.max(...a[1].map((s) => s.lastActivity)))
}

export function treeOf(list: SessionMeta[]): { s: SessionMeta; depth: number }[] {
  const ids = new Set(list.map((s) => s.id))
  const out: { s: SessionMeta; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const s of list) if ((s.parentId && ids.has(s.parentId) ? s.parentId : null) === parent) { out.push({ s, depth }); walk(s.id, depth + 1) }
  }
  walk(null, 0)
  return out
}

const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

export function Sidebar({ width }: { width: number }) {
  const st = useStore()
  const [newIn, setNewIn] = useState<string | null>(null)
  const [history, setHistory] = useState(false)
  const [settings, setSettings] = useState(false)
  const master = st.sessions.find((s) => s.kind === 'master')
  const groups = groupSessions(st.sessions, st.showArchived)
  const u = st.usage
  return (
    <aside className="sidebar" style={{ width }}>
      <div className="brand">
        <span>Codiner</span>
        <span className={`conn ${st.connected ? 'on' : 'off'}`} title={st.connected ? 'Connected' : 'Reconnecting…'} />
      </div>
      {master && <Row s={master} label="Master" active={st.selected === master.id} />}
      <div className="side-actions">
        <button className="primary" onClick={() => setNewIn('')}>+ New session</button>
        <button onClick={() => setHistory(true)} title="Pick up any Claude Code conversation on this machine, including ones from the terminal">Resume…</button>
      </div>
      <nav className="tree">
        {groups.map(([cwd, list]) => (
          <div key={cwd} className="group">
            <div className="group-head" title={cwd}>
              <span>{cwd.split('/').pop()}</span>
              <button className="link" title={`New session in ${short(cwd)}`} onClick={() => setNewIn(cwd)}>+</button>
            </div>
            {treeOf(list).map(({ s, depth }) => <Row key={s.id} s={s} depth={depth} active={st.selected === s.id} />)}
          </div>
        ))}
        {!groups.length && <div className="muted pad">{st.showArchived ? 'No archived sessions.' : 'No sessions yet.'}</div>}
      </nav>
      <div className="side-foot">
        <div className="side-foot-left">
          <button className="link" title="Settings" onClick={() => setSettings(true)}><GearIcon size={14} /></button>
          <button className="link" onClick={() => { state.showArchived = !state.showArchived; changed() }}>{st.showArchived ? <><BackIcon size={12} /> Active sessions</> : 'Archived'}</button>
        </div>
        {(u.fiveHour != null || u.sevenDay != null) && (
          <div className="usage" title="Your Claude plan's usage windows, as Claude Code reports them">
            {u.fiveHour != null && <span>5h {Math.round(u.fiveHour * 100)}%</span>}
            {u.sevenDay != null && <span>7d {Math.round(u.sevenDay * 100)}%</span>}
          </div>
        )}
      </div>
      {newIn !== null && <NewSession cwd={newIn} onClose={() => setNewIn(null)} />}
      {history && <HistoryDialog onClose={() => setHistory(false)} />}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    </aside>
  )
}

function Row({ s, depth = 0, active, label }: { s: SessionMeta; depth?: number; active: boolean; label?: string }) {
  return (
    <button className={`row${active ? ' active' : ''}${s.unread ? ' unread' : ''}`} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => select(s.id)}>
      <Mascot status={s.status} look={s.look} fatigue={fatigue(s.context.used, s.context.window)} size={26} title={STATUS_LABEL[s.status]} />
      <span className="row-main">
        <span className="row-title">{label ?? s.title}</span>
        <span className="row-sub">{s.compacting ? 'compacting' : STATUS_LABEL[s.status]} · {timeAgo(s.lastActivity)}</span>
      </span>
      {s.inbox.length > 0 && <span className="count" title="Drafts from the master">{s.inbox.length}</span>}
      {s.kind === 'worker' && !s.archived && (
        <span className="row-close" role="button" title="Close (moves to Archived, reopenable)" onClick={(e) => { e.stopPropagation(); void closeSession(s.id) }}><XIcon size={12} /></span>
      )}
    </button>
  )
}
