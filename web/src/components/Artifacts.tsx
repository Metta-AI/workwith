// Artifacts (server/artifacts.ts) in the browser: the preview pane beside a session,
// the line each show_artifact call leaves in the conversation, the page that lists them
// all with the sessions that made them, and publishing to Prolifica. Artifacts run from
// a server on another port, so their scripts never share Codinger's origin.

import { useEffect, useRef, useState } from 'react'
import type { Artifact, ArtifactTouch, PreviewTarget, Visibility } from '../../../shared/artifacts.ts'
import type { Block, Event } from '../../../shared/types.ts'
import { api, changed, revealEvent, state, useStore } from '../store.ts'
import { timeAgo } from '../util.ts'
import { ChevronIcon, OpenIcon, XIcon } from './Icons.tsx'

const Svg = ({ size = 14, children }: { size?: number; children: React.ReactNode }) => (
  <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
)
export const ArtifactIcon = ({ size }: { size?: number }) => <Svg size={size}><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 5.5h12M5 11V9M8 11V7.5M11 11V8.5" /></Svg>
const RefreshIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M13 8a5 5 0 11-1.5-3.6" /><path d="M13 2.5v3h-3" /></Svg>
const WideIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" /></Svg>
const NarrowIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M13 6.5H9.5V3M3 9.5h3.5V13M9.5 6.5L14 2M6.5 9.5L2 14" /></Svg>

export const SHOW_ARTIFACT = 'mcp__codinger__show_artifact'
const SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads allow-modals'

function srcOf(target: PreviewTarget, a: Artifact | undefined, port: number, at: number): string {
  if ('url' in target) return target.url
  const v = target.v != null && target.v !== a?.latest ? `@${target.v}` : ''
  // The page tells the bridge which window holds it; t: a change to its files (or a show) loads it again.
  return `http://127.0.0.1:${port}/${encodeURIComponent(target.artifact)}${v}/?app=${encodeURIComponent(location.origin)}&t=${v ? 0 : a?.mtime ?? 0}-${at}`
}

const showIn = (sid: string, target: PreviewTarget) => { state.preview = { ...state.preview, [sid]: { target, at: Date.now() } }; changed() }

// No title attribute: the browser shows it as a tooltip over the whole page.
export function ArtifactFrame({ target, at = 0, hidden }: { target: PreviewTarget; at?: number; hidden?: boolean }) {
  const st = useStore()
  const a = 'artifact' in target ? st.artifacts.find((x) => x.name === target.artifact) : undefined
  if ('artifact' in target && !st.artifactsPort) return null
  if ('artifact' in target && !a) return <div className="artifact-missing muted">There is no artifact “{target.artifact}” now.</div>
  return <iframe className={hidden ? 'artifact-check' : 'artifact-frame'} aria-label={a?.title ?? 'Preview'} sandbox={SANDBOX} src={srcOf(target, a, st.artifactsPort, at)} aria-hidden={hidden} tabIndex={hidden ? -1 : undefined} />
}

// When an agent shows an artifact, a hidden copy loads it once, so show_artifact can
// report its script errors even when no pane shows it.
export function ArtifactCheck() {
  const st = useStore()
  const [show, setShow] = useState<{ name: string; at: number } | null>(null)
  const last = Object.values(st.preview).reduce<{ target: PreviewTarget; at: number } | null>((m, p) => !m || p.at > m.at ? p : m, null)
  useEffect(() => {
    if (!last || !('artifact' in last.target) || last.target.v != null || Date.now() - last.at > 5000) return
    setShow({ name: last.target.artifact, at: last.at })
    const t = setTimeout(() => setShow(null), 12_000)
    return () => clearTimeout(t)
  }, [last?.at])
  return show ? <ArtifactFrame key={show.at} target={{ artifact: show.name }} at={show.at} hidden /> : null
}

