// A session's rolling notes (server/notes.ts): a chip by the cache chip, and a
// dialog with the notes, how keep-warm stands, and a new session from the notes.

import { useEffect, useState } from 'react'
import { useEscape } from '../escape.ts'
import type { SessionMeta } from '../../../shared/types.ts'
import { api, select, setComposer, useStore } from '../store.ts'
import { kTokens, renderMd, timeAgo } from '../util.ts'
import { moneyLong, usd } from '../cache.ts'
import { KEEP_WARM } from '../../../shared/notes.ts'
import { XIcon } from './Icons.tsx'
import { shortPath } from './DirPicker.tsx'

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// How keep-warm stands for this session, in one sentence.
function keepWarm(m: SessionMeta): string {
  const n = m.notes ?? {}
  if (n.off) return `Keep-warm is off for this session: ${n.off}.`
  if (n.running === 'ping') return 'A keep-warm call is running.'
  if (n.end) return `Keep-warm stopped: ${n.end.reason}. The cache ${n.end.at > Date.now() ? 'expires' : 'expired'} at ${clock(n.end.at)}.`
  if (!n.calls) return 'Keep-warm starts when the session is quiet.'
  const share = n.spent ? `, about ${moneyLong(n.spent)}` : ''
  return `Keep-warm is on: ${n.calls} ${n.calls === 1 ? 'call' : 'calls'} since the session went quiet${share}.`
}

// Past this size, a new session from the notes is usually the better way on.
const big = (m: SessionMeta, max: number) => m.context.used >= max
  ? `The context is over ${kTokens(max)} tokens: slow and costly, even with a warm cache. A new session from the notes may be better.` : null

export function NotesPill({ m }: { m: SessionMeta }) {
  const [open, setOpen] = useState(false)
  const st = useStore()
  if (m.kind !== 'worker' || !m.started) return null
  const n = m.notes ?? {}
  const warn = big(m, st.settings.keepWarmMax ?? KEEP_WARM.max)
  const label = n.running === 'notes' ? 'Writing notes…' : n.at ? `Notes ${clock(n.at)}` : 'Notes'
  return <>
    <button className={`notes-pill${n.off ? ' off' : warn ? ' big' : ''}${n.running ? ' busy' : ''}`} data-tip={[warn, keepWarm(m)].filter(Boolean).join(' ')} onClick={() => setOpen(true)}>{label}</button>
    {open && <NotesDialog m={m} onClose={() => setOpen(false)} />}
  </>
}

function NotesDialog({ m, onClose }: { m: SessionMeta; onClose: () => void }) {
  useEscape(onClose)
  const st = useStore()
  const [notes, setNotes] = useState<{ path: string; text: string | null } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const n = m.notes ?? {}
  useEffect(() => { void api<{ path: string; text: string | null }>(`/api/sessions/${m.id}/notes`, 'GET').then(setNotes).catch((e) => setErr(String(e.message ?? e))) }, [m.id, n.at])
  const update = async () => {
    setErr(null)
    try { await api(`/api/sessions/${m.id}/notes`) } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/expired/.test(msg)) return setErr(msg)
      if (!confirm(`The prompt cache has expired or is about to. Writing notes now writes all ${kTokens(m.context.used)} tokens to the cache again. Write them anyway?`)) return
      try { await api(`/api/sessions/${m.id}/notes`, 'POST', { force: true }) } catch (e2) { setErr(e2 instanceof Error ? e2.message : String(e2)) }
    }
  }
  const fresh = async () => {
    setBusy(true)
    try {
      const r = await api<{ meta: SessionMeta; text: string }>(`/api/sessions/${m.id}/notes/continue`)
      setComposer(r.meta.id, { text: r.text })
      select(r.meta.id)
      onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal wide notes-modal">
        <div className="files-head">
          <h2>Notes</h2>
          <button className="icon-btn" title="Close" onClick={onClose}><XIcon size={14} /></button>
        </div>
        <div className="muted notes-status">
          {notes && <div className="mono">{shortPath(notes.path)}</div>}
          <div>{n.running === 'notes' ? 'Writing the notes now.' : n.at ? `Written ${timeAgo(n.at)}.` : 'No notes yet. They are written when the session has been quiet for 20 minutes.'}</div>
          <div>
            {keepWarm(m)}
            {n.off && <> <button className="link" onClick={() => void api(`/api/sessions/${m.id}/notes/keep-warm`)}>Turn on again</button></>}
          </div>
          {m.spend && <div>
            This session has cost {usd(m.spend.usd)} at API prices since {new Date(m.spend.since).toLocaleDateString()}, each call priced when it was made. It can cover more than one 5-hour window, so it shows only in dollars.
          </div>}
          {big(m, st.settings.keepWarmMax ?? KEEP_WARM.max) && <div className="warn-text">{big(m, st.settings.keepWarmMax ?? KEEP_WARM.max)}</div>}
        </div>
        {err && <div className="notice error">{err}</div>}
        {notes?.text
          ? <div className="md-block notes-body" dangerouslySetInnerHTML={{ __html: renderMd(notes.text) }} />
          : null}
        <div className="modal-actions">
          <button disabled={!!n.running || m.status === 'working'} onClick={() => void update()}>{n.running === 'notes' ? 'Writing…' : 'Update notes now'}</button>
          <button className="primary" disabled={!notes?.text || busy} onClick={() => void fresh()} title="Same folder; its first message points to these notes">New session from notes</button>
        </div>
      </div>
    </div>
  )
}
