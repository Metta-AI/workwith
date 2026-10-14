import { useEffect, useState } from 'react'
import { useEscape } from '../escape.ts'
import type { ImageRef, PermissionMode, SessionMeta } from '../../../shared/types.ts'
import { api, select, setComposer, state } from '../store.ts'
import { DirPicker } from './DirPicker.tsx'
import { RichInput } from './Inputs.tsx'

export function NewSession({ cwd: initial, onClose }: { cwd: string; onClose(): void }) {
  useEscape(onClose)
  const [cwd, setCwd] = useState(initial)
  const [title, setTitle] = useState('')
  const [model, setModel] = useState('')
  const [mode, setMode] = useState<PermissionMode>('auto')
  const [parentId, setParentId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [images, setImages] = useState<ImageRef[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Whether the typed directory exists; if it doesn't, Create makes it first.
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!cwd.trim()) { setMissing(false); return }
    let live = true
    const t = setTimeout(() => {
      void api<{ kind: 'dir' | 'file' | 'missing' }>(`/api/fs/stat?path=${encodeURIComponent(cwd)}`, 'GET')
        .then((r) => { if (live) setMissing(r.kind === 'missing') }).catch(() => {})
    }, 200)
    return () => { live = false; clearTimeout(t) }
  }, [cwd])

  const create = async () => {
    setBusy(true); setErr(null)
    try {
      const m = await api<SessionMeta>('/api/sessions', 'POST', { cwd, title, model: model || null, permissionMode: mode, parentId: parentId || null, mkdir: missing })
      if (prompt.trim() || images.length) await api(`/api/sessions/${m.id}/send`, 'POST', { parts: [{ kind: 'text', text: prompt, images }] })
      else setComposer(m.id, { text: '' })
      select(m.id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      state.error = null
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-back top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal wide" onSubmit={(e) => { e.preventDefault(); void create() }}>
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
        <div className="field">First message (optional)
          <RichInput value={prompt} onChange={setPrompt} images={images} onImages={setImages} onSubmit={() => void create()} minRows={4} />
        </div>
        {err && <div className="notice error">{err}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !cwd.trim()}>{busy ? 'Starting…' : missing ? 'Create directory and start' : 'Create'}</button>
        </div>
      </form>
    </div>
  )
}
