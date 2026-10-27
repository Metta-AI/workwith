// Choose a session by typing part of its title or folder: each row shows its critter,
// title, folder name, age, spend and prompt cache. Used for "Sub-task of" in NewSession.

import { useRef, useState } from 'react'
import type { SessionMeta } from '../../../shared/types.ts'
import { useStore } from '../store.ts'
import { cacheOf, minutes, spendOf, useNow } from '../cache.ts'
import { fatigue, timeAgo } from '../util.ts'
import { Mascot } from './Mascot.tsx'
import { baseName } from './FileView.tsx'
import { XIcon } from './Icons.tsx'

export function SessionPicker({ sessions, value, onChange, placeholder = 'Type to search sessions' }: { sessions: SessionMeta[]; value: string; onChange(id: string): void; placeholder?: string }) {
  useStore()   // the dollars-or-percent choice of the spend
  const now = useNow()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  const chosen = sessions.find((s) => s.id === value)
  const q = query.trim().toLowerCase()
  const shown = sessions
    .filter((s) => !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q))
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, 30)
  const choose = (id: string) => { onChange(id); setQuery(''); setOpen(false); setEditing(false) }
  const edit = () => { setEditing(true); setOpen(true); setIndex(0); setTimeout(() => input.current?.focus()) }

  const cache = (s: SessionMeta) => {
    const c = cacheOf(s, now)
    if (c.left == null || s.status === 'working') return null
    return c.cold ? <span className="cache-hint cold">cache expired</span> : <span className="cache-hint warm">cache {minutes(c.left)}</span>
  }
  const row = (s: SessionMeta) => <>
    <Mascot status={s.status} look={s.look} fatigue={fatigue(s.context.used, s.context.window)} size={20} child={!!s.parentId} starred={s.starred} />
    <span className="sp-main"><span className="sp-title">{s.title}</span><span className="sp-sub mono">{baseName(s.cwd)}</span></span>
    <span className="sp-meta">{timeAgo(s.lastActivity)}{spendOf(s) && <> · {spendOf(s)!.label}</>}{cache(s) && <> · {cache(s)}</>}</span>
  </>

  return (
    <div className="session-picker">
      {chosen && !editing ? (
        <div className="sp-chosen">
          <button type="button" className="sp-row" onClick={edit}>{row(chosen)}</button>
          <button type="button" className="link" aria-label="Clear" onClick={() => onChange('')}><XIcon size={13} /></button>
        </div>
      ) : (
        <input
          ref={input}
          value={query}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => { setOpen(false); setEditing(false); setQuery('') }, 150)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setIndex(0) }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); setEditing(false); return }
            if (!open || !shown.length) return
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, shown.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
            else if (e.key === 'Enter' && shown[index]) { e.preventDefault(); choose(shown[index].id) }
          }}
        />
      )}
      {open && (chosen ? editing : true) && (
        <div className="dir-menu sp-menu" onMouseDown={(e) => e.preventDefault()}>
          {!shown.length && <div className="muted pad">No session matches</div>}
          {shown.map((s, i) => (
            <button type="button" key={s.id} className={`sp-row${i === index ? ' on' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => choose(s.id)}>{row(s)}</button>
          ))}
        </div>
      )}
    </div>
  )
}
