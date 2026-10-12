import { useState } from 'react'
import type { PermissionMode, SessionMeta } from '../../../shared/types.ts'
import { api, select, setComposer, state } from '../store.ts'
import { DirPicker } from './DirPicker.tsx'

export function NewSession({ cwd: initial, onClose }: { cwd: string; onClose(): void }) {
  const [cwd, setCwd] = useState(initial)
  const [title, setTitle] = useState('')
  const [model, setModel] = useState('')
  const [mode, setMode] = useState<PermissionMode>('auto')
  const [parentId, setParentId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true); setErr(null)
    try {
      const m = await api<SessionMeta>('/api/sessions', 'POST', { cwd, title, model: model || null, permissionMode: mode, parentId: parentId || null })
      if (prompt.trim()) await api(`/api/sessions/${m.id}/send`, 'POST', { parts: [{ kind: 'text', text: prompt }] })
      else setComposer(m.id, { text: '' })
      select(m.id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      state.error = null
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal wide" onSubmit={(e) => { e.preventDefault(); void create() }} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <h2>New session</h2>
        <div className="field">Directory
          <DirPicker value={cwd} onChange={setCwd} autoFocus />
        </div>
        <label>Title <input value={title} placeholder="Defaults to the folder name" onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="two">
          <label>Model
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Default</option><option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option><option value="fable">Fable</option>
            </select>
          </label>
          <label>Permissions
            <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              <option value="auto">Auto mode</option><option value="default">Ask before tools</option><option value="acceptEdits">Auto-accept edits</option><option value="plan">Plan only</option><option value="bypassPermissions">Bypass permissions</option>
            </select>
          </label>
        </div>
        <label>Sub-task of
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">(none)</option>
            {state.sessions.filter((s) => s.kind === 'worker' && !s.archived).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
        <label>First message (optional)
          <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void create() } }} />
        </label>
        {err && <div className="notice error">{err}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !cwd.trim()}>{busy ? 'Starting…' : 'Create'}</button>
        </div>
      </form>
    </div>
  )
}
