// Artifacts (server/artifacts.ts) in the browser: the preview pane beside a session,
// the page that lists them all with the sessions that made them, and publishing to
// Prolifica. Artifacts run from a server on another port, so their scripts never
// share Codinger's origin.

import { useEffect, useState } from 'react'
import type { Artifact, ArtifactTouch, PreviewTarget, Visibility } from '../../../shared/artifacts.ts'
import { api, changed, revealEvent, state, useStore } from '../store.ts'
import { timeAgo } from '../util.ts'
import { OpenIcon, UndoIcon, XIcon } from './Icons.tsx'

export const ArtifactIcon = ({ size = 14 }: { size?: number }) => (
  <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 5.5h12M5 11V9M8 11V7.5M11 11V8.5" />
  </svg>
)

const SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads allow-modals'

function srcOf(target: PreviewTarget, a: Artifact | undefined, port: number, at: number): string {
  if ('url' in target) return target.url
  // The page tells the bridge which window holds it; t: a change to its files (or a show) loads it again.
  return `http://127.0.0.1:${port}/${encodeURIComponent(target.artifact)}/?app=${encodeURIComponent(location.origin)}&t=${a?.mtime ?? 0}-${at}`
}

export function ArtifactFrame({ target, at = 0, hidden }: { target: PreviewTarget; at?: number; hidden?: boolean }) {
  const st = useStore()
  const a = 'artifact' in target ? st.artifacts.find((x) => x.name === target.artifact) : undefined
  if ('artifact' in target && !st.artifactsPort) return null
  if ('artifact' in target && !a) return <div className="artifact-missing muted">There is no artifact “{target.artifact}” now.</div>
  return <iframe className={hidden ? 'artifact-check' : 'artifact-frame'} title={a?.title ?? 'Preview'} sandbox={SANDBOX} src={srcOf(target, a, st.artifactsPort, at)} aria-hidden={hidden} tabIndex={hidden ? -1 : undefined} />
}

// When an agent shows an artifact, a hidden copy loads it once, so show_artifact can
// report its script errors even when no pane shows it.
export function ArtifactCheck() {
  const st = useStore()
  const [show, setShow] = useState<{ name: string; at: number } | null>(null)
  const last = Object.values(st.preview).reduce<{ target: PreviewTarget; at: number } | null>((m, p) => !m || p.at > m.at ? p : m, null)
  useEffect(() => {
    if (!last || !('artifact' in last.target) || Date.now() - last.at > 5000) return
    setShow({ name: last.target.artifact, at: last.at })
    const t = setTimeout(() => setShow(null), 12_000)
    return () => clearTimeout(t)
  }, [last?.at])
  return show ? <ArtifactFrame key={show.at} target={{ artifact: show.name }} at={show.at} hidden /> : null
}

export function ProlificaConnect() {
  const st = useStore()
  const connect = async () => { const { url } = await api<{ url: string }>('/api/prolifica/connect'); window.open(url, '_blank') }
  if (!st.prolifica) return <button onClick={() => void connect()}>Connect Prolifica</button>
  return (
    <span className="prolifica-conn muted">
      Prolifica: {st.prolifica.handle ? `@${st.prolifica.handle}` : 'connected'}
      <button className="link" onClick={() => void api('/api/prolifica', 'DELETE')}>Disconnect</button>
    </span>
  )
}

// Publish an artifact to Prolifica: its data files, then its page. Later publishes make new versions there.
export function PublishControl({ a }: { a: Artifact }) {
  const st = useStore()
  const [open, setOpen] = useState(false)
  const [vis, setVis] = useState<Visibility>(a.published?.visibility ?? 'public')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<string[] | null>(null)
  const p = a.published
  const fresh = p && p.mtime >= a.mtime
  if (!st.prolifica) return <ProlificaConnect />
  const go = async () => {
    setBusy(true)
    try {
      const r = await api<{ madePublic: string[] }>(`/api/artifacts/${encodeURIComponent(a.name)}/publish`, 'POST', { visibility: vis, note })
      setMade(r.madePublic); setNote(''); setOpen(false)
    } finally { setBusy(false) }
  }
  return (
    <span className="publish">
      {p && <a href={p.url} target="_blank" rel="noreferrer" className="publish-link" title={`Published ${timeAgo(p.at)} (${p.visibility})`}>v{p.version}{fresh ? '' : ' · changed since'} <OpenIcon size={11} /></a>}
      <button className={fresh ? '' : 'primary'} onClick={() => setOpen(!open)}>{p ? 'Publish again' : 'Publish to Prolifica'}</button>
      {open && (
        <div className="publish-pop">
          <label>Who can see it
            <select value={vis} onChange={(e) => setVis(e.target.value as Visibility)}>
              <option value="public">Public: listed, anyone can remix</option>
              <option value="unlisted">Unlisted: anyone with the link</option>
              <option value="private">Private: only you</option>
            </select>
          </label>
          {vis !== 'private' && <div className="muted small">Its data goes up with it and is {vis === 'public' ? 'public' : 'visible to anyone with the link'} too.</div>}
          {p && <label>What changed<input value={note} placeholder="For the version history" onChange={(e) => setNote(e.target.value)} /></label>}
          <div className="publish-actions">
            <button className="link" onClick={() => setOpen(false)}>Cancel</button>
            <button className="primary" disabled={busy} onClick={() => void go()}>{busy ? 'Publishing…' : 'Publish'}</button>
          </div>
        </div>
      )}
      {made && made.length > 0 && <span className="muted small" title={made.join('\n')}>{made.length} data {made.length === 1 ? 'file is' : 'files are'} public now</span>}
    </span>
  )
}

