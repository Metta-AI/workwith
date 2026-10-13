import { createRoot } from 'react-dom/client'
import { useEffect } from 'react'
import { api, changed, connect, select, state, useStore } from './store.ts'
import { useState } from 'react'
import { Sidebar } from './components/Sidebar.tsx'
import { SessionView } from './components/SessionView.tsx'
import { LeadView } from './components/LeadView.tsx'
import { Splitter, useWidth } from './components/Splitter.tsx'
import './styles.css'

function App() {
  const st = useStore()
  const [side, setSide] = useWidth('sidebar', 260)
  const sel = st.sessions.find((s) => s.id === st.selected)
  useEffect(() => { if (sel) select(sel.id) }, [sel?.id])

  // A tab title that says when something needs you.
  const needs = st.sessions.filter((s) => ['permission', 'asking', 'waiting'].includes(s.status)).length
  useEffect(() => { document.title = needs ? `(${needs}) Codiner` : 'Codiner' }, [needs])

  return (
    <div className="app">
      <Sidebar width={side} />
      <Splitter width={side} setWidth={setSide} min={180} max={560} initial={260} />
      <main>
        <SignIn />
        <Restart />
        {!st.connected && !st.sessions.length ? <div className="empty">Connecting to the Codiner server…</div>
          : sel?.kind === 'lead' ? <LeadView id={sel.id} />
          : sel ? <SessionView key={sel.id} id={sel.id} />
          : <div className="empty">Pick a session.</div>}
      </main>
      {st.lightbox && <div className="lightbox" onClick={() => { state.lightbox = null; changed() }}><img src={st.lightbox} alt="" /></div>}
      {st.error && <div className="toast" onClick={() => { state.error = null; changed() }}>{st.error}</div>}
    </div>
  )
}

// The server's code changed on disk: restart it from here (it comes back by itself).
function Restart() {
  const st = useStore()
  if (!st.stale && !st.restarting) return null
  const busy = st.sessions.filter((s) => s.status === 'working' || s.status === 'permission').length
  return (
    <div className="signin restart">
      {st.restarting ? <span>Restarting Codiner…</span> : <>
        <span>Codiner's server code has changed. Restart to use it.{busy ? ` ${busy} ${busy === 1 ? 'session is' : 'sessions are'} working and will stop.` : ''}</span>
        <button className="primary" onClick={() => { state.restarting = true; changed(); void api('/api/restart').catch(() => {}) }}>Restart</button>
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

connect()
createRoot(document.getElementById('root')!).render(<App />)
