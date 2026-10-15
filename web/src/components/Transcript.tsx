import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Anchor, Block, Event, ImageRef, Part } from '../../../shared/types.ts'
import { addDraft, agentName, api, draftsOf, removeDraft, rewind, state, uid, useStore } from '../store.ts'
import { anchorFromRange } from '../anchoring.ts'
import { renderInline, renderMd, renderText } from '../util.ts'
import { AssistantMessage, type Reaction } from './AssistantMessage.tsx'
import { RichInput, Thumbs } from './Inputs.tsx'
import { foldItems, revealItem, trackItems, type TrackedItem } from '../items.ts'
import { itemsOf } from '../../../shared/blocks.ts'
import { isReaction } from '../emoji.ts'
import { splitQuote } from '../../../shared/asks.ts'
import { highlight, langOfPath } from '../highlight.ts'
import { CARD_W, GUTTER_GAP, Margin, focusPassage, rangesOfNote } from './Margin.tsx'
import { AgentsIcon, BlockIcon, CheckIcon, ChevronIcon, DashIcon, XIcon, FileIcon, GlobeIcon, ListIcon, PencilIcon, SearchIcon, TerminalIcon, ToolIcon, TrashIcon } from './Icons.tsx'

type PermEvent = Extract<Event, { t: 'permission' }>
type Folded = {
  results: Map<string, Extract<Event, { t: 'tool_result' }>>
  resolved: Map<string, string>
  items: Map<string, TrackedItem>     // questions and items to consider, by "<msg>:<id>"
  sent: Map<string, Anchor[]>
  reacts: Map<string, Reaction[]>    // reactions sent, by message
  permOf: Map<string, PermEvent>     // tool_use id → its approval request
  linked: Set<string>                // approval requests shown on their tool line
}

const inputKey = (input: unknown) => JSON.stringify(input ?? null)

function fold(events: Event[]): Folded {
  const f: Folded = { results: new Map(), resolved: new Map(), items: new Map(), sent: new Map(), reacts: new Map(), permOf: new Map(), linked: new Set() }
  const uses: { id: string; name: string; key: string }[] = []
  for (const e of events) {
    if (e.t === 'tool_result') f.results.set(e.toolUseId, e)
    else if (e.t === 'permission_resolved') f.resolved.set(e.requestId, e.resolution)
    else if (e.t === 'assistant') { for (const b of e.blocks) if (b.type === 'tool_use') uses.push({ id: b.id, name: b.name, key: inputKey(b.input) }) }
    else if (e.t === 'permission') {
      // Older logs lack toolUseId. A request is for a tool that is still waiting:
      // no approval and no result yet. Prefer the same input, then the same tool,
      // then the latest such call.
      let id = e.toolUseId
      if (!id) {
        const open = uses.filter((u) => !f.permOf.has(u.id) && !f.results.has(u.id))
        const key = inputKey(e.input)
        id = (open.findLast((u) => u.key === key) ?? open.findLast((u) => u.name === e.toolName) ?? open.at(-1))?.id
      }
      if (id) { f.permOf.set(id, e); f.linked.add(e.requestId) }
    } else if (e.t === 'user') for (const p of e.parts) {
      if (p.kind === 'note' && isReaction(p.text) && !p.images?.length) f.reacts.set(p.anchor.msg, [...(f.reacts.get(p.anchor.msg) ?? []), { anchor: p.anchor, emoji: p.text.trim(), whole: !!p.whole, quote: p.quote }])
      else if (p.kind === 'note') f.sent.set(p.anchor.msg, [...(f.sent.get(p.anchor.msg) ?? []), p.anchor])
    }
  }
  return f
}

// Room for a column of text plus the comment gutter beside it.
const GUTTER_MIN = 560 + GUTTER_GAP + CARD_W + 60

