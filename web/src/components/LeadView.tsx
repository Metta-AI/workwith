// The overview: every session as a card, grouped by directory, beside a chat
// with the lead agent that can read them and route messages to them.

import { api, select, useStore } from '../store.ts'
import { fatigue } from '../util.ts'
import { Mascot, STATUS_LABEL } from './Mascot.tsx'
import { ContextGauge, SessionView } from './SessionView.tsx'
import { groupSessions, treeOf } from './Sidebar.tsx'
import { Splitter, useWidth } from './Splitter.tsx'

export function LeadView({ id }: { id: string }) {
  const st = useStore()
  const [board, setBoard] = useWidth('board', 420)
  const groups = groupSessions(st.sessions, false)
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
            <div className="board-group-head" title={cwd}>{cwd.replace(/^\/Users\/[^/]+/, '~')}</div>
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
                  <ContextGauge m={s} />
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
            <label className="toggle" title="When on, the lead's messages go straight to sessions instead of waiting in their inbox for you">
              <input type="checkbox" checked={st.settings.leadAutoSend} onChange={(e) => void api('/api/settings', 'PUT', { leadAutoSend: e.target.checked })} />
              Auto-send
            </label>
            <button title="Start the lead over with an empty context (it keeps NOTES.md)" onClick={() => { if (confirm('Give the lead a fresh start? It forgets this conversation but keeps its NOTES.md.')) { void api('/api/lead/reset') } }}>Fresh start</button>
          </>}
        />
      </section>
    </div>
  )
}
