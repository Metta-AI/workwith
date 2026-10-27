// The MCP servers of a session that started with them off (server/mcpservers.ts):
// a chip in the header, and a dialog to turn each on for this session, or keep it
// on for every new session.

import { useEffect, useRef, useState } from 'react'
import { useEscape } from '../escape.ts'
import type { SessionMeta } from '../../../shared/types.ts'
import { api, useStore } from '../store.ts'
import { XIcon } from './Icons.tsx'

type Server = { name: string; status: string; scope: string; tools: number }

export function McpPill({ m }: { m: SessionMeta }) {
  const [open, setOpen] = useState(false)
  if (m.kind !== 'worker' || !m.mcp) return null
  const on = m.mcp.on, missing = m.mcp.missing
  const tip = missing
    ? `Claude asked for ${missing === 'a list of servers' ? 'your MCP servers' : `"${missing}"`}, which Codinger does not know. Click, then Refresh to look for servers.`
    : on.length
    ? `MCP servers on: ${on.join(', ')}. Others are off to keep the context small.\n\nClaude turns one on when it needs it. Click to change.`
    : 'MCP servers are off here to keep the context small. Claude turns one on when it needs it.\n\nClick to change.'
  return <>
    <button className={`cache-pill mcp-pill${missing ? ' ask' : ''}`} data-tip={tip} onClick={() => setOpen(true)}>{missing ? 'MCP · Refresh?' : `MCP ${on.length}`}</button>
    {open && <McpDialog m={m} onClose={() => setOpen(false)} />}
  </>
}