// The line a show_artifact call leaves in the conversation: which artifact, which version. A click shows that version.
export function ArtifactLine({ sid, b, result }: { sid: string; b: Extract<Block, { type: 'tool_use' }>; result?: Extract<Event, { t: 'tool_result' }> }) {
  const st = useStore()
  const url = typeof b.input?.url === 'string' ? b.input.url : null
  const name = String(b.input?.name ?? '')
  const a = st.artifacts.find((x) => x.name === name)
  const t = a?.edits.find((e) => e.tool === b.id)
  const first = a?.edits.find((e) => e.show) === t && !!t
  const failed = !!result && (result.isError || !result.text.startsWith('Shown'))
  const open = () => showIn(sid, url ? { url } : { artifact: name, v: t?.v })
  return (
    <div className={`tool codinger-line artifact-line${failed ? ' err' : ''}${result ? '' : ' running'}`}>
      <button className="tool-line" onClick={open} title={failed ? result!.text : 'Show it in the preview pane'}>
        <span className="tool-icon"><ArtifactIcon size={13} /></span>
        <span className="tool-name">{url ? 'Preview' : first ? 'New artifact' : 'Artifact'}</span>
        <span className="tool-sum">
          {url ?? a?.title ?? name}
          {t?.v != null && <span className="muted"> · version {t.v}{t.v === a?.latest ? ' (latest)' : ''}</span>}
          {failed && <span> · {result!.text.split('\n')[0]}</span>}
        </span>
      </button>
    </div>
  )
}

// Publish an artifact to Prolifica: its data files, then its page. Later publishes make new
// versions there. The first press connects Codinger to Prolifica (one approval in the browser).
export function PublishControl({ a }: { a: Artifact }) {
  const st = useStore()
  const [open, setOpen] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [vis, setVis] = useState<Visibility>(a.published?.visibility ?? 'public')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<string[] | null>(null)
  // Back from approving: go on to publishing.
  useEffect(() => { if (waiting && st.prolifica) { setWaiting(false); setOpen(true) } }, [waiting, !!st.prolifica])
  const p = a.published
  const fresh = p && p.mtime >= a.mtime
  const press = async () => {
    if (st.prolifica) return setOpen(!open)
    const { url } = await api<{ url: string }>('/api/prolifica/connect')
    setWaiting(true)
    window.open(url, '_blank')
  }
  const go = async () => {
    setBusy(true)
    try {
      const r = await api<{ madePublic: string[] }>(`/api/artifacts/${encodeURIComponent(a.name)}/publish`, 'POST', { visibility: vis, note })
      setMade(r.madePublic); setNote(''); setOpen(false)
    } finally { setBusy(false) }
  }
  return (
    <span className="publish">
      {p && <a href={p.url} target="_blank" rel="noreferrer" className="publish-link" data-tip={`Published ${timeAgo(p.at)} (${p.visibility})${fresh ? '' : '. It changed since.'}`}>v{p.version}{fresh ? '' : '*'} <OpenIcon size={11} /></a>}
      <button className="publish-btn" onClick={() => void press()} data-tip={st.prolifica ? 'Publish to Prolifica' : 'Publish to Prolifica (connects Codinger to it first)'}>{waiting ? 'Approve in the browser…' : 'Publish'}</button>
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
          <div className="publish-foot">
            <span className="muted small">{st.prolifica?.handle ? `As @${st.prolifica.handle}` : ''}</span>
            <button className="link" onClick={() => setOpen(false)}>Cancel</button>
            <button className="primary" disabled={busy} onClick={() => void go()}>{busy ? 'Publishing…' : 'Publish'}</button>
          </div>
        </div>
      )}
      {made && made.length > 0 && <span className="muted small" title={made.join('\n')}>{made.length} data {made.length === 1 ? 'file is' : 'files are'} public now</span>}
    </span>
  )
}

