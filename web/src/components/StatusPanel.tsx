import { useEffect, useState } from 'react'
import { api } from '../store.ts'

// The rest of the agent (server/agentstatus.ts): what its command says is running beside
// these sessions. One line until opened; shown only at an agent's desk that has the command.
type Status = { at: number; summary: string; busy: boolean; warn: string | null; sections: { title: string; rows: [string, string][] }[] }

export function StatusPanel() {
  const [s, setS] = useState<Status | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let stop = false
    const load = () => api<{ status: Status | null }>('/api/agent-status', 'GET').then((r) => { if (!stop) setS(r.status) }, () => {})
    load()
    const t = setInterval(load, 20_000)
    return () => { stop = true; clearInterval(t) }
  }, [])
  if (!s) return null
  return (
    <div className="agent-status">
      <button className="agent-status-head" onClick={() => setOpen(!open)} title="What else of the agent is at work">
        <span className={`agent-status-dot${s.busy ? ' busy' : ''}`} />
        <span className="agent-status-sum">{s.summary}</span>
        <span className="agent-status-caret">{open ? '▾' : '▸'}</span>
      </button>
      {s.warn && <div className="agent-status-warn">{s.warn}</div>}
      {open && (
        <div className="agent-status-body">
          {s.sections.map((sec, i) => (
            <div key={i}>
              {sec.title && <div className="agent-status-h">{sec.title}</div>}
              {sec.rows.map(([k, v], j) => <div key={j} className="agent-status-row"><span>{k}</span>{v && <span className="muted">{v}</span>}</div>)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