export function Transcript({ sid }: { sid: string }) {
  const st = useStore()
  const events = st.events[sid]
  const streaming = st.streaming[sid] ?? ''
  const meta = st.sessions.find((s) => s.id === sid)
  const base = useMemo(() => fold(events ?? []), [events])
  const itemFold = useMemo(() => foldItems(events ?? []), [events])
  // Item status also follows the drafts, so it is worked out on every render.
  const folded: Folded = { ...base, items: new Map(trackItems(sid, events ?? [], itemFold).map((t) => [t.key, t])) }
  // Comments on a message keep it in view.
  const drafted = draftsOf(sid).flatMap((d) => d.kind === 'note' ? [d.anchor.msg] : []).sort().join(' ')
  const steps = useMemo(() => st.showSteps ? new Set<string>() : interim(events ?? [], base, new Set(drafted.split(' '))), [events, base, drafted, st.showSteps])
  const groups = useMemo(() => group(events ?? [], base, steps), [events, base, steps])
  const scroller = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [gutter, setGutter] = useState(true)

  // Follow new output while you're at the bottom; stay put if you scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [events?.length, streaming, sid])
  useEffect(() => { stick.current = true }, [sid])

  // The composer lines up with the text column, which moves over for the margin.
  useEffect(() => { scroller.current?.closest('.session-main')?.classList.toggle('gutter', gutter) }, [gutter, !!events])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setGutter(el.clientWidth >= GUTTER_MIN))
    ro.observe(el)
    return () => ro.disconnect()
  }, [!!events])

  // Select any of Claude's text and a comment opens on it, focused, as in Marginer.
  // With the Comment button on (Settings), the selection stays for copying, and a
  // button by it (or ⌘⌥M, as in Google Docs) opens the comment.
  const [offer, setOffer] = useState<{ x: number; y: number; make(): void } | null>(null)
  useEffect(() => {
    if (!offer) return
    const gone = () => { if (getSelection()?.isCollapsed) setOffer(null) }
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyM') { e.preventDefault(); offer.make() } }
    // It follows the selection as the transcript scrolls.
    const move = () => {
      const sel = getSelection()
      if (!sel?.rangeCount) return
      const box = sel.getRangeAt(0).getBoundingClientRect()
      setOffer((o) => o && (o.x !== box.right || o.y !== box.top) ? { ...o, x: box.right, y: box.top } : o)
    }
    document.addEventListener('selectionchange', gone)
    document.addEventListener('keydown', key)
    document.addEventListener('scroll', move, true)
    return () => { document.removeEventListener('selectionchange', gone); document.removeEventListener('keydown', key); document.removeEventListener('scroll', move, true) }
  }, [offer?.make])
  useEffect(() => {
    const up = () => setTimeout(() => {
      const sel = getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) return
      const r = sel.getRangeAt(0)
      const msgOf = (n: Node) => (n.nodeType === 1 ? n as Element : n.parentElement)?.closest<HTMLElement>('[data-msg]')
      const el = msgOf(r.startContainer)
      if (!el || el !== msgOf(r.endContainer) || el.dataset.sid !== sid) return
      const at = (n: Node) => (n.nodeType === 1 ? n as Element : n.parentElement)
      if (at(r.commonAncestorContainer)?.closest('.ask-card, .ri-edit, textarea, input, button, summary')) return
      const anchor = anchorFromRange(r, el)
      if (!anchor) return
      const quote = sel.toString().trim().replace(/\n{3,}/g, '\n\n')
      // A comment inside an item to consider counts as the reply to it.
      const itemKey = at(r.commonAncestorContainer)?.closest<HTMLElement>('.consider[data-item]')?.dataset.item
      const make = () => {
        setOffer(null)
        // One empty comment at a time: starting a new one drops the untouched last one.
        for (const d of draftsOf(sid)) if (d.kind === 'note' && !d.text.trim() && !d.images.length) removeDraft(sid, d.id)
        getSelection()?.removeAllRanges()
        addDraft(sid, { id: uid(), kind: 'note', anchor, quote, text: '', images: [], createdAt: Date.now(), ...(itemKey ? { itemKey } : {}) })
      }
      if (!state.commentButton) return make()
      const box = r.getBoundingClientRect()
      setOffer({ x: box.right, y: box.top, make })
    }, 0)
    document.addEventListener('mouseup', up)
    return () => document.removeEventListener('mouseup', up)
  }, [sid])

  if (!events) return <div className="transcript"><div className="empty">Loading…</div></div>

  return (
    <div className="transcript-wrap">
    {/* Keeps the selection: mousedown would otherwise clear it before the click. */}
    {offer && createPortal(<button className="comment-offer" style={{ left: offer.x, top: offer.y }} title="Comment (⌘⌥M)" onMouseDown={(e) => e.preventDefault()} onClick={() => offer.make()}>Comment</button>, document.body)}
    <div
      className="transcript" ref={scroller}
      // New output is followed only while you are at the very bottom; any move up lets go at once.
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4 }}
      onWheel={(e) => { if (e.deltaY < 0) stick.current = false }}
      onKeyDown={(e) => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) stick.current = false }}
    >
      <div className={`transcript-inner${gutter ? ' gutter' : ''}`} ref={inner}>
        <div className="column" ref={column}>
          {groups.map((g, i) => g.kind === 'one'
            ? <ItemView key={g.item.key} sid={sid} item={g.item} f={folded} />
            : <Activity key={g.items[0].key} sid={sid} items={g.items} f={folded} live={i === groups.length - 1 && meta?.status === 'working'} />)}
          {streaming && <AssistantMessage sid={sid} msg="live" text={streaming} live />}
          {meta?.status === 'working' && !streaming && <div className="working-dots"><span /><span /><span /></div>}
        </div>
        <Margin sid={sid} inner={inner} column={column} gutter={gutter} events={events} />
      </div>
    </div>
    <OpenToast scroller={scroller} keys={[...folded.items.values()].filter((t) => t.status === 'open').map((t) => t.key)} />
    </div>
  )
}

