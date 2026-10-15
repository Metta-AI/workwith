// A published transcript (shared/share.ts), read-only: at web.codinger.app/s/<id>, and in
// Codinger before it goes (?preview=<session>&base=<its machine's path>&tools=…), where it
// comes from the session's own server and shows its files from there.

import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import type { Share, SharePreview } from '../../shared/share.ts'
import type { SessionMeta } from '../../shared/types.ts'
import { changed, state } from './store.ts'
import { Transcript } from './components/Transcript.tsx'
import { initTooltips } from './tooltip.ts'
import './styles.css'

const SID = 'share'
const q = new URLSearchParams(location.search)
const preview = q.get('preview')
// Only a path on this site: Codinger's own server, or a machine through web.codinger.app.
const base = /^(\/m\/[a-z0-9-]{1,40}|\/api\/remote\/m\/[a-z0-9-]{1,40})?$/.test(q.get('base') ?? '') ? q.get('base') ?? '' : ''
const id = /^\/s\/([A-Za-z0-9]{16})/.exec(location.pathname)?.[1]

async function load(): Promise<Share> {
  const opts = new URLSearchParams({ tools: q.get('tools') ?? 'line', thinking: q.get('thinking') ?? '0', redact: q.get('redact') ?? '1' })
  const r = await fetch(preview ? `${base}/api/sessions/${encodeURIComponent(preview)}/share?${opts}` : `/s/${id}/share.json`)
  if (!r.ok) throw new Error(r.status === 404 ? 'There is no transcript here. Its owner may have taken it down.' : `The transcript did not load (${r.status}).`)
  return preview ? ((await r.json()) as SharePreview).share : await r.json() as Share
}

function show(share: Share) {
  const meta = { id: SID, kind: 'worker', title: share.title, cwd: '~', status: 'idle', parentId: null, archived: false } as SessionMeta
  state.machines = { '': { name: '', connected: true, loaded: true, sessions: [meta], settings: { leadAutoSend: false }, usage: {}, tasks: [], platform: '', home: '', auth: { state: 'ok' }, stale: false } }
  state.selected = SID
  state.events = { [SID]: share.events }
  state.share = { tools: share.opts.tools, file: (url) => preview ? base + url : `/s/${id}/f/${url.split('/').pop()}` }
  // The owner's colours and font; light or dark as the reader's system is.
  const r = document.documentElement
  for (const k of ['accent', 'surface', 'font'] as const) if (share[k] && share[k] !== 'custom') r.dataset[k] = share[k]
  document.title = `${share.title} · Codinger`
  changed()
}

function Page() {
  const [share, setShare] = useState<Share | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { load().then((s) => { show(s); setShare(s) }, (e: Error) => setError(e.message)) }, [])
  if (error) return <div className="empty">{error}</div>
  if (!share) return <div className="empty">Loading…</div>
  const when = new Date(share.at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  return (
    <div className="share-page">
      <header className="share-head">
        <h1>{share.title}</h1>
        <span className="muted">{preview ? 'Preview: what readers will see' : <>A conversation with an agent in <a href="https://codinger.app" target="_blank" rel="noreferrer">Codinger</a>, through Claude Code · {when}</>}</span>
      </header>
      <Transcript sid={SID} />
    </div>
  )
}

initTooltips()
createRoot(document.getElementById('root')!).render(<Page />)
