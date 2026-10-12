// Settings: the global AGENTS.md that every session is given (server/agentsmd.ts).

import { useEffect, useState } from 'react'
import { api } from '../store.ts'
import { shortPath } from './DirPicker.tsx'

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const [file, setFile] = useState<{ path: string; text: string } | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api<{ path: string; text: string }>('/api/agents-md', 'GET').then((f) => { setFile(f); setText(f.text) })
  }, [])

  const dirty = !!file && text !== file.text
  const save = async () => {
    setBusy(true)
    try { setFile(await api('/api/agents-md', 'PUT', { text })) } finally { setBusy(false) }
  }

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget && !dirty) onClose() }}>
      <div className="modal wide" onKeyDown={(e) => {
        if (e.key === 'Escape' && !dirty) onClose()
        if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (dirty) void save() }
      }}>
        <h2>Settings</h2>
        <div className="settings-file">
          <b>AGENTS.md</b>
          {file && <span className="muted mono">{shortPath(file.path)}</span>}
        </div>
        <textarea className="agents-md mono" rows={22} value={text} disabled={!file} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <div className="modal-actions">
          <button onClick={onClose}>{dirty ? 'Discard' : 'Close'}</button>
          <button className="primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