// The preview pane beside a session: what its agent showed last, or an artifact it worked on.
export function ArtifactPane({ sid, width, onHide }: { sid: string; width: number; onHide(): void }) {
  const st = useStore()
  const mine = st.artifacts.filter((a) => a.edits.some((e) => e.sid === sid))
  const shown = st.preview[sid]
  const target: PreviewTarget | null = shown?.target ?? (mine[0] ? { artifact: mine[0].name } : null)
  const [reload, setReload] = useState(0)
  const a = target && 'artifact' in target ? st.artifacts.find((x) => x.name === target.artifact) : undefined
  const pick = (name: string) => { state.preview = { ...state.preview, [sid]: { target: { artifact: name }, at: Date.now() } }; changed() }
  const key = target ? ('url' in target ? target.url : target.artifact) : ''
  return (
    <aside className="artifact-pane" style={{ width }}>
      <div className="artifact-top">
        {target && 'url' in target
          ? <span className="artifact-url" title={target.url}>{target.url}</span>
          : <select value={a?.name ?? ''} onChange={(e) => pick(e.target.value)}>
            {!a && <option value="">No artifact</option>}
            {(a && !mine.includes(a) ? [a, ...mine] : mine).map((x) => <option key={x.name} value={x.name}>{x.title}</option>)}
          </select>}
        <button className="icon-btn" title="Load again" onClick={() => setReload(Date.now())}><UndoIcon size={13} /></button>
        {target && <a className="icon-btn" title="Open in a new tab" href={srcOf(target, a, st.artifactsPort, 0)} target="_blank" rel="noreferrer"><OpenIcon size={13} /></a>}
        <span className="grow" />
        <button className="icon-btn" title="Hide" onClick={onHide}><XIcon size={13} /></button>
      </div>
      {a && <div className="artifact-bar"><PublishControl a={a} /></div>}
      {target ? <ArtifactFrame key={key} target={target} at={Math.max(shown?.at ?? 0, reload)} /> : <div className="artifact-missing muted">Nothing to show yet.</div>}
    </aside>
  )
}

// Whether a session has anything for its preview pane.
export const hasPreview = (sid: string) => !!state.preview[sid] || state.artifacts.some((a) => a.edits.some((e) => e.sid === sid))

function TouchRow({ t, first }: { t: ArtifactTouch; first: boolean }) {
  const st = useStore()
  const s = st.sessions.find((x) => x.id === t.sid)
  return (
    <li>
      {s ? <button className="link" title="Open the session at this message" onClick={() => revealEvent(t.sid, t.seq)}>{s.title}</button> : <span className="muted">A session that is gone</span>}
      <span className="muted"> {first ? 'made it' : 'changed it'} {timeAgo(t.ts)}</span>
    </li>
  )
}

// Every artifact: what it is, which sessions made and changed it, and whether it is published.
export function ArtifactsView() {
  const st = useStore()
  const [sel, setSel] = useState<string | null>(() => localStorage.getItem('codinger.artifact'))
  const a = st.artifacts.find((x) => x.name === sel) ?? st.artifacts[0]
  const choose = (name: string) => { localStorage.setItem('codinger.artifact', name); setSel(name) }
  return (
    <div className="artifacts-view">
      <div className="artifacts-list">
        <div className="artifacts-head">
          <h1>Artifacts</h1>
          <button className="icon-btn" title="Back to the session" onClick={() => { state.page = null; changed() }}><XIcon size={14} /></button>
        </div>
        {st.prolifica && <div className="artifacts-conn"><ProlificaConnect /></div>}
        {!st.artifacts.length && <div className="muted artifacts-empty">No artifacts yet. Ask an agent to make one, for example a chart of some data.</div>}
        {st.artifacts.map((x) => {
          const sids = new Set(x.edits.map((e) => e.sid))
          return (
            <button key={x.name} className={`artifact-row${x === a ? ' active' : ''}`} onClick={() => choose(x.name)}>
              <span className="artifact-title">{x.title}</span>
              <span className="muted small">
                {timeAgo(x.mtime)}{sids.size > 0 && ` · ${sids.size} ${sids.size === 1 ? 'session' : 'sessions'}`}
                {x.published ? ` · published v${x.published.version}${x.published.mtime < x.mtime ? ', changed since' : ''}` : ' · not published'}
              </span>
              {x.error && <span className="small err">{x.error}</span>}
            </button>
          )
        })}
      </div>
      {a && (
        <div className="artifact-detail">
          <div className="artifact-detail-head">
            <div>
              <h2>{a.title}</h2>
              {a.description && <p className="muted">{a.description}</p>}
            </div>
            <PublishControl key={a.name} a={a} />
          </div>
          <ArtifactFrame key={a.name} target={{ artifact: a.name }} />
          <div className="artifact-history">
            <h3>History</h3>
            {!a.edits.length && <div className="muted small">No session has written it since Codinger began to record.</div>}
            <ul>{[...a.edits].reverse().map((t) => <TouchRow key={`${t.sid}:${t.seq}`} t={t} first={a.created?.sid === t.sid && a.created.seq === t.seq} />)}</ul>
            <div className="muted small">Folder: <code>~/.codinger/artifacts/{a.name}</code></div>
          </div>
        </div>
      )}
    </div>
  )
}
