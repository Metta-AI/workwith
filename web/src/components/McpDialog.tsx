// The MCP servers of a session that started with them off (server/mcpservers.ts):
// a chip in the header, and a dialog to turn each on for this session, or keep it
// on for every new session.

import { useEffect, useRef, useState } from 'react'
import { useEscape } from '../escape.ts'
import type { SessionMeta } from '../../../shared/types.ts'
import { api, useStore } from '../store.ts'
import { CheckIcon, XIcon } from './Icons.tsx'
import { kTokens } from '../util.ts'

type Server = { name: string; status: string; scope: string; tools: number; tokens?: number }

// Claude Code names a claude.ai connector "claude.ai Gmail": the name, and where it comes from.
const split = (n: string) => n.startsWith('claude.ai ') ? { name: n.slice(10), from: 'claude.ai' } : { name: n, from: '' }
const Name = ({ n }: { n: string }) => { const x = split(n); return <>{x.name}{x.from && <span className="muted mcp-from"> {x.from}</span>}</> }
// "8 tools · 2k tokens": the size of all its tools.
const size = (s: Server) => [s.tools ? `${s.tools} ${s.tools === 1 ? 'tool' : 'tools'}` : '', s.tokens ? `${kTokens(s.tokens)} tokens` : ''].filter(Boolean).join(' · ')
const SIZE_TIP = 'The size of all its tools in tokens, as Claude Code estimates it. Claude Code sends the full text of a tool only when Claude looks it up.'

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
  const [adding, setAdding] = useState(false)
  const signIn = () => void api(`/api/sessions/${m.id}/run`, 'POST', { command: 'claude /mcp' }).catch((e) => setErr(String(e.message ?? e)))
  const look = async () => {
    setBusy(true); setErr(null)
    try { setServers(await api<Server[]>('/api/mcp', 'POST', { cwd: m.cwd })) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const on = m.mcp?.on ?? []
  // "Start with them off" wins over these; before you choose any, all of them start on.
  const startOff = st.settings.mcpStartOff !== false
  const always = st.settings.mcpAlways ?? (startOff ? [] : (servers ?? []).map((s) => s.name))
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
            <thead><tr><th>Server</th><th data-tip={SIZE_TIP}>Tools</th><th>This session</th><th data-tip={startOff ? 'Off while "Start new sessions with my MCP servers off" is on in Settings' : undefined}>Every new session</th></tr></thead>
            <tbody>
              {servers.map((s) => (
                <tr key={s.name}>
                  <td><Name n={s.name} />{s.status === 'needs-auth' && <> <span className="muted">· needs sign-in ·</span> <button className="link" onClick={signIn} data-tip="Opens Claude Code in Terminal with /mcp (type /mcp if the menu does not open). Choose the server and sign in, quit Claude Code, then press Refresh here.">Sign in</button></>}{s.status === 'failed' && <span className="muted"> · failed</span>}</td>
                  <td className="muted">{size(s)}</td>
                  <td><input type="checkbox" checked={on.includes(s.name)} disabled={s.status === 'needs-auth'} onChange={(e) => toggle(s.name, e.target.checked)} /></td>
                  <td className={startOff ? 'mcp-overridden' : undefined}><input type="checkbox" checked={always.includes(s.name)} onChange={(e) => keep(s.name, e.target.checked)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {startOff && !!servers?.length && <p className="muted mcp-hint">"Start new sessions with my MCP servers off" is on in Settings, so new sessions start with none of these. Every new session takes effect when you turn that setting off.</p>}
        {adding ? <AddServer cwd={m.cwd} onDone={(added) => { setAdding(false); if (added) void look() }} /> : (
          <div className="mcp-add-links">
            <button className="link" onClick={() => setAdding(true)}>Add a server…</button>
            <a href="https://claude.ai/settings/connectors" target="_blank" rel="noreferrer">Add a claude.ai connector</a>
          </div>
        )}
        <div className="modal-actions">
          <button className={m.mcp?.missing || servers?.length === 0 ? 'primary' : 'link'} disabled={busy} onClick={() => void look()} data-tip="Runs Claude Code for a few seconds to list your MCP servers. No API call.">{busy ? 'Looking…' : 'Refresh'}</button>
        </div>
      </div>
    </div>
  )
}

// Add a server with `claude mcp add` (POST /api/mcp/add): a URL, or a command that starts it.
const SCOPES = [
  { v: 'local', label: 'This folder, only for you' },
  { v: 'project', label: 'This project, shared in .mcp.json' },
  { v: 'user', label: 'All folders' },
]
function AddServer({ cwd, onDone }: { cwd: string; onDone(added: boolean): void }) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState('http')
  const [target, setTarget] = useState('')
  const [scope, setScope] = useState('local')
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const stdio = transport === 'stdio'
  const add = async () => {
    setBusy(true); setErr(null)
    const list = extra.split('\n').map((l) => l.trim()).filter(Boolean)
    try { await api('/api/mcp/add', 'POST', { cwd, name, transport, target, scope, ...(stdio ? { env: list } : { headers: list }) }); onDone(true) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return (
    <div className="mcp-add">
      <h3>Add a server</h3>
      <div className="two">
        <label>Name <input value={name} placeholder="sentry" autoFocus onChange={(e) => setName(e.target.value)} /></label>
        <label>Kind
          <select value={transport} onChange={(e) => setTransport(e.target.value)}>
            <option value="http">URL (HTTP)</option><option value="sse">URL (SSE)</option><option value="stdio">Command on this machine</option>
          </select>
        </label>
      </div>
      <label>{stdio ? 'Command' : 'URL'} <input className="mono" value={target} placeholder={stdio ? 'npx -y @modelcontextprotocol/server-github' : 'https://mcp.sentry.dev/mcp'} onChange={(e) => setTarget(e.target.value)} /></label>
      <label>{stdio ? 'Environment variables, one KEY=value on each line (optional)' : 'Headers, one "Name: value" on each line (optional)'}
        <textarea className="mono" rows={2} value={extra} placeholder={stdio ? 'GITHUB_TOKEN=…' : 'Authorization: Bearer …'} onChange={(e) => setExtra(e.target.value)} />
      </label>
      <label>Where
        <select value={scope} onChange={(e) => setScope(e.target.value)}>{SCOPES.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}</select>
      </label>
      {!stdio && <p className="muted mcp-hint">If the server asks you to sign in, a Sign in link shows next to it after you add it.</p>}
      {err && <div className="notice error">{err}</div>}
      <div className="modal-actions">
        <button onClick={() => onDone(false)}>Cancel</button>
        <button className="primary" disabled={busy || !name.trim() || !target.trim()} onClick={() => void add()}>{busy ? 'Adding…' : 'Add'}</button>
      </div>
    </div>
  )
}

// The MCP servers a new session starts with (NewSession): the menu lists every server
// Codinger knows in the folder, and each one picked shows as a pill. value null: not changed
// yet, so the picked ones are what a session starts with now: none when sessions start with
// them off, else the ones kept on for every new session (all of them before you chose).
export function McpPicker({ cwd, machine, value, onChange, startOff, always }: { cwd: string; machine: string; value: string[] | null; onChange(v: string[]): void; startOff: boolean; always?: string[] }) {
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
  const picked = value ?? (startOff ? [] : always ?? usable.map((s) => s.name))
  const q = query.trim().toLowerCase()
  const items = (servers ?? []).filter((s) => !q || s.name.toLowerCase().includes(q))
  const flip = (s: Server) => {
    if (picked.includes(s.name)) onChange(picked.filter((n) => n !== s.name))
    else if (s.status !== 'needs-auth') onChange([...picked, s.name])
    setQuery(''); setIndex(0); setMoved(false)
  }
  return (
    <div className="flag-picker">
      <div className="mcp-row">
        <div className="flag-box" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus() } }}>
          {picked.map((n) => (
            <span key={n} className="flag-chip">{split(n).name}
              <button type="button" className="link" aria-label={`Remove ${split(n).name}`} onClick={() => onChange(picked.filter((x) => x !== n))}><XIcon size={11} /></button>
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
              else if (e.key === 'Enter' && open && (q || moved) && items[index]) { e.preventDefault(); flip(items[index]) }
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
            <button type="button" key={s.name} className={i === index ? 'on' : ''} disabled={s.status === 'needs-auth' && !picked.includes(s.name)} aria-pressed={picked.includes(s.name)} onMouseEnter={() => setIndex(i)} onClick={() => flip(s)}>
              <span className="mcp-item"><span className="mcp-check">{picked.includes(s.name) && <CheckIcon size={12} />}</span><span><Name n={s.name} /></span></span>
              <span className="muted">{s.status === 'needs-auth' ? 'needs sign-in' : s.status === 'failed' ? 'failed' : size(s)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
