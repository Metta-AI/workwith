import { useEffect, useRef, useState } from 'react'
import type { Part, PermissionMode, SessionMeta, SlashCommand } from '../../../shared/types.ts'
import { agentName, api, closeSession, composerOf, draftsOf, hasContent, holdQueued, loadEvents, queuedParts, select, sendQueued, setComposer, state, undismissItem, useStore } from '../store.ts'
import { fatigue, kTokens } from '../util.ts'
import { Mascot, STATUS_LABEL } from './Mascot.tsx'
import { RichInput } from './Inputs.tsx'
import { Transcript } from './Transcript.tsx'
import { AttentionPanel } from './AttentionPanel.tsx'
import { revealItem, useItems } from '../items.ts'
import { MoreIcon, PanelIcon, UndoIcon, XIcon } from './Icons.tsx'
import { inboxLabel } from '../../../shared/inbox.ts'
import { renderInline } from '../util.ts'
import { isReaction } from '../emoji.ts'
import { Splitter, useWidth } from './Splitter.tsx'
import { cacheOf, limitLeft, minutes, money, moneyLong, ofFresh, pct, shareOf, spendOf, toggleMoney, useNow, usd } from '../cache.ts'
import { ttlLabel } from '../../../shared/cache.ts'
import { NotesPill } from './NotesDialog.tsx'
import { McpPill } from './McpDialog.tsx'

export function ContextGauge({ m, onCompact }: { m: SessionMeta; onCompact?: () => void }) {
  const used = m.context.used
  const window = Math.max(m.context.window, used)
  const pct = Math.min(100, (used / (window || 1)) * 100)
  const f = fatigue(used, window)
  const color = f < 0.35 ? 'var(--ok)' : f < 0.6 ? 'var(--warn)' : f < 0.85 ? 'var(--hot)' : 'var(--bad)'
  return (
    <div className="gauge" title={`${used.toLocaleString()} of ${window.toLocaleString()} tokens in context`}>
      <div className="gauge-bar"><div style={{ width: `${Math.max(pct, used ? 1 : 0)}%`, background: color }} /></div>
      <span className="gauge-label">{kTokens(used)} / {kTokens(window)}</span>
      {onCompact && <button className="link" disabled={m.status === 'working' || !m.started} onClick={onCompact} title="Summarise the conversation to free context (/compact)">Compact</button>}
    </div>
  )
}

// How long the prompt cache keeps this conversation; past that, the next send pays to write it again.
// The tooltip answers "chat on here, or start a new session from the notes?" with the numbers.
export function CachePill({ m }: { m: SessionMeta }) {
  const now = useNow()
  useStore()   // the dollars-or-percent choice
  const c = cacheOf(m, now)
  if (c.left == null) return null
  const busy = m.status === 'working' || m.status === 'permission'
  const soon = !c.cold && c.left < (c.ttl >= 3_600_000 ? 10 : 2) * 60_000
  const { cold: costCold, warm: costWarm } = c.limit
  const cost = (d: number, share: number | null) => `${usd(d)} (${ofFresh(d, c.dollars.fresh)} of those tokens${share != null ? `, about ${pct(share)} of your 5-hour limit` : ''})`
  const tokens = kTokens(m.context.used)
  const here = c.cold
    ? `The prompt cache expired ${minutes(-c.left)} ago. A message here re-caches all ${tokens} tokens: ${cost(c.dollars.cold, costCold)}. With a warm cache, a message cost ${usd(c.dollars.warm)}.`
    : `The prompt cache stays warm ${minutes(c.left)} more (${ttlLabel(c.ttl)} after each call). A message here reads ${tokens} cached tokens: ${cost(c.dollars.warm, costWarm)}.`
  const f = c.fresh
  const fresh = `A new session from the notes: about ${usd(f.first)} for the first message, then about ${usd(f.next)} a message (it starts at about ${kTokens(f.tokens)} tokens).`
    + (f.after == null ? ' It does not cost less.' : f.after <= 1 ? ' It costs less from the first message.' : ` It costs less after about ${f.after} messages.`)
  const title = `${here}\n\n${fresh} Neither counts what each reply adds.${costWarm == null ? '\n\nCodiner does not know the 5-hour limit in dollars yet.' : ''}`
  return (
    <button className={`cache-pill${c.cold ? ' cold' : soon ? ' soon' : ' warm'}${c.blocked ? ' blocked' : ''}`} data-tip={title} onClick={toggleMoney}>
      {busy ? 'Cache warm' : c.cold ? `Cache expired · ${money(c.dollars.cold)}` : `Cache warm · ${minutes(c.left)} · ${money(c.dollars.warm)}`}
    </button>
  )
}