// While open questions or items are out of view, a toast at the bottom of the
// transcript points toward the nearest one; clicking it goes there.
function OpenToast({ scroller, keys }: { scroller: React.RefObject<HTMLDivElement | null>; keys: string[] }) {
  const [target, setTarget] = useState<{ key: string; dir: 'up' | 'down' } | null>(null)
  const sig = keys.join('|')
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const check = () => {
      const view = el.getBoundingClientRect()
      let best: { key: string; dir: 'up' | 'down'; dist: number } | null = null
      for (const key of keys) {
        const r = el.querySelector(`[data-item="${CSS.escape(key)}"]`)?.getBoundingClientRect()
        if (!r || !r.height) continue
        const dir = r.bottom < view.top + 20 ? 'up' : r.top > view.bottom - 20 ? 'down' : null
        if (!dir) { best = null; break } // one is on screen: no need to point
        const dist = dir === 'up' ? view.top - r.bottom : r.top - view.bottom
        if (!best || dist < best.dist) best = { key, dir, dist }
      }
      setTarget(best && { key: best.key, dir: best.dir })
    }
    check()
    el.addEventListener('scroll', check, { passive: true })
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', check); ro.disconnect() }
  }, [sig])
  if (!target) return null
  return (
    <button key={sig} className={`open-toast ${target.dir}`} onClick={() => revealItem(target.key)}>
      <ChevronIcon size={12} className="toast-arrow" />
      {keys.length} open
    </button>
  )
}

// The transcript as a list of items, one per thing that shows. Thinking and tool
// calls between two pieces of Claude's text are activity, and fold into one row.
type Item = { key: string; e: Event; block?: Block; i?: number; activity: boolean }
type Group = { kind: 'one'; item: Item } | { kind: 'activity'; items: Item[] }

// Claude's text between tool calls is a step on the way. Once the turn is over,
// all but its last text fold into the activity rows, unless they hold questions,
// items to consider or comments.
function interim(events: Event[], f: Folded, drafted: Set<string>): Set<string> {
  const out = new Set<string>()
  let texts: { key: string; text: string }[] = []
  for (const e of events) {
    if (e.t === 'user') texts = []
    else if (e.t === 'assistant' && !e.synthetic) e.blocks.forEach((b, i) => { if (b.type === 'text') texts.push({ key: `${e.seq}.${i}`, text: b.text }) })
    else if (e.t === 'result') {
      for (const t of texts.slice(0, -1)) if (!f.sent.has(t.key) && !f.reacts.has(t.key) && !drafted.has(t.key) && !itemsOf(t.text).length) out.add(t.key)
      texts = []
    }
  }
  return out
}

function items(events: Event[], f: Folded, steps: Set<string>): Item[] {
  const out: Item[] = []
  for (const e of events) {
    switch (e.t) {
      case 'assistant':
        e.blocks.forEach((b, i) => out.push({ key: `${e.seq}.${i}`, e, block: b, i, activity: b.type !== 'text' || steps.has(`${e.seq}.${i}`) }))
        break
      case 'permission': {
        const resolved = f.resolved.has(e.requestId)
        // Answered requests show as a mark on their tool line instead.
        if (resolved && f.linked.has(e.requestId)) break
        out.push({ key: `${e.seq}`, e, activity: resolved })
        break
      }
      case 'tool_result': case 'permission_resolved': break
      default: out.push({ key: `${e.seq}`, e, activity: false })
    }
  }
  return out
}

