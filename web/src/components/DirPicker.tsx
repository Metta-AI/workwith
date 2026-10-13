// Choose a working directory: type it, pick a recent one (from Codiner and
// from every Claude Code session on this machine), browse for it in place, or
// use the native macOS folder dialog.

import { useEffect, useRef, useState } from 'react'
import type { DirListing, RecentDir } from '../../../shared/types.ts'
import { api, state } from '../store.ts'
import { timeAgo } from '../util.ts'
import { FolderIcon, UpIcon } from './Icons.tsx'

export const shortPath = (p: string) => (state.home && p.startsWith(state.home) ? '~' + p.slice(state.home.length) : p)

export function DirPicker({ value, onChange, autoFocus }: { value: string; onChange(v: string): void; autoFocus?: boolean }) {
  const [recent, setRecent] = useState<RecentDir[]>([])
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<string | null>(null) // null until you type
  const [index, setIndex] = useState(0)
  const [browsing, setBrowsing] = useState(false)
  const [picking, setPicking] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { void api<RecentDir[]>('/api/recent-dirs', 'GET').then(setRecent).catch(() => {}) }, [])

  const q = (filter ?? '').toLowerCase().replace(/^~/, '')
  const shown = recent.filter((d) => !q || d.path.toLowerCase().includes(q)).slice(0, 30)
  const choose = (p: string) => { onChange(p); setFilter(null); setOpen(false); setBrowsing(false) }

  const finder = async () => {
    setPicking(true)
    try { const r = await api<{ path: string | null }>('/api/fs/pick', 'POST', { path: value }); if (r.path) choose(r.path) } finally { setPicking(false) }
  }

  return (
    <div className="dir-picker">
      <div className="dir-row">
        <input
          ref={input}
          autoFocus={autoFocus}
          className="mono"
          value={value}
          placeholder="~/Projects/my-repo"
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { onChange(e.target.value); setFilter(e.target.value); setOpen(true); setIndex(0) }}
          onKeyDown={(e) => {
            if (!open || !shown.length) return
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, shown.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
            else if (e.key === 'Enter' && filter !== null && shown[index]) { e.preventDefault(); choose(shown[index].path) }
            else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
          }}
        />
        <button type="button" onClick={() => { setBrowsing(!browsing); setOpen(false) }}>{browsing ? 'Close' : 'Browse…'}</button>
        {state.platform === 'darwin' && <button type="button" disabled={picking} onClick={finder} title="Choose a folder in Finder">{picking ? 'Waiting…' : 'Finder…'}</button>}
      </div>
      {open && !browsing && shown.length > 0 && (
        <div className="dir-menu" onMouseDown={(e) => e.preventDefault()}>
          <div className="dir-menu-head">{filter ? 'Matching recent directories' : 'Recent directories'}</div>
          {shown.map((d, i) => (
            <button type="button" key={d.path} className={i === index ? 'on' : ''} onMouseEnter={() => setIndex(i)} onClick={() => choose(d.path)}>
              <span className="mono">{shortPath(d.path)}</span>
              <span className="muted">{d.source === 'claude' ? 'Claude Code' : d.source === 'both' ? 'Codiner · Claude Code' : 'Codiner'} · {timeAgo(d.ts)}</span>
            </button>
          ))}
        </div>
      )}
      {browsing && <DirBrowser start={value} onChoose={choose} />}
    </div>
  )
}

function DirBrowser({ start, onChoose }: { start: string; onChoose(p: string): void }) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [hidden, setHidden] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const go = async (p: string, h = hidden) => {
    try {
      const r = await fetch(`/api/fs/dirs?path=${encodeURIComponent(p)}${h ? '&hidden=1' : ''}`)
      const j = await r.json()
      if (!r.ok) throw new Error(j.error)
      setListing(j); setErr(null)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => { void go(start.trim() || '~').catch(() => go('~')) }, [])
  useEffect(() => { if (err && !listing) void go('~') }, [err])
  if (!listing) return <div className="dir-browser muted pad">{err ?? 'Loading…'}</div>
  const crumbs = listing.path.split('/').filter(Boolean)
  return (
    <div className="dir-browser">
      <div className="crumbs">
        <button type="button" className="link" onClick={() => void go('/')}>/</button>
        {crumbs.map((c, i) => <button type="button" key={i} className="link" onClick={() => void go('/' + crumbs.slice(0, i + 1).join('/'))}>{c}/</button>)}
      </div>
      <div className="dir-list">
        {listing.parent && <button type="button" onClick={() => void go(listing.parent!)}><UpIcon size={13} /> ..</button>}
        {listing.dirs.map((d) => <button type="button" key={d} onClick={() => void go(`${listing.path}/${d}`)} onDoubleClick={() => onChoose(`${listing.path}/${d}`)}><FolderIcon size={13} /> {d}</button>)}
        {!listing.dirs.length && <div className="muted pad">No subfolders</div>}
      </div>
      <div className="dir-foot">
        <label className="toggle"><input type="checkbox" checked={hidden} onChange={(e) => { setHidden(e.target.checked); void go(listing.path, e.target.checked) }} /> Hidden folders</label>
        {err && <span className="muted">{err}</span>}
        <button type="button" className="primary" onClick={() => onChoose(listing.path)}>Use {shortPath(listing.path)}</button>
      </div>
    </div>
  )
}