// What this conversation has cost so far, each call priced when it was made (shared/prices.ts).
export function SpendPill({ m }: { m: SessionMeta }) {
  useStore()
  useNow(60_000)
  const s = spendOf(m)
  if (!s) return null
  return <button className="cache-pill spend-pill" data-tip={s.tip} onClick={toggleMoney}>{s.label}</button>
}

const MODES: { v: PermissionMode; label: string }[] = [
  { v: 'auto', label: 'Auto mode' },
  { v: 'default', label: 'Ask before tools' },
  { v: 'acceptEdits', label: 'Auto-accept edits' },
  { v: 'plan', label: 'Plan only' },
  { v: 'bypassPermissions', label: 'Bypass permissions' },
]

export function SessionHeader({ m, extra }: { m: SessionMeta; extra?: React.ReactNode }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(m.title)
  useEffect(() => setTitle(m.title), [m.title])
  const save = () => { setEditing(false); if (title.trim() && title !== m.title) void api(`/api/sessions/${m.id}`, 'PATCH', { title }) }
  // An alias or the default shows what it ran last time until Claude Code reports.
  const model = m.model?.includes('-') ? m.model : m.expectedModel ?? m.model
  return (
    <header className="session-head">
      <Mascot status={m.status} look={m.look} fatigue={fatigue(m.context.used, m.context.window)} size={44} title={STATUS_LABEL[m.status]} />
      <div className="head-main">
        {editing
          ? <input className="title-edit" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setTitle(m.title); setEditing(false) } }} />
          : <h1 className="rename" onClick={() => setEditing(true)} title="Click to rename">{m.title}</h1>}
        {/* Claude renamed a session you had named: your name stays one click away. */}
        {!editing && m.titleBefore != null && (
          <span className="title-before muted">was “{m.titleBefore}” <button className="link" onClick={() => void api(`/api/sessions/${m.id}`, 'PATCH', { title: m.titleBefore, undo: true })}>Undo</button></span>
        )}
        <div className="head-sub">
          <span className={`status-pill st-${m.status}`}>{m.compacting ? 'compacting' : STATUS_LABEL[m.status]}</span>
          <span className="muted mono path" title={m.cwd}>{'\u200E' + m.cwd.replace(/^\/Users\/[^/]+/, '~') + '\u200E'}</span>
          {model && <span className="muted" title={m.model?.includes('-') ? undefined : 'Model used for this choice last time'}>{model}</span>}
        </div>
      </div>
      <div className="head-side">
        <div className="head-gauges">
          <CachePill m={m} />
          <SpendPill m={m} />
          <NotesPill m={m} />
          <McpPill m={m} />
          <ContextGauge m={m} onCompact={() => {
            if (cacheOf(m, Date.now()).blocked && !confirm(`The prompt cache has expired. Compacting reads all ${kTokens(m.context.used)} tokens at full price. Compact anyway?`)) return
            void api(`/api/sessions/${m.id}/command`, 'POST', { cmd: '/compact' })
          }} />
        </div>
        <div className="head-actions">
          {m.kind === 'worker' && (
            <select value={m.permissionMode} onChange={(e) => void api(`/api/sessions/${m.id}`, 'PATCH', { permissionMode: e.target.value })}>
              {MODES.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}
            </select>
          )}
          {extra}
          <SessionMenu m={m} />
        </div>
      </div>
    </header>
  )
}

// Stop, Close and the rest, out of the way behind one button.
function SessionMenu({ m }: { m: SessionMeta }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])
  const busy = m.status === 'working' || m.status === 'permission'
  const act = (f: () => unknown) => () => { setOpen(false); void f() }
  const items = [
    busy && <button key="stop" className="danger" onClick={act(() => api(`/api/sessions/${m.id}/interrupt`))}>Stop</button>,
    m.kind === 'worker' && !m.archived && <button key="close" title="Archive session" onClick={act(() => closeSession(m.id))}>Close</button>,
    m.kind === 'worker' && m.archived && <button key="reopen" onClick={act(() => api(`/api/sessions/${m.id}`, 'PATCH', { archived: false }))}>Reopen</button>,
    m.kind === 'worker' && m.archived && <button key="delete" className="danger" title="Remove from Codiner (it stays in Resume)" onClick={act(() => { if (confirm(`Delete "${m.title}" from Codiner? Claude Code's own transcript is kept, so you can still find it under Resume.`)) return api(`/api/sessions/${m.id}`, 'DELETE').then(() => select('lead')) })}>Delete</button>,
  ].filter(Boolean)
  if (!items.length) return null
  return (
    <div className="menu-wrap" ref={box}>
      <button className={`icon-tall${busy ? ' busy' : ''}`} title="More" onClick={() => setOpen(!open)}><MoreIcon size={15} /></button>
      {open && <div className="menu">{items}</div>}
    </div>
  )
}

