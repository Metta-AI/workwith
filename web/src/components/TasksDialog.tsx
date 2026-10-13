// Long-running commands agents started with start_task (server/tasks.ts): each
// with its agent's critter and session, how long it has run, and its log, which
// follows the end while the task runs. Search shows the log's matching lines.
// Stop ends a running task; Remove forgets an ended one and its log.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Task } from '../../../shared/types.ts'
import { api, select, useStore } from '../store.ts'
import { fatigue } from '../util.ts'
import { Mascot } from './Mascot.tsx'
import { SearchIcon, XIcon } from './Icons.tsx'
import { minutes, useNow } from '../cache.ts'

const MAX = 1024 * 1024 // keep at most this much of a log on screen

const stateOf = (t: Task) => !t.ended ? 'running' : t.stopped ? 'stopped' : t.code === 0 ? 'ok' : 'failed'
const stateLabel = (t: Task) => !t.ended ? 'Running' : t.stopped ? `Stopped by ${t.stopped === 'user' ? 'you' : 'Claude'}` : t.code == null ? 'Ended' : `Exit code ${t.code}`

export function TasksDialog({ onClose, first }: { onClose(): void; first?: string }) {
  const st = useStore()
  useNow(1000)
  const tasks = [...st.tasks].sort((a, b) => Number(!!a.ended) - Number(!!b.ended) || b.started - a.started)
  const [pick, setPick] = useState(first ?? tasks[0]?.id ?? null)
  const t = tasks.find((x) => x.id === pick) ?? tasks[0]
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal tasks-modal" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <div className="tasks-head"><h2>Tasks</h2><button className="icon-btn" title="Close" onClick={onClose}><XIcon size={14} /></button></div>
        {!tasks.length ? <p className="muted">No tasks yet. An agent starts one for a dev server, a watcher or a long build.</p> : (
          <div className="tasks-body">
            <div className="tasks-list">
              {tasks.map((x) => {
                const s = st.sessions.find((m) => m.id === x.sid)
                return (
                  <button key={x.id} className={`task-row${x.id === t?.id ? ' on' : ''}`} onClick={() => setPick(x.id)}>
                    {s ? <Mascot status={s.status} look={s.look} fatigue={fatigue(s.context.used, s.context.window)} size={22} /> : <span className="task-nobody" />}
                    <span className="task-main">
                      <span className="task-title">{x.title}</span>
                      <span className="task-sub">{s?.title ?? 'Closed session'} · {minutes((x.ended ?? Date.now()) - x.started)}</span>
                    </span>
                    <span className={`task-dot ${stateOf(x)}`} title={stateLabel(x)} />
                  </button>
                )
              })}
            </div>
            {t && <TaskView key={t.id} t={t} onClose={onClose} />}
          </div>
        )}
      </div>
    </div>
  )
}

function TaskView({ t, onClose }: { t: Task; onClose(): void }) {
  const st = useStore()
  const [log, setLog] = useState('')
  const size = useRef<number | null>(null) // the byte to read from next
  const pre = useRef<HTMLPreElement>(null)
  const stick = useRef(true) // follow the end until you scroll up
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<{ n: number; line: string }[] | null>(null)
  const [confirm, setConfirm] = useState(false)
  const s = st.sessions.find((m) => m.id === t.sid)

  // The log's end at first, then what is added, every second while it runs (and once more after).
  useEffect(() => {
    let stop = false
    const pull = async () => {
      const r = await api<{ text: string; next: number }>(`/api/tasks/${t.id}/log${size.current == null ? '' : `?from=${size.current}`}`)
      if (stop) return
      size.current = r.next
      if (r.text) setLog((l) => (l + r.text).slice(-MAX))
    }
    void pull()
    const timer = setInterval(() => { if (!t.ended || size.current == null) void pull() }, 1000)
    return () => { stop = true; clearInterval(timer) }
  }, [t.id, t.ended])
  useEffect(() => { const el = pre.current; if (el && stick.current) el.scrollTop = el.scrollHeight }, [log, hits])

  useEffect(() => {
    if (!q.trim()) { setHits(null); return }
    const timer = setTimeout(() => void api<{ n: number; line: string }[]>(`/api/tasks/${t.id}/search?q=${encodeURIComponent(q)}`).then(setHits), 200)
    return () => clearTimeout(timer)
  }, [q, t.id, log])
  const mark = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (line: string) => {
      if (!needle) return line
      const out: React.ReactNode[] = []
      let i = 0, low = line.toLowerCase(), at: number
      while ((at = low.indexOf(needle, i)) >= 0) { out.push(line.slice(i, at), <mark key={at}>{line.slice(at, at + needle.length)}</mark>); i = at + needle.length }
      out.push(line.slice(i))
      return out
    }
  }, [q])

  return (
    <div className="task-view">
      <div className="task-info">
        <div className="task-cmd mono" title={t.cwd}>$ {t.command}</div>
        <div className="task-meta muted">
          {stateLabel(t)} · {s ? <button className="link" onClick={() => { select(s.id); onClose() }}>{s.title}</button> : 'closed session'} · <span className="mono">{t.id}</span>
          {!t.ended && <> · pid {t.pid}</>}
        </div>
      </div>
      <div className="task-tools">
        <label className="task-search"><SearchIcon size={13} /><input placeholder="Search the log" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        {hits && <span className="muted">{hits.length >= 500 ? '500+' : hits.length} {hits.length === 1 ? 'line' : 'lines'}</span>}
        {!t.ended && (
          <button className={confirm ? 'danger' : ''} onClick={() => { if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 4000); return } void api(`/api/tasks/${t.id}/stop`, 'POST') }}>
            {confirm ? 'Stop it?' : 'Stop'}
          </button>
        )}
        {t.ended && <button onClick={() => void api(`/api/tasks/${t.id}`, 'DELETE')} title="Forget this task and delete its log">Remove</button>}
      </div>
      <pre ref={pre} className="task-log" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8 }}>
        {hits
          ? hits.map((h) => <div key={h.n}><span className="task-ln">{h.n}</span>{mark(h.line)}</div>)
          : log}
      </pre>
    </div>
  )
}
