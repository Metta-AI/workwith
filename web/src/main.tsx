import { createRoot } from 'react-dom/client'
import { useEffect } from 'react'
import { changed, connect, select, state, useStore } from './store.ts'
import { Sidebar } from './components/Sidebar.tsx'
import { SessionView } from './components/SessionView.tsx'
import { MasterView } from './components/MasterView.tsx'
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
        {!st.connected && !st.sessions.length ? <div className="empty">Connecting to the Codiner server…</div>
          : sel?.kind === 'master' ? <MasterView id={sel.id} />
          : sel ? <SessionView key={sel.id} id={sel.id} />
          : <div className="empty">Pick a session.</div>}
      </main>
      {st.error && <div className="toast" onClick={() => { state.error = null; changed() }}>{st.error}</div>}
    </div>
  )
}

connect()
createRoot(document.getElementById('root')!).render(<App />)