// The lead's drafts, in the reply tray: edit or remove each; they go with your next message.
function Inbox({ m }: { m: SessionMeta }) {
  if (!m.inbox.length) return null
  const remove = (id: string) => api(`/api/sessions/${m.id}/inbox/${id}/dismiss`)
  const edit = (id: string, text: string) => api(`/api/sessions/${m.id}/inbox/${id}/edit`, 'POST', { text })
  return (
    <div className="inbox">
      {m.inbox.map((i) => (
        <div key={i.id} className="inbox-item">
          <div className="inbox-head">
            <span className="inbox-from">From the {i.from === 'master' ? 'lead' : i.from}</span>
            {i.key
              ? <button className="link inbox-on" title="Show in conversation" onClick={() => revealItem(i.key!)}>{inboxLabel(i)}</button>
              : <span className="inbox-on">{inboxLabel(i)}</span>}
            <button className="icon-btn" title="Remove draft" onClick={() => void remove(i.id)}><XIcon size={13} /></button>
          </div>
          {!!i.choices?.length && <div className="inbox-choices">{i.choices.map((c) => <span key={c} className="chip static">{c}</span>)}</div>}
          {i.kind !== 'dismiss' && (
            <textarea className="inbox-text" defaultValue={i.text} rows={Math.min(8, Math.max(1, i.text.split('\n').length))}
              placeholder={i.kind === 'done' ? 'Any problem?' : ''}
              onBlur={(e) => { if (e.target.value !== i.text) void edit(i.id, e.target.value) }} />
          )}
        </div>
      ))}
    </div>
  )
}

