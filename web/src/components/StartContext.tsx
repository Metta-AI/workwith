// Settings → Start-up context: what every new session in a folder starts with,
// by category (Claude Code's /context, GET /api/context), and how big the first
// call of new sessions there really was (SessionMeta.base).

import { useEffect, useState } from 'react'
import { api, useStore } from '../store.ts'
import { kTokens, renderMd } from '../util.ts'
import { shortPath } from './DirPicker.tsx'

export function StartContext() {
  const st = useStore()
  const dirs = [...new Map(st.sessions.filter((s) => s.kind === 'worker').sort((a, b) => b.lastActivity - a.lastActivity).map((s) => [s.cwd, s.cwd])).keys()]
  const current = st.sessions.find((s) => s.id === st.selected)
  const [cwd, setCwd] = useState(() => current?.kind === 'worker' ? current.cwd : dirs[0] ?? '~')
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async (fresh = false) => {
    setBusy(true); setErr(null)
    try { setText((await api<{ text: string }>(`/api/context?cwd=${encodeURIComponent(cwd)}${fresh ? '&fresh=1' : ''}`, 'GET')).text) }
    catch (e) { setText(null); setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [cwd])
  // What the first call of new sessions in this folder measured.
  const bases = st.sessions.filter((s) => s.cwd === cwd && s.base).map((s) => s.base!).sort((a, b) => a.total - b.total)
  const base = bases[Math.floor(bases.length / 2)]
  return (
    <div className="start-context">
      <p className="muted">
        Every new session sends this before your first message: Claude Code's system prompt and tools, Codiner's
        instructions and tools, your MCP servers, memory files and skills. Much of it is the same in every session, so
        it is usually read from the cache, which costs less than a fresh send. These are Claude Code's own estimates.
      </p>
      <label className="settings-check">
        Folder
        <select value={cwd} onChange={(e) => setCwd(e.target.value)}>
          {[...new Set([cwd, ...dirs])].map((d) => <option key={d} value={d}>{shortPath(d)}</option>)}
        </select>
        <button className="link" disabled={busy} onClick={() => void load(true)}>{busy ? 'Measuring…' : 'Measure again'}</button>
      </label>
      {base && <p>
        The first call of new sessions here was about <b>{kTokens(base.total)} tokens</b>, and {kTokens(base.read)} of
        it was already in the cache. That is more than the total below, because the first message also carries reminders
        that Claude Code adds to it (the date, the git status, the names of deferred tools).
      </p>}
      {err && <div className="notice error">{err}</div>}
      {text && <div className="md-block start-context-body" dangerouslySetInnerHTML={{ __html: renderMd(text) }} />}
    </div>
  )
}
