// Choose a working directory: type it, pick a recent one (from Codinger and
// from every Claude Code session on this machine), browse for it in place, or
// use the native macOS folder dialog.

import { useEffect, useRef, useState } from 'react'
import type { DirListing, RecentDir } from '../../../shared/types.ts'
import { api, currentMachine, LOCAL, state, urlOf } from '../store.ts'
import { timeAgo } from '../util.ts'
import { FolderIcon, UpIcon } from './Icons.tsx'

// Your home directory as ~, on the machine the path is on (the current one by default).
// Windows paths do not care about case.
export const shortPath = (p: string, machine?: string) => {
  const h = machine == null ? state.home : state.machines[machine]?.home
  if (!h) return p
  const at = h.includes('\\') ? p.toLowerCase().startsWith(h.toLowerCase()) : p.startsWith(h)
  return at && (p.length === h.length || '/\\'.includes(p[h.length])) ? '~' + p.slice(h.length) : p
}

// machine: whose folders; the current session's by default.
// onPick: called after you choose a directory from the menu or the browser, not as you type.
export function DirPicker({ value, onChange, onPick, autoFocus, machine = currentMachine() }: { value: string; onChange(v: string): void; onPick?(p: string): void; autoFocus?: boolean; machine?: string }) {
  const [recent, setRecent] = useState<RecentDir[]>([])
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<string | null>(null) // null until you type
  const [index, setIndex] = useState(0)
  const [browsing, setBrowsing] = useState(false)
  const [picking, setPicking] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { void api<RecentDir[]>('/api/recent-dirs', 'GET', undefined, machine).then(setRecent).catch(() => {}) }, [machine])

  const q = (filter ?? '').toLowerCase().replace(/^~/, '')
  const shown = recent.filter((d) => !q || d.path.toLowerCase().includes(q)).slice(0, 30)
  const choose = (p: string) => { onChange(p); setFilter(null); setOpen(false); setBrowsing(false); onPick?.(p) }

  const finder = async () => {
    setPicking(true)
    try { const r = await api<{ path: string | null }>('/api/fs/pick', 'POST', { path: value }, LOCAL); if (r.path) choose(r.path) } finally { setPicking(false) }
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
          // Focus alone does not open the menu: Down, typing or a click does.
          onMouseDown={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { onChange(e.target.value); setFilter(e.target.value); setOpen(true); setIndex(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && !open && shown.length) { e.preventDefault(); setOpen(true); setIndex(0); return }
            if (!open || !shown.length) return
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, shown.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
            else if (e.key === 'Enter' && shown[index]) { e.preventDefault(); choose(shown[index].path) }
            else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
          }}
        />
        <button type="button" onClick={() => { setBrowsing(!browsing); setOpen(false) }}>{browsing ? 'Close' : 'Browse…'}</button>
        {!state.web && machine === LOCAL && state.machines[LOCAL]?.platform === 'darwin' && <button type="button" disabled={picking} onClick={finder} title="Choose a folder in Finder">{picking ? 'Waiting…' : 'Finder…'}</button>}
      </div>
      {open && !browsing && shown.length > 0 && (
        <div className="dir-menu" onMouseDown={(e) => e.preventDefault()}>
          <div className="dir-menu-head">{filter ? 'Matching recent directories' : 'Recent directories'}</div>
          {shown.map((d, i) => (
            <button type="button" key={d.path} className={i === index ? 'on' : ''} onMouseEnter={() => setIndex(i)} onClick={() => choose(d.path)}>
              <span className="mono">{shortPath(d.path, machine)}</span>
              <span className="muted">{d.source === 'claude' ? 'Claude Code' : d.source === 'both' ? 'Codinger · Claude Code' : 'Codinger'} · {timeAgo(d.ts)}</span>
            </button>
          ))}
        </div>
      )}
      {browsing && <DirBrowser key={machine} start={value} onChoose={choose} machine={machine} />}
    </div>
  )
}

function DirBrowser({ start, onChoose, machine }: { start: string; onChoose(p: string): void; machine: string }) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [hidden, setHidden] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const go = async (p: string, h = hidden) => {
    try {
      const r = await fetch(urlOf(`/api/fs/dirs?path=${encodeURIComponent(p)}${h ? '&hidden=1' : ''}`, machine))
      const j = await r.json()
      if (!r.ok) throw new Error(j.error)
      setListing(j); setErr(null)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => { void go(start.trim() || '~').catch(() => go('~')) }, [])
  useEffect(() => { if (err && !listing) void go('~') }, [err])
  if (!listing) return <div className="dir-browser muted pad">{err ?? 'Loading…'}</div>
  // A Windows path starts with its drive, C:\, and uses backslashes.
  const sep = listing.roots ? '\\' : '/'
  const root = listing.roots ? listing.path.slice(0, 3) : '/'
  const crumbs = listing.path.slice(root.length).split(sep).filter(Boolean)
  const join = (d: string) => listing.path.endsWith(sep) ? listing.path + d : listing.path + sep + d
  return (
    <div className="dir-browser">
      <div className="crumbs">
        {listing.roots && listing.roots.length > 1
          ? <select value={root} onChange={(e) => void go(e.target.value)}>{listing.roots.map((r) => <option key={r}>{r}</option>)}</select>
          : <button type="button" className="link" onClick={() => void go(root)}>{root}</button>}
        {crumbs.map((c, i) => <button type="button" key={i} className="link" onClick={() => void go(root + crumbs.slice(0, i + 1).join(sep))}>{c}{sep}</button>)}
      </div>
      <div className="dir-list">
        {listing.parent && <button type="button" onClick={() => void go(listing.parent!)}><UpIcon size={13} /> ..</button>}
        {listing.dirs.map((d) => <button type="button" key={d} onClick={() => void go(join(d))} onDoubleClick={() => onChoose(join(d))}><FolderIcon size={13} /> {d}</button>)}
        {!listing.dirs.length && <div className="muted pad">No subfolders</div>}
      </div>
      <div className="dir-foot">
        <label className="toggle"><input type="checkbox" checked={hidden} onChange={(e) => { setHidden(e.target.checked); void go(listing.path, e.target.checked) }} /> Hidden folders</label>
        {err && <span className="muted">{err}</span>}
        <button type="button" className="primary" onClick={() => onChoose(listing.path)}>Use {shortPath(listing.path, machine)}</button>
      </div>
    </div>
  )
}
