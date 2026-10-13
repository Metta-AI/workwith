// The overview: every session as a card, grouped by directory, beside a chat
// with the lead agent that can read them and route messages to them.

import { useState } from 'react'
import { api, select, useStore } from '../store.ts'
import { fatigue } from '../util.ts'
import { Mascot, STATUS_LABEL } from './Mascot.tsx'
import { CachePill, ContextGauge, SessionView } from './SessionView.tsx'
import { groupSessions, treeOf } from './Sidebar.tsx'
import { Splitter, useWidth } from './Splitter.tsx'
import { shortPath } from './DirPicker.tsx'

export function LeadView({ id }: { id: string }) {
  const st = useStore()
  const [board, setBoard] = useWidth('board', 420)
  const groups = groupSessions(st.sessions, false, st.settings.groupOrder)
  const drafts = st.sessions.filter((s) => s.kind === 'worker' && !s.archived).reduce((n, s) => n + s.inbox.length, 0)
  const [sentNote, setSentNote] = useState<{ text: string; title: string } | null>(null)
  const sendDrafts = async () => {
    const r = await api<{ sent: string[]; held: { id: string; title: string; why: string[] }[] }>('/api/lead/send-drafts')
    setSentNote({
      text: `Sent to ${r.sent.length}${r.held.length ? `, ${r.held.length} held` : ''}`,
      title: r.held.map((h) => `${h.title}: ${h.why.join('; ')}`).join('\n'),
    })
    setTimeout(() => setSentNote(null), 8000)
  }
  const needsYou = st.sessions.filter((s) => s.kind === 'worker' && !s.archived && ['permission', 'asking', 'waiting', 'error'].includes(s.status))

  return (
    <div className="lead">
      <section className="board" style={{ width: board }}>
        <div className="board-head">
          <h2>Sessions</h2>
          {needsYou.length > 0 && <span className="muted">{needsYou.length} waiting on you</span>}
        </div>
        {groups.map(([cwd, list]) => (
          <div key={cwd} className="board-group">
            <div className="board-group-head" title={cwd}>{shortPath(cwd)}</div>
            <div className="cards">
              {treeOf(list).map(({ s, depth }) => (
                <button key={s.id} className={`card st-${s.status}`} style={{ marginLeft: depth * 18 }} onClick={() => select(s.id)}>
                  <div className="card-top">
                    <Mascot status={s.status} look={s.look} fatigue={fatigue(s.context.used, s.context.window)} size={34} />
                    <div>
                      <div className="card-title">{s.title}</div>
                      <div className={`status-pill st-${s.status}`}>{s.compacting ? 'compacting' : STATUS_LABEL[s.status]}{s.pendingAsks ? ` · ${s.pendingAsks}?` : ''}</div>
                    </div>
                    {s.inbox.length > 0 && <span className="count" title="Drafts from the lead">{s.inbox.length}</span>}
                  </div>
                  {s.lastText && <div className="card-text">{s.lastText.slice(-220)}</div>}
                  <div className="card-gauges"><ContextGauge m={s} /><CachePill m={s} /></div>
                </button>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <div className="empty">No sessions yet. Start one from the sidebar, or ask the lead to spawn one.</div>}
      </section>
      <Splitter width={board} setWidth={setBoard} min={240} max={1000} initial={420} />
      <section className="lead-chat">
        <SessionView
          id={id}
          extra={<>
            {drafts > 0 && <button title="Send drafts to sessions that are idle, with no open questions or unsent reply" onClick={() => void sendDrafts()}>Send {drafts} {drafts === 1 ? 'draft' : 'drafts'}</button>}
            {sentNote && <span className="muted" title={sentNote.title}>{sentNote.text}</span>}
            <label className="toggle" title="Send each draft when its session is idle, with no open questions or unsent reply">
              <input type="checkbox" checked={st.settings.leadAutoSend} onChange={(e) => void api('/api/settings', 'PUT', { leadAutoSend: e.target.checked })} />
              Auto-send
            </label>
            <button title="Clear the lead's context (keeps LEAD_NOTES.md)" onClick={() => { if (confirm('Give the lead a fresh start? It forgets this conversation but keeps its LEAD_NOTES.md.')) { void api('/api/lead/reset') } }}>Fresh start</button>
          </>}
        />
      </section>
    </div>
  )
}
