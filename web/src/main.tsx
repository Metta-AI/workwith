import { createRoot } from 'react-dom/client'
import { useEffect } from 'react'
import { api, changed, globalId, select, start, state, useStore, currentMachine, labelOf, machineOf } from './store.ts'
import type { SessionMeta } from '../../shared/types.ts'
import { useState } from 'react'
import { Sidebar } from './components/Sidebar.tsx'
import { SessionView } from './components/SessionView.tsx'
import { Splitter, useWidth } from './components/Splitter.tsx'
import { AppearanceDialog } from './components/AppearanceDialog.tsx'
import { ArtifactCheck, ArtifactsView } from './components/Artifacts.tsx'
import { useFavicon } from './favicon.tsx'
import { MenuIcon, XIcon } from './components/Icons.tsx'
import { initTooltips } from './tooltip.ts'
import './styles.css'

function App() {
  const st = useStore()
  const [side, setSide] = useWidth('sidebar', 260)
  // The lead agent is hidden for now: only workers show.
  const sel = st.sessions.find((s) => s.id === st.selected && s.kind === 'worker')
  useEffect(() => { if (sel) select(sel.id) }, [sel?.id])

  // A tab title that says when something needs you.
  const needs = st.sessions.filter((s) => ['permission', 'asking', 'waiting'].includes(s.status)).length
  useEffect(() => { document.title = needs ? `(${needs}) Codinger` : 'Codinger' }, [needs])
  useFavicon(st.sessions, st.settings.appearance)

  // The first load asks for a colour; the welcome stays until you close it.
  const [welcome, setWelcome] = useState(false)
  useEffect(() => { if (st.loaded && !st.settings.appearance) setWelcome(true) }, [st.loaded])

  return (
    <div className={`app${st.sideOpen ? ' side-open' : ''}`}>
      <Sidebar width={side} />
      <Splitter width={side} setWidth={setSide} min={180} max={560} initial={260} />
      <main>
        {/* On a phone the sidebar covers the page; this shows it again. */}
        <button className="icon-btn side-show" aria-label="Sessions" onClick={() => { state.sideOpen = true; changed() }}><MenuIcon size={18} /></button>
        <SignIn />
        <Update />
        <Restart />
        {!st.connected && !st.sessions.length ? <div className="empty">Connecting to the Codinger server…</div>
          : st.page === 'artifacts' ? <ArtifactsView />
          : sel ? <SessionView key={sel.id} id={sel.id} />
          : <div className="empty">Pick a session.</div>}
      </main>
      <ArtifactCheck />
      {welcome && <AppearanceDialog welcome onClose={() => setWelcome(false)} />}
      {st.lightbox && <div className="lightbox" onClick={() => { state.lightbox = null; changed() }}><img src={st.lightbox} alt="" /></div>}
      {st.error && <div className="toast" onClick={() => { state.error = null; changed() }}>{st.error}</div>}
    </div>
  )
}

// An update from origin/main (server/update.ts) that waits, runs or stopped. When it
// installs, the server restarts and the page comes back by itself.
function Update() {
  const { update: u } = useStore()
  const [closed, setClosed] = useState(() => localStorage.getItem('codinger.updateClosed'))
  // The first time it asks: your answer can stand for next time too (Settings → Updates from GitHub).
  const [remember, setRemember] = useState(true)
  if (!u || u.state === 'current' || (closed === u.head && u.state !== 'updating')) return null
  const subject = u.subject.length > 90 ? u.subject.slice(0, 88) + '…' : u.subject
  const what = `A Codinger update is ready (${u.behind === 1 ? '1 new commit' : `${u.behind} new commits`}, latest: “${subject}”).`
  const close = () => { localStorage.setItem('codinger.updateClosed', u.head); setClosed(u.head) }
  const agent = () => { const m = currentMachine(); void api<SessionMeta>('/api/update/agent', 'POST', undefined, m).then((s) => select(globalId(m, s.id))) }
  if (u.state === 'offer') {
    const answer = (yes: boolean) => {
      if (remember) void api('/api/settings', 'PUT', { autoUpdate: yes ? 'always' : 'never' })
      else if (yes) void api('/api/update/now', 'POST')
      else close()
    }
    return (
      <div className="signin restart">
        <span>Codinger on GitHub has an update ({u.behind === 1 ? '1 new commit' : `${u.behind} new commits`}, latest: “{subject}”). Install it and restart?</span>
        <button className="primary" onClick={() => answer(true)}>Update</button>
        <button onClick={() => answer(false)}>Not now</button>
        <label className="update-remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember my choice</label>
      </div>
    )
  }
  return (
    <div className="signin restart">
      {u.state === 'updating' ? <span>Updating Codinger to “{subject}”…</span>
        : u.state === 'waiting' ? <>
          <span>{what} It installs when no session is working.</span>
          <button className="primary" onClick={() => void api('/api/update/now', 'POST')}>Update now</button>
        </> : <>
          <span>{u.state === 'failed' ? `The Codinger update failed: ${u.why}` : `${what} It cannot install by itself: ${u.why}`}</span>
          <button className="primary" onClick={agent}>Ask an agent to update</button>
        </>}
      {u.state !== 'updating' && <button className="link" onClick={close}>Not now</button>}
    </div>
  )
}