// A small menu in place of a native select: the current choice on a button, the choices below it.
type Choice<T> = { value: T; label: string; sub?: string }
function Picker<T>({ value, choices, onPick, label, className }: { value: T; choices: Choice<T>[]; onPick(v: T): void; label: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])
  const cur = choices.find((c) => c.value === value)
  return (
    <div className={`menu-wrap picker${className ? ' ' + className : ''}`} ref={box}>
      <button className={`picker-btn${open ? ' on' : ''}`} aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="picker-label">{cur?.label ?? label}</span><ChevronIcon size={11} className="picker-caret" />
      </button>
      {open && (
        <div className="menu picker-menu" role="listbox">
          {choices.map((c, i) => (
            <button key={i} role="option" aria-selected={c.value === value} className={c.value === value ? 'on' : ''} onClick={() => { setOpen(false); onPick(c.value) }}>
              <span>{c.label}</span>{c.sub && <span className="picker-sub">{c.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Which version shows: the latest (the artifact as it is now) or any one kept, newest first,
// each with when and which session left it.
function VersionPicker({ a, v, onPick }: { a: Artifact; v?: number; onPick(v?: number): void }) {
  const st = useStore()
  if (!a.versions?.length) return null
  const who = (n: number) => { const t = a.edits.find((e) => e.v === n); return t && st.sessions.find((x) => x.id === t.sid)?.title }
  const choices = [...a.versions].reverse().map((x) => ({
    value: x.n === a.latest ? 0 : x.n,
    label: x.n === a.latest ? `Latest · v${x.n}` : `Version ${x.n}`,
    sub: [timeAgo(x.at), who(x.n)].filter(Boolean).join(' · '),
  }))
  return <Picker label="Version" className="version-picker" value={v != null && v !== a.latest ? v : 0} choices={choices} onPick={(n) => onPick(n || undefined)} />
}

// An old version is showing: say so, with the way back to the artifact as it is now.
function VersionBar({ a, v, onLatest }: { a: Artifact; v: number; onLatest(): void }) {
  if (v === a.latest) return null
  return <div className="artifact-version">Version {v} of {a.latest}<button className="link" onClick={onLatest}>Show the latest</button></div>
}

// The preview pane beside a session: what its agent showed last, or an artifact it worked on.
// wide: it takes the conversation's place too.
export function ArtifactPane({ sid, width, wide, onWide, onHide }: { sid: string; width: number; wide: boolean; onWide(): void; onHide(): void }) {
  const st = useStore()
  const mine = st.artifacts.filter((a) => a.edits.some((e) => e.sid === sid))
  const shown = st.preview[sid]
  const target: PreviewTarget | null = shown?.target ?? (mine[0] ? { artifact: mine[0].name } : null)
  const [reload, setReload] = useState(0)
  const a = target && 'artifact' in target ? st.artifacts.find((x) => x.name === target.artifact) : undefined
  const v = target && 'artifact' in target ? target.v : undefined
  const key = target ? ('url' in target ? target.url : `${target.artifact}@${v ?? ''}`) : ''
  return (
    <aside className={`artifact-pane${wide ? ' wide' : ''}`} style={wide ? undefined : { width }}>
      <div className="artifact-top">
        {target && 'url' in target
          ? <span className="artifact-url" title={target.url}>{target.url}</span>
          : <Picker label="Artifact" className="artifact-picker" value={a?.name ?? ''} onPick={(name) => showIn(sid, { artifact: name })}
            choices={(a && !mine.includes(a) ? [a, ...mine] : mine).map((x) => ({ value: x.name, label: x.title, sub: timeAgo(x.mtime) }))} />}
        {a && <VersionPicker a={a} v={v} onPick={(n) => showIn(sid, { artifact: a.name, v: n })} />}
        <button className="icon-btn" data-tip="Load again" onClick={() => setReload(Date.now())}><RefreshIcon size={14} /></button>
        {target && <a className="icon-btn" data-tip="Open in a new tab" href={srcOf(target, a, st.artifactsPort, 0)} target="_blank" rel="noreferrer"><OpenIcon size={14} /></a>}
        <button className="icon-btn" data-tip={wide ? 'Show the conversation' : 'Use the full width'} onClick={onWide}>{wide ? <NarrowIcon size={14} /> : <WideIcon size={14} />}</button>
        <span className="grow" />
        {a && <PublishControl a={a} />}
        <button className="icon-btn" data-tip="Hide" onClick={onHide}><XIcon size={13} /></button>
      </div>
      {a && v != null && <VersionBar a={a} v={v} onLatest={() => showIn(sid, { artifact: a.name })} />}
      {target ? <ArtifactFrame key={key} target={target} at={Math.max(shown?.at ?? 0, reload)} /> : <div className="artifact-missing muted">Nothing to show yet.</div>}
    </aside>
  )
}

// Whether a session has anything for its preview pane.
export const hasPreview = (sid: string) => !!state.preview[sid] || state.artifacts.some((a) => a.edits.some((e) => e.sid === sid))

function TouchRow({ a, t, on, onShow }: { a: Artifact; t: ArtifactTouch; on: boolean; onShow(): void }) {
  const st = useStore()
  const s = st.sessions.find((x) => x.id === t.sid)
  const verb = a.created === t || (a.created?.sid === t.sid && a.created.seq === t.seq && a.created.tool === t.tool) ? 'made it' : t.show ? 'showed it' : 'changed it'
  return (
    <li className={on ? 'on' : ''}>
      {t.v != null ? <button className="link version" onClick={onShow}>Version {t.v}</button> : <span className="muted version">Before versions</span>}
      <span className="muted"> {s ? <button className="link" data-tip="Open the session at this message" onClick={() => revealEvent(t.sid, t.seq)}>{s.title}</button> : 'a session that is gone'} {verb} {timeAgo(t.ts)}</span>
    </li>
  )
}

// Every artifact: what it is, which sessions made and changed it, and whether it is published.
export function ArtifactsView() {
  const st = useStore()
  const [sel, setSel] = useState<string | null>(() => localStorage.getItem('codinger.artifact'))
  const [v, setV] = useState<number | undefined>()
  const a = st.artifacts.find((x) => x.name === sel) ?? st.artifacts[0]
  const choose = (name: string) => { localStorage.setItem('codinger.artifact', name); setSel(name); setV(undefined) }
  // One line for each version, at the call that left it.
  const touches = a ? [...a.edits].reverse().filter((t, i, all) => t.v == null || all.findIndex((x) => x.v === t.v) === i) : []
  return (
    <div className="artifacts-view">
      <div className="artifacts-list">
        <div className="artifacts-head">
          <h1>Artifacts</h1>
          <button className="icon-btn" data-tip="Back to the session" onClick={() => { state.page = null; changed() }}><XIcon size={14} /></button>
        </div>
        {st.prolifica && (
          <div className="artifacts-conn muted small">
            Prolifica: {st.prolifica.handle ? `@${st.prolifica.handle}` : 'connected'}
            <button className="link" onClick={() => void api('/api/prolifica', 'DELETE')}>Disconnect</button>
          </div>
        )}
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
            <span className="artifact-detail-actions">
              <VersionPicker a={a} v={v} onPick={setV} />
              <PublishControl key={a.name} a={a} />
            </span>
          </div>
          {v != null && <VersionBar a={a} v={v} onLatest={() => setV(undefined)} />}
          <ArtifactFrame key={`${a.name}@${v ?? ''}`} target={{ artifact: a.name, v }} />
          <div className="artifact-history">
            <h3>History</h3>
            {!touches.length && <div className="muted small">No session has written it since Codinger began to record.</div>}
            <ul>{touches.map((t) => <TouchRow key={`${t.sid}:${t.seq}:${t.tool ?? ''}`} a={a} t={t} on={t.v != null && t.v === (v ?? a.latest)} onShow={() => setV(t.v === a.latest ? undefined : t.v)} />)}</ul>
            <div className="muted small">Folder: <code>~/.codinger/artifacts/{a.name}</code></div>
          </div>
        </div>
      )}
    </div>
  )
}
