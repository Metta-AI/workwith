// Every Claude Code conversation on this machine (terminal ones included),
// newest first. Resuming brings one into Codiner with its transcript.

import { useEffect, useState } from 'react'
import { useEscape } from '../escape.ts'
import type { HistoryItem, SessionMeta } from '../../../shared/types.ts'
import { api, select } from '../store.ts'
import { timeAgo } from '../util.ts'
import { shortPath } from './DirPicker.tsx'

export function HistoryDialog({ onClose }: { onClose(): void }) {
  useEscape(onClose)
  const [q, setQ] = useState('')
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      void fetch(`/api/history?q=${encodeURIComponent(q)}`).then((r) => r.json()).then(setItems).catch((e) => setErr(String(e)))
    }, q ? 180 : 0)
    return () => clearTimeout(t)
  }, [q])

  const open = async (h: HistoryItem) => {
    if (h.codinerId) { select(h.codinerId); onClose(); return }
    setBusy(h.id); setErr(null)
    try {
      const m = await api<SessionMeta>(`/api/history/${h.id}/resume`)
      select(m.id)
      onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
  }

  return (
    <div className="modal-back top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal wide">
        <h2>Resume a Claude Code session</h2>
        <input autoFocus placeholder="Search titles, folders and prompts…" value={q} onChange={(e) => setQ(e.target.value)} />
        {err && <div className="notice error">{err}</div>}
        <div className="history">
          {!items && <div className="muted pad">Reading ~/.claude/projects…</div>}
          {items?.length === 0 && <div className="muted pad">Nothing matches.</div>}
          {items?.map((h) => (
            <button key={h.id} className="history-item" disabled={busy !== null} onClick={() => void open(h)}>
              <div className="history-top">
                <span className="history-title">{h.title}</span>
                <span className="muted">{busy === h.id ? 'Opening…' : h.codinerId ? 'in Codiner' : timeAgo(h.mtime)}</span>
              </div>
              <div className="muted mono history-dir">{shortPath(h.cwd)}</div>
              {(h.lastPrompt || h.firstPrompt) && <div className="history-prompt">{(h.lastPrompt || h.firstPrompt).split('\n')[0]}</div>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