function group(events: Event[], f: Folded, steps: Set<string>): Group[] {
  const out: Group[] = []
  let run: Item[] = []
  const flush = () => {
    if (run.length === 1) out.push({ kind: 'one', item: run[0] })
    else if (run.length) out.push({ kind: 'activity', items: run })
    run = []
  }
  for (const it of items(events, f, steps)) {
    if (it.activity) run.push(it)
    else { flush(); out.push({ kind: 'one', item: it }) }
  }
  flush()
  return out
}

function ItemView({ sid, item, f }: { sid: string; item: Item; f: Folded }) {
  const { e, block } = item
  if (block && e.t === 'assistant') return <BlockView sid={sid} b={block} msg={item.key} f={f} synthetic={e.synthetic} />
  switch (e.t) {
    case 'user': return <UserTurn sid={sid} e={e} />
    case 'permission': return <PermissionCard sid={sid} e={e} resolution={f.resolved.get(e.requestId)} />
    case 'notice': return <div className={`notice ${e.level}`}>{e.text.length > 600 ? <details><summary>{e.text.split('\n')[0].slice(0, 120)}</summary><pre>{e.text}</pre></details> : e.text}</div>
    case 'result': return e.isError ? <div className="notice error">{e.text ?? 'The turn ended with an error.'}</div> : <div className="turn-end" title={`${(e.durationMs / 1000).toFixed(1)}s`} />
    default: return null
  }
}

function BlockView({ sid, b, msg, f, synthetic }: { sid: string; b: Block; msg: string; f: Folded; synthetic?: boolean }) {
  if (b.type === 'text') {
    if (synthetic) return <div className="notice info md" dangerouslySetInnerHTML={{ __html: renderMd(b.text) }} />
    return <AssistantMessage sid={sid} msg={msg} text={b.text} items={f.items} sent={f.sent.get(msg) ?? []} reacts={f.reacts.get(msg)} />
  }
  if (b.type === 'thinking') return <details className="thinking" open><summary>Thinking</summary><div className="md" dangerouslySetInnerHTML={{ __html: renderMd(b.text) }} /></details>
  const perm = f.permOf.get(b.id)
  return <ToolCall b={b} result={f.results.get(b.id)} resolution={perm ? f.resolved.get(perm.requestId) : undefined} />
}

const KINDS: [string, string, string][] = [
  ['edit', 'edit', 'edits'], ['command', 'command', 'commands'], ['read', 'read', 'reads'], ['search', 'search', 'searches'],
  ['web', 'web lookup', 'web lookups'], ['agent', 'agent', 'agents'], ['other', 'tool call', 'tool calls'],
]
const kindOf = (name: string) =>
  /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(name) ? 'edit'
  : name === 'Bash' ? 'command'
  : name === 'Read' ? 'read'
  : /^(Glob|Grep)$/.test(name) ? 'search'
  : /^Web/.test(name) ? 'web'
  : /^(Task|Agent)$/.test(name) ? 'agent'
  : 'other'

function tally(items: Item[], f: Folded): string {
  const n: Record<string, number> = {}
  let thinking = false, denied = 0, failed = 0, said = 0
  for (const { e, block } of items) {
    if (block?.type === 'thinking') thinking = true
    else if (block?.type === 'text') said++
    else if (block?.type === 'tool_use') {
      const k = kindOf(block.name)
      n[k] = (n[k] ?? 0) + 1
      const perm = f.permOf.get(block.id)
      if (perm && f.resolved.get(perm.requestId) === 'deny') denied++
      else if (f.results.get(block.id)?.isError) failed++
    } else if (e.t === 'permission' && f.resolved.get(e.requestId) === 'deny') denied++
  }
  const parts = thinking ? ['Thinking'] : []
  if (said) parts.push(`${said} ${said === 1 ? 'update' : 'updates'}`)
  for (const [k, one, many] of KINDS) if (n[k]) parts.push(`${n[k]} ${n[k] === 1 ? one : many}`)
  if (denied) parts.push(`${denied} denied`)
  if (failed) parts.push(`${failed} failed`)
  return parts.join(' · ')
}

