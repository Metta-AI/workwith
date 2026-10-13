// The MCP servers of a session that started with them off (server/mcpservers.ts):
// a chip in the header, and a dialog to turn each on for this session, or keep it
// on for every new session.

import { useEffect, useState } from 'react'
import type { SessionMeta } from '../../../shared/types.ts'
import { api, useStore } from '../store.ts'
import { XIcon } from './Icons.tsx'

type Server = { name: string; status: string; scope: string; tools: number }

export function McpPill({ m }: { m: SessionMeta }) {
  const [open, setOpen] = useState(false)
  if (m.kind !== 'worker' || !m.mcp) return null
  const on = m.mcp.on
  const tip = on.length
    ? `MCP servers on in this session: ${on.join(', ')}. The others are off, to keep the context small.\n\nClaude can turn one on when the task needs it. Click to turn them on or off yourself.`
    : 'Your MCP servers are off in this session, to keep the context small. Claude can turn one on when the task needs it.\n\nClick to turn them on or off yourself.'
  return <>
    <button className="cache-pill mcp-pill" data-tip={tip} onClick={() => setOpen(true)}>MCP {on.length}</button>
    {open && <McpDialog m={m} onClose={() => setOpen(false)} />}
  </>
}

function McpDialog({ m, onClose }: { m: SessionMeta; onClose: () => void }) {
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
      <div className="modal wide mcp-modal" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <div className="files-head">
          <h2>MCP servers</h2>
          <button className="icon-btn" title="Close" onClick={onClose}><XIcon size={14} /></button>
        </div>
        <p className="muted">
          This session started with your MCP servers off, so their tools take no room in its context. Turn one on here, or
          let Claude turn it on when the task needs it. A server you turn on adds its tools to the end of the conversation,
          so the prompt cache stays warm.
        </p>
        {err && <div className="notice error">{err}</div>}
        {!servers ? <div className="muted">Looking for your servers…</div> : !servers.length ? <div className="muted">No MCP servers found.</div> : (
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
          <button className="link" disabled={busy} onClick={() => void look()}>{busy ? 'Looking…' : 'Look again'}</button>
        </div>
      </div>
    </div>
  )
}
