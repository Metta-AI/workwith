// Publish a session's transcript read-only to web.codinger.app (server/share.ts): choose what
// goes, see it as a reader will, and see what the scan for keys found. Published again, it
// keeps its link, until you take it down.

import { useEffect, useState } from 'react'
import type { SessionMeta } from '../../../shared/types.ts'
import { DEFAULT_OPTS, type SharePreview, type ShareOpts } from '../../../shared/share.ts'
import { api, baseOf, localId, machineOf, useStore } from '../store.ts'
import { useEscape } from '../escape.ts'
import { XIcon } from './Icons.tsx'

const size = (b: number) => b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : `${(b / 1e6).toFixed(1)} MB`

export function PublishDialog({ m, onClose }: { m: SessionMeta; onClose(): void }) {
  const st = useStore()
  const [opts, setOpts] = useState<ShareOpts>(m.share?.opts ?? DEFAULT_OPTS)
  const [info, setInfo] = useState<SharePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [down, setDown] = useState(false)
  const [copied, setCopied] = useState(false)
  useEscape(onClose)
  const q = new URLSearchParams({ tools: opts.tools, thinking: opts.thinking ? '1' : '0', redact: opts.redact ? '1' : '0' })
  useEffect(() => {
    setInfo(null)
    void api<SharePreview>(`/api/sessions/${m.id}/share?${q}`, 'GET').then(setInfo).catch(() => {})
  }, [q.toString()])
  const machine = machineOf(m.id)
  // On web.codinger.app every machine is connected; on a machine, it must be.
  const linked = st.web || !!st.machines[machine]?.remote?.linked
  const frame = `/share.html?${new URLSearchParams({ preview: localId(m.id), base: baseOf(machine), ...Object.fromEntries(q) })}`
  const set = (p: Partial<ShareOpts>) => setOpts({ ...opts, ...p })
  const publish = async () => {
    setBusy(true)
    try { await api(`/api/sessions/${m.id}/share`, 'POST', opts) } catch { /* shown */ } finally { setBusy(false) }
  }
  const takeDown = async () => {
    if (!down) return setDown(true)
    setBusy(true)
    try { await api(`/api/sessions/${m.id}/share`, 'DELETE') } catch { /* shown */ } finally { setBusy(false); setDown(false) }
  }
  const copy = (url: string) => { void navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1200) }
  const found = info?.found ?? []
  const hits = found.reduce((n, f) => n + f.n, 0)
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal wide publish-modal">
        <div className="appearance-head">
          <h2>{m.share ? 'Published transcript' : 'Publish this transcript'}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><XIcon size={14} /></button>
        </div>
        <p className="muted publish-lead">Anyone with the link can read it. It is a copy: messages after this go only when you publish again.</p>
        {m.share && (
          <div className="publish-link">
            <a href={m.share.url} target="_blank" rel="noreferrer">{m.share.url}</a>
            <button onClick={() => copy(m.share!.url)}>{copied ? 'Copied' : 'Copy'}</button>
            <span className="muted">published {new Date(m.share.at).toLocaleString()}</span>
          </div>
        )}
        <div className="publish-opts">
          <label className="settings-check"><input type="radio" checked={opts.tools === 'line'} onChange={() => set({ tools: 'line' })} /> Tool calls: one line each (the tool and what it worked on)</label>
          <label className="settings-check"><input type="radio" checked={opts.tools === 'full'} onChange={() => set({ tools: 'full' })} /> Tool calls: with their input and output</label>
          <label className="settings-check"><input type="checkbox" checked={opts.thinking} onChange={(e) => set({ thinking: e.target.checked })} /> Include thinking</label>
          <label className="settings-check"><input type="checkbox" checked={opts.redact} onChange={(e) => set({ redact: e.target.checked })} /> Hide things that look like keys, and email addresses; show the home folder as ~</label>
        </div>
        <div className={`publish-scan${hits && !opts.redact ? ' warn' : ''}`}>
          {!info ? <span className="muted">Scanning…</span>
            : !hits ? <span className="muted">The scan found nothing that looks like a key. It cannot find everything: read the preview.</span>
            : <details>
              <summary>{hits === 1
                ? opts.redact ? 'Hidden: 1 thing that looks like a key or an email address.' : '1 thing looks like a key or an email address, and will be published as it is.'
                : opts.redact ? `Hidden: ${hits} things that look like keys or email addresses.` : `${hits} things look like keys or email addresses, and will be published as they are.`}</summary>
              <ul>{found.map((f, i) => <li key={i}>{f.kind} <code>{f.sample}</code> in {f.where}{f.n > 1 ? ` (${f.n})` : ''}</li>)}</ul>
            </details>}
          {!!info?.skipped.length && <div className="muted">Too big to publish (over 90 MB): {info.skipped.map((s) => `${s.name} (${size(s.size)})`).join(', ')}</div>}
        </div>
        <iframe key={frame} className="publish-frame" src={frame} title="Preview" />
        <div className="modal-actions publish-actions">
          {info && <span className="muted">About {size(info.bytes)}</span>}
          {!linked && <span className="publish-need">Connect this machine to web.codinger.app first, in Settings.</span>}
          {m.share && <button className="danger" disabled={busy} onClick={takeDown} onMouseLeave={() => setDown(false)}>{down ? 'Take it down?' : 'Take down'}</button>}
          <button className="primary" disabled={busy || !linked || !info} onClick={publish}>{busy ? 'Publishing…' : m.share ? 'Publish again' : 'Publish'}</button>
        </div>
      </div>
    </div>
  )
}