function Activity({ sid, items, f, live }: { sid: string; items: Item[]; f: Folded; live: boolean }) {
  const [open, setOpen] = useState(false)
  const last = items[items.length - 1]
  return (
    <div className={`activity${open ? ' open' : ''}`} data-seqs={[...new Set(items.map((it) => it.e.seq))].join(',')}>
      <button className="tool-line activity-line" onClick={() => setOpen(!open)}>
        <span className="tool-icon"><ChevronIcon size={12} className="chevron" /></span>
        <span className="activity-sum">{tally(items, f)}</span>
      </button>
      {open
        ? <div className="activity-items">{items.map((it) => <ItemView key={it.key} sid={sid} item={it} f={f} />)}</div>
        : live && <div className="activity-items"><ItemView sid={sid} item={last} f={f} /></div>}
    </div>
  )
}

function UserTurn({ sid, e }: { sid: string; e: Extract<Event, { t: 'user' }> }) {
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  // Comments, reactions and answers live beside what they answer; here they fold into one line.
  const [open, setOpen] = useState(false)
  const run = async (f: () => Promise<void>) => {
    setBusy(true)
    try { await f() } finally { setBusy(false) }
  }
  if (editing) return <UserEdit sid={sid} e={e} onDone={() => setEditing(false)} />
  const replies = e.parts.filter((p) => p.kind !== 'text')
  const shown = open ? e.parts : e.parts.filter((p) => p.kind === 'text')
  return (
    <div className="user-wrap" onMouseLeave={() => setConfirm(false)}>
    <div className="user-turn">
      {e.from && <div className="from">via {e.from === 'master' ? 'lead' : e.from}</div>}
      {/* Who sent it; in a joint turn, each part also names its writer when that differs. */}
      {e.by && <div className="from by">{e.by.name}</div>}
      {replies.length > 0 && (
        <button className={`replies-sum${open ? ' open' : ''}`} onClick={() => setOpen(!open)}>
          <ChevronIcon size={11} className="chevron" /> {repliesSummary(replies)}
        </button>
      )}
      {shown.map((p, i) => (
        <div
          key={i}
          className={`user-part ${p.kind}`}
          {...(p.kind === 'note' ? {
            onMouseEnter: () => focusPassage(sid, p),
            onMouseLeave: () => focusPassage(sid, null),
            onClick: () => {
              const el = rangesOfNote(sid, p)[0]?.startContainer.parentElement
              // A passage inside a closed "more details" section opens it first.
              for (let d = el?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true
              el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            },
          } : {})}
        >
          {p.by && p.by.login !== e.by?.login && <div className="part-by">{p.by.name}</div>}
          <PartHead p={p} />
          {p.text.trim() && <div className="md" dangerouslySetInnerHTML={{ __html: renderText(p.text) }} />}
          <Thumbs images={p.images} />
        </div>
      ))}
    </div>
      <div className="user-actions">
        <button className="icon-btn" title="Edit" disabled={busy} onClick={() => setEditing(true)}><PencilIcon size={13} /></button>
        {confirm
          ? <button className="link danger" disabled={busy} onClick={() => run(() => rewind(sid, e.seq))}>Delete from here</button>
          : <button className="icon-btn" title="Delete from here" disabled={busy} onClick={() => setConfirm(true)}><TrashIcon size={13} /></button>}
      </div>
    </div>
  )
}

function repliesSummary(parts: Part[]): string {
  const reactions = parts.flatMap((p) => p.kind === 'note' && isReaction(p.text) && !p.images?.length ? [p.text.trim()] : [])
  const n = (k: Part['kind']) => parts.filter((p) => p.kind === k).length
  const comments = n('note') - reactions.length
  const done = parts.reduce((s, p) => s + (p.kind === 'done' ? p.items.length : 0), 0)
  const dismissed = parts.reduce((s, p) => s + (p.kind === 'dismiss' ? p.items.length : 0), 0)
  const out: string[] = []
  const add = (k: number, one: string, many: string) => { if (k) out.push(`${k} ${k === 1 ? one : many}`) }
  add(comments, 'comment', 'comments'); add(reactions.length, 'reaction', 'reactions'); add(n('answer'), 'answer', 'answers'); add(done, 'done', 'done'); add(dismissed, 'dismissed', 'dismissed')
  return out.join(', ')
}

// Claude gets only the first words of a long quote; the "…" shows the rest, dimmed.
function SentQuote({ quote }: { quote: string }) {
  const [open, setOpen] = useState(false)
  const { head, rest } = splitQuote(quote)
  return (
    <div className={`sent-quote${open ? ' open' : ''}`}>
      {head}
      {rest && (open
        ? <span className="quote-rest" title="Not sent to the agent">{rest}</span>
        : <button className="quote-more" title="Show the rest (not sent to the agent)" onClick={(ev) => { ev.stopPropagation(); setOpen(true) }}>…</button>)}
    </div>
  )
}

function PartHead({ p }: { p: Part }) {
  return <>
    {p.kind === 'note' && p.quote.trim() && <SentQuote quote={p.quote} />}
    {p.kind === 'dismiss' && <div className="sent-dismiss"><XIcon size={11} /> {p.items.map((i) => i.label).join(' · ')}</div>}
    {p.kind === 'done' && <div className="sent-dismiss sent-done"><CheckIcon size={11} /> {p.items.map((i) => i.text ? `${i.label} (${i.text})` : i.label).join(' · ')}</div>}
    {p.kind === 'answer' && <div className="answer-q" dangerouslySetInnerHTML={{ __html: renderInline(p.question.split('\n')[0]) }} />}
    {p.kind === 'answer' && p.choices?.length ? <div className="answer-choices">{p.choices.join('; ')}</div> : null}
  </>
}

// Edit a sent message: it and everything after it go, and the edited one is sent in its place.
function UserEdit({ sid, e, onDone }: { sid: string; e: Extract<Event, { t: 'user' }>; onDone(): void }) {
  // Every part keeps its quote or question; its text and images can change.
  // A message without plain text gets an empty box for some.
  const [parts, setParts] = useState<Part[]>(() => e.parts.some((p) => p.kind === 'text') ? e.parts : [...e.parts, { kind: 'text', text: '' }])
  const [busy, setBusy] = useState(false)
  const set = (i: number, patch: { text?: string; images?: ImageRef[] }) => setParts((ps) => ps.map((p, j) => j === i ? { ...p, ...patch } as Part : p))
  const kept = parts.filter((p) => p.kind === 'dismiss' || p.kind === 'done' || p.text.trim() || p.images?.length || (p.kind === 'answer' && p.choices?.length))
  const submit = async () => {
    if (!kept.length || busy) return
    setBusy(true)
    try { await rewind(sid, e.seq, kept); onDone() } catch { setBusy(false) }
  }
  return (
    <div className="user-turn editing">
      {parts.map((p, i) => (
        <div key={i} className={`user-part ${p.kind}`}>
          <PartHead p={p} />
          {p.kind !== 'dismiss' && p.kind !== 'done' && (
            <RichInput value={p.text} onChange={(text) => set(i, { text })} images={p.images ?? []} onImages={(images) => set(i, { images })}
              placeholder={p.kind === 'note' ? 'Comment' : p.kind === 'answer' ? 'Answer' : `Message ${agentName()}`}
              autoFocus={i === parts.length - 1} minRows={1} onSubmit={submit} onEscape={onDone} />
          )}
        </div>
      ))}
      <div className="edit-actions">
        <button disabled={busy} onClick={onDone}>Cancel</button>
        <button className="primary" disabled={busy || !kept.length} onClick={submit}>Send</button>
      </div>
    </div>
  )
}

const TOOL_ICON: Record<string, (p: { size?: number }) => React.ReactElement> = {
  Bash: TerminalIcon, Read: FileIcon, Write: PencilIcon, Edit: PencilIcon, NotebookEdit: PencilIcon,
  Glob: SearchIcon, Grep: SearchIcon, WebFetch: GlobeIcon, WebSearch: GlobeIcon, Task: AgentsIcon, Agent: AgentsIcon, TodoWrite: ListIcon,
}

function summary(name: string, input: any): string {
  if (!input) return ''
  if (name === 'Bash') return input.command ?? ''
  if (input.file_path) return input.file_path.replace(/^\/Users\/[^/]+/, '~')
  const v = input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt
  return typeof v === 'string' ? v : JSON.stringify(input)
}

const RESOLUTION: Record<string, { Icon: (p: { size?: number }) => React.ReactElement; title: string }> = {
  allow: { Icon: CheckIcon, title: 'Allowed' },
  always: { Icon: CheckIcon, title: 'Always allowed' },
  deny: { Icon: BlockIcon, title: 'Denied' },
  cancelled: { Icon: DashIcon, title: 'Approval cancelled' },
}

function ToolCall({ b, result, resolution }: { b: Extract<Block, { type: 'tool_use' }>; result?: Extract<Event, { t: 'tool_result' }>; resolution?: string }) {
  const [open, setOpen] = useState(false)
  const name = b.name.replace(/^mcp__([^_]+)__/, '$1·')
  const Icon = TOOL_ICON[b.name] ?? ToolIcon
  const r = resolution ? RESOLUTION[resolution] : null
  return (
    <div className={`tool${result?.isError ? ' err' : ''}${result ? '' : ' running'}${resolution ? ` perm-${resolution}` : ''}`}>
      <button className="tool-line" onClick={() => setOpen(!open)}>
        <span className="tool-icon"><Icon size={13} /></span>
        <span className="tool-name">{name}</span>
        <span className="tool-sum">{summary(b.name, b.input).split('\n')[0]}</span>
        {r && <span className="tool-perm" title={r.title}><r.Icon size={12} /></span>}
      </button>
      {open && (
        <div className="tool-body">
          {b.name === 'Edit' && b.input?.old_string != null
            ? <Diff path={b.input.file_path} del={b.input.old_string} add={b.input.new_string} />
            : b.name === 'Write' ? <Code code={b.input?.content ?? ''} lang={langOfPath(b.input?.file_path)} />
            : b.name === 'Bash' ? <Code code={b.input?.command ?? ''} lang="bash" prompt />
            : <pre>{JSON.stringify(b.input, null, 2)}</pre>}
          {result && <pre className="tool-result">{result.text || '(no output)'}</pre>}
        </div>
      )}
    </div>
  )
}

export function Code({ code, lang, prompt, className }: { code: string; lang?: string; prompt?: boolean; className?: string }) {
  return <pre className={`hljs${className ? ` ${className}` : ''}`} dangerouslySetInnerHTML={{ __html: (prompt ? '<span class="hljs-meta">$</span> ' : '') + highlight(code, lang) }} />
}

function Diff({ path, del, add }: { path?: string; del: string; add: string }) {
  const lang = langOfPath(path)
  return <div className="diff"><Code className="del" code={del} lang={lang} /><Code className="add" code={add} lang={lang} /></div>
}

function PermissionCard({ sid, e, resolution }: { sid: string; e: PermEvent; resolution?: string }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const decide = async (decision: 'allow' | 'always' | 'deny') => {
    setBusy(true)
    try { await api(`/api/sessions/${sid}/permission`, 'POST', { requestId: e.requestId, decision, message: reason }) } finally { setBusy(false) }
  }
  const detail = e.toolName === 'Bash' ? e.input?.command : e.input?.file_path ?? JSON.stringify(e.input, null, 2)
  if (resolution) {
    const r = RESOLUTION[resolution]
    const Icon = TOOL_ICON[e.toolName] ?? ToolIcon
    return (
      <div className={`tool perm-${resolution}`}>
        <div className="tool-line">
          <span className="tool-icon"><Icon size={13} /></span>
          <span className="tool-name">{e.toolName}</span>
          <span className="tool-sum">{summary(e.toolName, e.input).split('\n')[0]}</span>
          {r && <span className="tool-perm" title={r.title}><r.Icon size={12} /></span>}
        </div>
      </div>
    )
  }
  return (
    <div className="perm">
      <div className="perm-head">Claude wants to use <b>{e.toolName}</b>{e.description ? <>: {e.description}</> : null}</div>
      {e.toolName === 'Bash' ? <Code code={detail ?? ''} lang="bash" /> : <pre>{detail}</pre>}
      {e.toolName === 'Edit' && e.input?.old_string != null && <Diff path={e.input.file_path} del={e.input.old_string} add={e.input.new_string} />}
      <div className="perm-actions">
        <button className="primary" disabled={busy} onClick={() => decide('allow')}>Allow</button>
        {e.canAlways && <button disabled={busy} onClick={() => decide('always')}>Always allow</button>}
        <input placeholder="Reason" value={reason} onChange={(x) => setReason(x.target.value)} onKeyDown={(x) => { if (x.key === 'Enter') void decide('deny') }} />
        <button className="danger" disabled={busy} onClick={() => decide('deny')}>Deny</button>
      </div>
    </div>
  )
}
