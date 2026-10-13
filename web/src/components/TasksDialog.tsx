// Long-running commands agents started with start_task (server/tasks.ts), running
// ones first, then those that ended: each with its agent's critter and session,
// how long it ran, and its log, which follows the end while the task runs. Search
// shows the log's matching lines. Stop (two clicks) ends a running task. Ended
// ones go by themselves after a week (server/tasks.ts); the bin takes one now.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useEscape } from '../escape.ts'
import type { Task } from '../../../shared/types.ts'
import { api, select, useStore } from '../store.ts'
import { fatigue } from '../util.ts'
import { Mascot } from './Mascot.tsx'
import { CheckIcon, DashIcon, SearchIcon, TrashIcon, XIcon } from './Icons.tsx'
import { minutes, useNow } from '../cache.ts'
import { highlight } from '../highlight.ts'

const MAX = 1024 * 1024 // keep at most this much of a log on screen

const stateOf = (t: Task) => !t.ended ? 'running' : t.stopped ? 'stopped' : t.code === 0 ? 'ok' : 'failed'
const stateLabel = (t: Task) => !t.ended ? 'Running' : t.stopped ? `Stopped by ${t.stopped === 'user' ? 'you' : 'Claude'}` : t.code == null ? 'Ended' : `Exit code ${t.code}`

// Running: a pulsing dot. Ended: a check (exit 0), a cross (failed), or a dash (stopped).
function StateMark({ t }: { t: Task }) {
  const st = stateOf(t)
  if (st === 'running') return <span className="task-dot running" title="Running" />
  const Icon = st === 'ok' ? CheckIcon : st === 'failed' ? XIcon : DashIcon
  return <span className={`task-mark ${st}`} title={stateLabel(t)}><Icon size={12} /></span>
}

export function TasksDialog({ onClose, first }: { onClose(): void; first?: string }) {
  useEscape(onClose)
  const st = useStore()
  useNow(1000)
  const tasks = [...st.tasks].sort((a, b) => Number(!!a.ended) - Number(!!b.ended) || (b.ended ?? b.started) - (a.ended ?? a.started))
  const running = tasks.filter((x) => !x.ended), ended = tasks.filter((x) => x.ended)
  const [pick, setPick] = useState(first ?? tasks[0]?.id ?? null)
  const t = tasks.find((x) => x.id === pick) ?? tasks[0]
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal tasks-modal">
        <div className="tasks-head"><h2>Tasks</h2><button className="icon-btn" title="Close" onClick={onClose}><XIcon size={14} /></button></div>
        {!tasks.length ? <p className="muted">No tasks yet. An agent starts one for a dev server, a watcher or a long build.</p> : (
          <div className="tasks-body">
            <div className="tasks-list">
              {/* Running is always there, so the list does not shift as tasks start and end. */}
              {([['Running', running], ['Ended', ended]] as const).map(([name, list]) => (list.length > 0 || name === 'Running') && (
                <div key={name} className="tasks-group">
                  <div className="tasks-group-head">{name}</div>
                  {!list.length && <div className="tasks-none">No running tasks</div>}
                  {list.map((x) => {
                    const s = st.sessions.find((m) => m.id === x.sid)
                    return (
                      <button key={x.id} className={`task-row${x.id === t?.id ? ' on' : ''}`} onClick={() => setPick(x.id)}>
                        {s ? <Mascot status={s.status} look={s.look} fatigue={fatigue(s.context.used, s.context.window)} size={22} /> : <span className="task-nobody" />}
                        <span className="task-main">
                          <span className="task-title">{x.title}</span>
                          <span className="task-sub">{s?.title ?? 'Closed session'} · {minutes((x.ended ?? Date.now()) - x.started)}</span>
                        </span>
                        <StateMark t={x} />
                      </button>
                    )
                  })}
                </div>
              ))}
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
      const r = await api<{ text: string; next: number }>(`/api/tasks/${t.id}/log${size.current == null ? '' : `?from=${size.current}`}`, 'GET')
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
    const timer = setTimeout(() => void api<{ n: number; line: string }[]>(`/api/tasks/${t.id}/search?q=${encodeURIComponent(q)}`, 'GET').then(setHits), 200)
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
        <div className="task-top">
          <span className="task-meta muted">
            <StateMark t={t} /> {stateLabel(t)} · {s ? <button className="link" onClick={() => { select(s.id); onClose() }}>{s.title}</button> : 'closed session'} · <span title="Task id, in its log file name and in ps as codiner-task">task <span className="mono">{t.id}</span></span>
            {!t.ended && <> · pid {t.pid}</>}
          </span>
          {!t.ended ? (
            <button className={confirm ? 'danger' : ''} onClick={() => { if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 4000); return } void api(`/api/tasks/${t.id}/stop`, 'POST') }}>
              {confirm ? 'Stop it?' : 'Stop'}
            </button>
          ) : (
            <button className={`icon-btn${confirm ? ' danger' : ''}`} title={confirm ? 'Click again to remove' : 'Remove task and its log (ended tasks go after 7 days)'}
              onClick={() => { if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 4000); return } void api(`/api/tasks/${t.id}`, 'DELETE') }}>
              <TrashIcon size={14} />
            </button>
          )}
        </div>
        <pre className="task-cmd hljs" title={`In ${t.cwd}`} dangerouslySetInnerHTML={{ __html: highlight(t.command, 'bash') }} />
      </div>
      <div className="task-tools">
        <div className="task-search"><SearchIcon size={13} /><input placeholder="Search the log" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {hits && <span className="muted">{hits.length >= 500 ? '500+' : hits.length} {hits.length === 1 ? 'line' : 'lines'}</span>}
      </div>
      <pre ref={pre} className="task-log" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8 }}>
        {hits
          ? hits.map((h) => <div key={h.n}><span className="task-ln">{h.n}</span>{mark(h.line)}</div>)
          : log}
      </pre>
    </div>
  )
}
