// The files you attached to this session's messages (shared/files.ts), newest first:
// open one in the browser, or show it in its folder.

import type { SessionMeta } from '../../../shared/types.ts'
import { filesIn } from '../../../shared/files.ts'
import { api, LOCAL, localId, machineOf, media, state, useStore } from '../store.ts'
import { ClipIcon, FileIcon, FolderIcon, XIcon } from './Icons.tsx'

export function filesOf(sid: string): string[] {
  const names: string[] = []
  for (const e of state.events[sid] ?? []) if (e.t === 'user') for (const p of e.parts) names.push(...filesIn(p.text ?? ''))
  return [...new Set(names.reverse())]
}

export function FilesPanel({ m, width, onHide }: { m: SessionMeta; width: number; onHide(): void }) {
  useStore()
  const files = filesOf(m.id)
  const machine = machineOf(m.id)
  const sep = m.cwd.includes('\\') ? '\\' : '/'
  return (
    <aside className="attention files-panel" style={{ width }}>
      <div className="attention-top">
        <span className="attention-head"><ClipIcon size={12} /> Files</span>
        <button className="icon-btn" title="Hide" onClick={onHide}><XIcon size={13} /></button>
      </div>
      {!files.length && <div className="attention-empty muted">Drop a file on the message box: it goes into this session's directory.</div>}
      {files.map((f) => (
        <div key={f} className="file-row">
          <a className="file-name" href={media(`/api/sessions/${localId(m.id)}/file?name=${encodeURIComponent(f)}`, machine)} target="_blank" rel="noreferrer">
            <FileIcon size={13} /><span className="mono">{f}</span>
          </a>
          {machine === LOCAL && !state.web && (
            <button className="icon-btn" title="Show in its folder" onClick={() => void api('/api/fs/reveal', 'POST', { path: m.cwd + sep + f }, machine)}><FolderIcon size={13} /></button>
          )}
        </div>
      ))}
    </aside>
  )
}