function McpDialog({ m, onClose }: { m: SessionMeta; onClose: () => void }) {
  useEscape(onClose)
  const st = useStore()
  const [servers, setServers] = useState<Server[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { void api<{ servers: Server[] }>(`/api/sessions/${m.id}/mcp`, 'GET').then((r) => setServers(r.servers)).catch((e) => setErr(String(e.message ?? e))) }, [m.id])
  const look = async () => {
    setBusy(true); setErr(null)
    try { setServers(await api<Server[]>('/api/mcp', 'POST', { cwd: m.cwd })) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const on = m.mcp?.on ?? []
  const always = st.settings.mcpAlways ?? []
  const toggle = (name: string, value: boolean) => void api(`/api/sessions/${m.id}/mcp`, 'POST', { name, on: value }).catch((e) => setErr(String(e.message ?? e)))
  const keep = (name: string, value: boolean) => void api('/api/settings', 'PUT', { mcpAlways: value ? [...new Set([...always, name])] : always.filter((n) => n !== name) })
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal wide mcp-modal">
        <div className="files-head">
          <h2>MCP servers</h2>
          <button className="icon-btn" title="Close" onClick={onClose}><XIcon size={14} /></button>
        </div>
        <p className="muted">
          This session started with your MCP servers off, so their tools take no room in its context. Turn one on here, or
          let Claude turn it on when the task needs it. A server you turn on adds its tools to the end of the conversation,
          so the prompt cache stays warm.
        </p>
        {m.mcp?.missing && <div className="notice">Claude asked for {m.mcp.missing === 'a list of servers' ? 'your MCP servers' : <b>{m.mcp.missing}</b>}. Press Refresh so that Codinger looks for your servers again, then tell Claude to try again.</div>}
        {err && <div className="notice error">{err}</div>}
        {!servers ? <div className="muted">Loading…</div> : !servers.length ? <div className="muted">Codinger knows no MCP servers here yet. Press Refresh to look for them.</div> : (
          <table className="mcp-table">
            <thead><tr><th>Server</th><th>Tools</th><th>This session</th><th>Every new session</th></tr></thead>
            <tbody>
              {servers.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}{s.status === 'needs-auth' && <span className="muted"> · needs sign-in</span>}{s.status === 'failed' && <span className="muted"> · failed</span>}</td>
                  <td className="muted">{s.tools || ''}</td>
                  <td><input type="checkbox" checked={on.includes(s.name)} disabled={s.status === 'needs-auth'} onChange={(e) => toggle(s.name, e.target.checked)} /></td>
                  <td><input type="checkbox" checked={always.includes(s.name)} onChange={(e) => keep(s.name, e.target.checked)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="modal-actions">
          <button className={m.mcp?.missing || servers?.length === 0 ? 'primary' : 'link'} disabled={busy} onClick={() => void look()} data-tip="Runs Claude Code for a few seconds to list your MCP servers. No API call.">{busy ? 'Looking…' : 'Refresh'}</button>
        </div>
      </div>
    </div>
  )
}

// The MCP servers a new session starts with (NewSession): type to search the servers
// Codinger knows in the folder; each one picked shows as a pill. value null: not changed
// yet, so the picked ones are all of them (startOn) or the ones you keep always on.
export function McpPicker({ cwd, machine, value, onChange, startOn, always }: { cwd: string; machine: string; value: string[] | null; onChange(v: string[]): void; startOn: boolean; always: string[] }) {
  const [servers, setServers] = useState<Server[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const [moved, setMoved] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let live = true
    const t = setTimeout(() => void api<Server[]>(`/api/mcp?cwd=${encodeURIComponent(cwd.trim() || '~')}`, 'GET', undefined, machine)
      .then((r) => { if (live) { setServers(r); setErr(null) } }).catch(() => { if (live) setServers([]) }), 200)
    return () => { live = false; clearTimeout(t) }
  }, [cwd, machine])
  const look = async () => {
    setBusy(true); setErr(null)
    try { setServers(await api<Server[]>('/api/mcp', 'POST', { cwd: cwd.trim() || '~' }, machine)) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const usable = (servers ?? []).filter((s) => s.status !== 'needs-auth')
  const picked = value ?? (startOn ? usable.map((s) => s.name) : always)
  const q = query.trim().toLowerCase()
  const items = (servers ?? []).filter((s) => !picked.includes(s.name) && (!q || s.name.toLowerCase().includes(q)))
  const add = (s: Server) => { if (s.status === 'needs-auth') return; onChange([...picked, s.name]); setQuery(''); setIndex(0); setMoved(false) }
  return (
    <div className="flag-picker">
      <div className="mcp-row">
        <div className="flag-box" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus() } }}>
          {picked.map((n) => (
            <span key={n} className="flag-chip">{n}
              <button type="button" className="link" aria-label={`Remove ${n}`} onClick={() => onChange(picked.filter((x) => x !== n))}><XIcon size={11} /></button>
            </span>
          ))}
          <input
            ref={input}
            value={query}
            placeholder={picked.length ? '' : servers && !servers.length ? 'None known here yet. Press Refresh' : 'None. Type to search'}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => { setOpen(false); setMoved(false) }, 150)}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); setIndex(0) }}
            onKeyDown={(e) => {
              if (e.key === 'Backspace' && !query && picked.length) onChange(picked.slice(0, -1))
              else if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setMoved(true); setIndex((i) => Math.min(i + 1, items.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setMoved(true); setIndex((i) => Math.max(i - 1, 0)) }
              // Enter with nothing typed or chosen is left to the form: it creates the session.
              else if (e.key === 'Enter' && open && (q || moved) && items[index]) { e.preventDefault(); add(items[index]) }
              else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false) }
            }}
          />
        </div>
        <button type="button" className="link" disabled={busy} onClick={() => void look()} data-tip="Runs Claude Code for a few seconds to list your MCP servers. No API call.">{busy ? 'Looking…' : 'Refresh'}</button>
      </div>
      {err && <div className="flag-err">{err}</div>}
      {open && items.length > 0 && (
        <div className="dir-menu" onMouseDown={(e) => e.preventDefault()}>
          {items.map((s, i) => (
            <button type="button" key={s.name} className={i === index ? 'on' : ''} disabled={s.status === 'needs-auth'} onMouseEnter={() => setIndex(i)} onClick={() => add(s)}>
              <span>{s.name}</span>
              <span className="muted">{s.status === 'needs-auth' ? 'needs sign-in' : s.status === 'failed' ? 'failed' : s.tools ? `${s.tools} tools` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