// The server's code changed on disk: restart it from here (it comes back by itself).
function Restart() {
  const st = useStore()
  // The × hides it until that server has newer code, or the page loads again.
  const [hidden, setHidden] = useState('')
  const key = `${currentMachine()} ${st.staleAt ?? ''}`
  // Only for working on Codinger itself (Settings turns it on).
  if (!st.restarting && !(st.stale && st.settings.selfRestart && hidden !== key)) return null
  const busy = st.sessions.filter((s) => s.status === 'working' || s.status === 'permission').length
  return (
    <div className="signin restart">
      {st.restarting ? <span>Restarting Codinger…</span> : <>
        <span>The Codinger server on {st.web || machineOf(st.selected) ? labelOf(currentMachine()) : 'this machine'} has new code on disk (an update, or a change an agent made). Restart that server to use it.{busy ? ` ${busy} ${busy === 1 ? 'session is' : 'sessions are'} working and will keep working.` : ''}</span>
        <button className="primary" onClick={() => { state.restarting = true; changed(); void api('/api/restart').catch(() => {}) }}>Restart</button>
        <button className="icon-btn banner-x" aria-label="Hide" onClick={() => setHidden(key)}><XIcon size={13} /></button>
      </>}
    </div>
  )
}

// Claude Code's login is missing or expired: sign in from here.
function SignIn() {
  const { auth } = useStore()
  const [code, setCode] = useState('')
  if (auth.state === 'ok') return null
  const submit = () => { if (code.trim()) void api('/api/login/code', 'POST', { code }).then(() => setCode('')) }
  return (
    <div className={`signin st-${auth.state}`}>
      {auth.state === 'pending' ? <>
        <span>Sign in to Claude in the browser.</span>
        {auth.url && <a href={auth.url} target="_blank" rel="noreferrer">Open the sign-in page</a>}
        <input placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
        <button disabled={!code.trim()} onClick={submit}>Submit</button>
        <button className="link" onClick={() => void api('/api/login/cancel')}>Cancel</button>
      </> : <>
        <span>{auth.state === 'failed' ? `Sign-in failed${auth.error ? `: ${auth.error}` : ''}` : 'Claude Code is signed out.'}</span>
        <button className="primary" onClick={() => void api('/api/login')}>Sign in</button>
      </>}
    </div>
  )
}

// Images in replies and sent messages are small; a click shows one full size.
document.addEventListener('click', (e) => {
  const img = (e.target as Element | null)?.closest?.('img.ri-img, .user-part .md img, .note-card.sent .md img') as HTMLImageElement | null
  if (!img || img.classList.contains('loading')) return
  e.preventDefault()
  state.lightbox = img.src
  changed()
})
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.lightbox) { state.lightbox = null; changed() } })
// No zoom on a phone: iOS Safari ignores user-scalable=no in the viewport tag, so stop the pinch here.
for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false })
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault() }, { passive: false })

void start()
initTooltips()
createRoot(document.getElementById('root')!).render(<App />)