// Replies people held for a joint turn (server/index.ts 'hold'): everyone sees them
// here, anyone can take one back, and the next send takes them all along.
function Held({ m }: { m: SessionMeta }) {
  if (!m.held?.length) return null
  const unhold = (id: string, part?: number) => api(`/api/sessions/${m.id}/unhold`, 'POST', { id, ...(part != null ? { part } : {}) })
  return (
    <div className="held-tray">
      <div className="held-head">Held for one reply · they go with the next send</div>
      {m.held.map((h) => (
        <div key={h.id} className="held-batch">
          <div className="held-by">
            <b>{h.by?.name ?? 'Someone'}</b> <span className="muted">{heldSummary(h.parts)}</span>
            <button className="icon-btn" title="Take these back out of the reply" onClick={() => void unhold(h.id)}><XIcon size={13} /></button>
          </div>
          {h.parts.map((p, i) => (
            <div key={i} className="held-part">
              {p.kind === 'note' && p.quote.trim() && <span className="held-quote">“{p.quote.length > 80 ? p.quote.slice(0, 80) + '…' : p.quote}”</span>}
              {p.kind === 'answer' && <span className="held-quote">{p.question.split('\n')[0]}</span>}
              <span className="held-text">{p.kind === 'dismiss' ? `dismissed ${p.items.length}` : p.kind === 'done' ? `done: ${p.items.map((x) => x.label).join(', ')}` : p.text}</span>
              {h.parts.length > 1 && <button className="icon-btn" title="Take this one back" onClick={() => void unhold(h.id, i)}><XIcon size={11} /></button>}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function heldSummary(parts: Part[]): string {
  const n = (k: Part['kind']) => parts.filter((p) => p.kind === k).length
  const out: string[] = []
  const add = (k: number, one: string, many: string) => { if (k) out.push(`${k} ${k === 1 ? one : many}`) }
  add(n('note'), 'comment', 'comments'); add(n('answer'), 'answer', 'answers'); add(n('text'), 'message', 'messages')
  return out.join(', ')
}

// Typing "/" at the start of the composer lists the session's slash commands:
// Claude Code's built-ins, your skills and the project's own.
function useSlashMenu(sid: string, text: string, setText: (t: string) => void) {
  const [cmds, setCmds] = useState<SlashCommand[] | null>(null)
  const [index, setIndex] = useState(0)
  const [closedFor, setClosedFor] = useState<string | null>(null)
  const m = /^\/([\w:.-]*)$/.exec(text)
  const typing = !!m && closedFor !== text
  useEffect(() => { setCmds(null) }, [sid])
  useEffect(() => { if (typing && !cmds) void api<SlashCommand[]>(`/api/sessions/${sid}/commands`, 'GET').then(setCmds).catch(() => {}) }, [typing, cmds, sid])
  const q = (m?.[1] ?? '').toLowerCase()
  const matches = !typing || !cmds ? [] : cmds
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, 50)
  useEffect(() => setIndex(0), [q])
  const pick = (c: SlashCommand) => setText(`/${c.name} `)
  const onKey = (e: React.KeyboardEvent) => {
    if (!matches.length) return false
    if (e.key === 'ArrowDown') { setIndex((i) => (i + 1) % matches.length); return true }
    if (e.key === 'ArrowUp') { setIndex((i) => (i - 1 + matches.length) % matches.length); return true }
    if ((e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) && matches[index]) { pick(matches[index]); return true }
    if (e.key === 'Escape') { setClosedFor(text); return true }
    return false
  }
  const menu = matches.length > 0 && (
    <div className="slash-menu" onMouseDown={(e) => e.preventDefault()}>
      {matches.map((c, i) => (
        <button key={c.name} className={i === index ? 'on' : ''} onMouseEnter={() => setIndex(i)} onClick={() => pick(c)} ref={i === index ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
          <span className="slash-name">/{c.name}{c.argumentHint && <span className="muted"> {c.argumentHint}</span>}</span>
          <span className="slash-desc">{c.description}</span>
        </button>
      ))}
    </div>
  )
  return { onKey, menu }
}

// What you set aside for this message: each one to look at again or take back.
function DismissedChip({ sid }: { sid: string }) {
  const [open, setOpen] = useState(false)
  const list = draftsOf(sid).flatMap((d) => d.kind === 'dismiss' ? [d] : [])
  useEffect(() => { if (!list.length) setOpen(false) }, [list.length])
  return (
    <span className="dismissed-wrap">
      <button className="chip open-chip" onClick={() => setOpen(!open)}>{list.length} dismissed</button>
      {open && (
        <div className="dismissed-list">
          {list.map((d) => (
            <div key={d.id}>
              <button className="link" title={d.label} onClick={() => revealItem(d.key)} dangerouslySetInnerHTML={{ __html: renderInline(d.label) }} />
              <button className="icon-btn" title="Undo" onClick={() => undismissItem(sid, d.key)}><UndoIcon size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </span>
  )
}

export function Composer({ m }: { m: SessionMeta }) {
  const st = useStore()
  const c = composerOf(m.id)
  const drafts = draftsOf(m.id).filter(hasContent)
  const reactions = drafts.filter((d) => d.kind === 'note' && isReaction(d.text) && !d.images.length).length
  const notes = drafts.filter((d) => d.kind === 'note').length - reactions
  const answers = drafts.filter((d) => d.kind === 'answer').length
  const dismissed = drafts.filter((d) => d.kind === 'dismiss').length
  const done = drafts.filter((d) => d.kind === 'done').length
  const [sending, setSending] = useState(false)
  // Sending while questions or items are still open warns once; sending again
  // dismisses the rest.
  const open = useItems(m.id).filter((i) => i.status === 'open')
  const [warned, setWarned] = useState(false)
  useEffect(() => { if (!open.length) setWarned(false) }, [open.length])
  useEffect(() => setWarned(false), [m.id])
  const slash = useSlashMenu(m.id, c.text, (text) => setComposer(m.id, { text }))
  const isCommand = /^\/[\w:.-]+/.test(c.text.trim()) && !c.images.length
  const mine = isCommand ? 1 : queuedParts(m.id).length
  const held = isCommand ? 0 : (m.held ?? []).reduce((a, h) => a + h.parts.length, 0)
  const n = mine + held
  // Holding is for several people at one desk: only when Codiner knows who is who.
  const canHold = !!state.me && m.kind === 'worker' && !isCommand && mine > 0
  // A send that would re-cache a big, expired context waits for "Send anyway" in the bar above.
  const now = useNow()
  const cache = cacheOf(m, now)
  const costly = cache.blocked && (!isCommand || /^\/compact\b/.test(c.text.trim()))
  const [nudge, setNudge] = useState(0)
  const send = async (force = false) => {
    if (!n || sending) return
    if (costly && !force) { setNudge((x) => x + 1); return }
    if (!isCommand && open.length && !warned) { setWarned(true); revealItem(open[0].key); return }
    setSending(true)
    try {
      if (isCommand) {
        // A slash command has to be the whole message; queued replies wait for the next one.
        await api(`/api/sessions/${m.id}/send`, 'POST', { parts: [{ kind: 'text', text: c.text.trim() }] })
        setComposer(m.id, { text: '' })
      } else await sendQueued(m.id, open.map((i) => ({ key: i.key, label: i.label })))
    } finally { setSending(false) }
  }
  const hold = async () => {
    if (!canHold || sending) return
    setSending(true)
    try { await holdQueued(m.id) } finally { setSending(false) }
  }
  return (
    <div className="composer">
      <Inbox m={m} />
      <Held m={m} />
      {(notes > 0 || reactions > 0 || answers > 0 || dismissed > 0 || done > 0 || open.length > 0) && (
        <div className="queue">
          {notes > 0 && <span className="chip static">{notes} {notes === 1 ? 'comment' : 'comments'}</span>}
          {reactions > 0 && <span className="chip static">{reactions} {reactions === 1 ? 'reaction' : 'reactions'}</span>}
          {answers > 0 && <span className="chip static">{answers} {answers === 1 ? 'answer' : 'answers'}</span>}
          {done > 0 && <span className="chip static">{done} done</span>}
          {dismissed > 0 && <DismissedChip sid={m.id} />}
          {open.length > 0 && <button className={`chip open-chip${warned ? ' warn' : ''}`} onClick={() => revealItem(open[0].key)}>{open.length} open</button>}
        </div>
      )}
      {costly && n > 0 && (
        <div key={nudge} className={`cache-guard${nudge ? ' nudge' : ''}`}>
          <span>
            <b>The prompt cache expired {minutes(-(cache.left ?? 0))} ago.</b> This message writes {kTokens(m.context.used)} tokens to the cache again.{' '}
            That costs about <button className="link" title="Show as dollars or % of 5-hour or weekly limit" onClick={toggleMoney}><b>{moneyLong(cache.dollars.cold)}</b></button>
            {state.money !== 'usd' && shareOf(cache.dollars.cold) != null && limitLeft() != null && <> ({pct(limitLeft()!)} left)</>}, about {cache.times}× a message sent while the cache is warm ({moneyLong(cache.dollars.warm)}).
            {state.money !== 'usd' && shareOf(cache.dollars.cold) == null && <> Codiner is still measuring how much of your usage limit that is.</>}
          </span>
          <button className="primary" disabled={sending} onClick={() => void send(true)}>Send anyway</button>
        </div>
      )}
      <div className="composer-row">
        {slash.menu}
        <RichInput
          value={c.text}
          onChange={(text) => setComposer(m.id, { text })}
          images={c.images}
          onImages={(images) => setComposer(m.id, { images })}
          placeholder={m.kind === 'lead' ? 'Message the lead' : `Message ${agentName()}`}
          onSubmit={() => send()}
          onKey={slash.onKey}
          minRows={1}
        />
        {canHold && <button className="send hold" disabled={sending || !st.connected} onClick={() => void hold()} title="Hold your replies for one joint reply: others see them and add theirs, and the next send takes them all">Hold</button>}
        <button className="primary send" disabled={!n || sending || !st.connected} onClick={() => send()} title={costly ? 'Prompt cache expired: use Send anyway above' : undefined}>
          {sending ? 'Sending…' : isCommand ? 'Run' : warned && open.length ? 'Send anyway' : n > 1 ? `Send ${n}` : 'Send'}
        </button>
      </div>
    </div>
  )
}

export function SessionView({ id, extra }: { id: string; extra?: React.ReactNode }) {
  const st = useStore()
  const m = st.sessions.find((s) => s.id === id)
  useEffect(() => { void loadEvents(id) }, [id])
  const items = useItems(id)
  const [panel, setPanel] = useState(() => localStorage.getItem('codiner.panel') !== '0')
  const togglePanel = () => { localStorage.setItem('codiner.panel', panel ? '0' : '1'); setPanel(!panel) }
  const [panelW, setPanelW] = useWidth('attention', 300)
  if (!m) return <div className="empty">No such session.</div>
  const open = items.filter((i) => i.status === 'open').length
  return (
    <div className="session">
      <SessionHeader m={m} extra={<>
        {extra}
        {items.length > 0 && <button className={`panel-toggle icon-tall${panel ? ' on' : ''}`} title="Questions and items" onClick={togglePanel}><PanelIcon size={15} />{open > 0 && <span className="count">{open}</span>}</button>}
      </>} />
      <div className="session-body">
        <div className="session-main">
          <Transcript sid={id} />
          <Composer m={m} />
        </div>
        {panel && items.length > 0 && <>
          <Splitter width={panelW} setWidth={setPanelW} min={220} max={640} initial={300} reverse />
          <AttentionPanel sid={id} width={panelW} onHide={togglePanel} />
        </>}
      </div>
    </div>
  )
}
