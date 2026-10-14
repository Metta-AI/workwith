// One block of Claude's text, rendered markdown block by markdown block: each
// block is an anchoring root for comments (whose cards live in the margin, see
// Margin.tsx). The sections Claude marks (shared/blocks.ts) get their own
// treatment: <answer> stands out, <details> folds, <consider> items and <ask>
// questions each want a reply or a dismissal. With `live` (a reply still
// streaming) everything renders read-only and an unfinished section shows what
// has arrived.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Token, Tokens } from 'marked'
import DOMPurify from 'dompurify'
import { parseAskBody, type Ask } from '../../../shared/asks.ts'
import { askOf, commandOf, draftOf, isTask, segmentsOf, type Segment } from '../../../shared/blocks.ts'
import type { Anchor } from '../../../shared/types.ts'
import { marked, renderInline, renderText } from '../util.ts'
import { anchorFromRange, rangesFor, setHighlights } from '../anchoring.ts'
import { render as renderLive } from '../mdlive.ts'
import { addDraft, api, changed, dismissItem, draftsOf, markDone, removeDraft, setDoneText, state, uid, undismissItem, updateDraft, useStore, type AnswerDraft, type DoneDraft, type NoteDraft } from '../store.ts'
import type { TrackedItem } from '../items.ts'
import { RichInput, Thumbs } from './Inputs.tsx'
import { CheckIcon, CommentIcon, TerminalIcon, UndoIcon, XIcon } from './Icons.tsx'
import { EmojiPicker } from './EmojiPicker.tsx'
import { focusPassage, onPassage } from './Margin.tsx'
import { lastEmoji, topEmoji, usedEmoji } from '../emoji.ts'
import { highlight } from '../highlight.ts'

// The mark on a completed question or item.
const Done = ({ status }: { status: string }) =>
  status === 'answered' ? <span className="item-done ok" title="Answered"><CheckIcon size={13} /></span>
  : status === 'completed' ? <span className="item-done ok" title="Done"><CheckIcon size={13} /></span>
  : status === 'dismissed' ? <span className="item-done" title="Dismissed"><XIcon size={12} /></span>
  : null

type SectionPiece = { kind: 'answer' | 'details' | 'consider'; title: string; id: string; pieces: Piece[]; block: number; closed: boolean; task: boolean }
type Piece =
  | { kind: 'html'; html: string; block: number }
  | { kind: 'ask'; ask: Ask; block: number }
  | { kind: 'run'; title: string; command: string; block: number; closed: boolean }
  | SectionPiece

function piecesOf(text: string): Piece[] {
  // Block numbers run through the whole message; without sections they are the token indices.
  let base = 0, asks = 0, considers = 0, drafts = 0
  const walk = (segs: Segment[]): Piece[] => segs.flatMap((s): Piece[] => {
    if (!('text' in s)) {
      if (s.kind === 'ask') return [{ kind: 'ask', block: base++, ask: askOf(s, asks++) }]
      if (s.kind === 'draft') return [{ kind: 'ask', block: base++, ask: draftOf(s, drafts++) }]
      if (s.kind === 'run') return [{ kind: 'run', block: base++, title: s.title, command: commandOf(s), closed: s.closed }]
      const id = s.kind === 'consider' ? `c${++considers}` : ''
      return [{ kind: s.kind, title: s.title, id, block: base++, closed: s.closed, task: s.kind === 'consider' && isTask(s), pieces: walk(s.body) }]
    }
    const tokens = marked.lexer(s.text)
    // marked.parse would run the extensions' token pass (code highlighting); lexer + parser don't.
    if (marked.defaults.walkTokens) void marked.walkTokens(tokens, marked.defaults.walkTokens)
    const out: Piece[] = []
    tokens.forEach((t: Token, i) => {
      if (t.type === 'space') return
      if (t.type === 'code' && /^ask\b/.test((t as Tokens.Code).lang ?? '')) {
        const c = t as Tokens.Code
        out.push({ kind: 'ask', block: base + i, ask: parseAskBody(c.lang ?? '', c.text, asks++) })
        return
      }
      const list = Object.assign([t], { links: tokens.links })
      out.push({ kind: 'html', block: base + i, html: DOMPurify.sanitize(marked.parser(list) as string) })
    })
    base += tokens.length
    return out
  })
  return walk(segmentsOf(text))
}

// While streaming, a tag that is only half there yet stays hidden.
const trimPartialTag = (text: string) => text.replace(/\n\s*<\/?[a-z]*(\s[^>\n]*)?$/i, '')

export type Reaction = { anchor: Anchor; emoji: string; whole: boolean; quote: string }
type Props = { sid: string; msg: string; text: string; items?: Map<string, TrackedItem>; sent?: Anchor[]; reacts?: Reaction[]; live?: boolean }
// within: the item to consider that the content sits in.
type Ctx = { sid: string; msg: string; items: Map<string, TrackedItem>; live: boolean; within?: { key: string; label: string; status: string } }
const NO_ITEMS = new Map<string, TrackedItem>()

const NO_REACTS: Reaction[] = []
export const AssistantMessage = memo(function AssistantMessage({ sid, msg, text, items = NO_ITEMS, sent = [], reacts = NO_REACTS, live = false }: Props) {
  useStore()
  const pieces = useMemo(() => piecesOf(live ? trimPartialTag(text) : text), [text, live])
  const root = useRef<HTMLDivElement>(null)
  // Comments and reactions to a selection are highlighted; reactions to a whole paragraph are not.
  const notes = live ? [] : draftsOf(sid).filter((d): d is NoteDraft => d.kind === 'note' && d.anchor.msg === msg && !(d.whole && d.reaction))
  const drafted = live ? [] : draftsOf(sid).filter((d): d is NoteDraft => d.kind === 'note' && d.anchor.msg === msg && !!d.reaction)
  const noteKey = notes.map((n) => n.id + JSON.stringify(n.anchor.pieces)).join('|')
  const sentAll = [...sent, ...reacts.filter((r) => !r.whole).map((r) => r.anchor)]
  const sentKey = JSON.stringify(sentAll)

  useLayoutEffect(() => {
    const el = root.current
    if (!el || live) return
    setHighlights(`d:${sid}:${msg}`, 'draft', notes.flatMap((n) => rangesFor(n.anchor, el)))
    setHighlights(`s:${sid}:${msg}`, 'sent', sentAll.flatMap((a) => rangesFor(a, el)))
    return () => { setHighlights(`d:${sid}:${msg}`, 'draft', []); setHighlights(`s:${sid}:${msg}`, 'sent', []) }
  }, [noteKey, sentKey, pieces, sid, msg, live])
  useCodeCopy(root, live)

  return (
    <div className={`assistant-text md${live ? ' streaming' : ''}`} ref={root} {...(live ? {} : { 'data-msg': msg, 'data-sid': sid })}>
      <Pieces c={{ sid, msg, items, live }} pieces={pieces} />
      {!live && <LeftRail sid={sid} root={root} reacts={reacts} drafted={drafted} />}
    </div>
  )
})

// The middle of an element's first line of text, from the top of the message:
// reactions and the reaction button sit centred on it.
function lineMid(r: Range | null, root: HTMLElement): number | null {
  const box = r?.getClientRects()[0]
  return box ? Math.round(box.top + box.height / 2 - root.getBoundingClientRect().top) : null
}
const contentsOf = (el: HTMLElement) => { const r = document.createRange(); r.selectNodeContents(el); return r }

// Reactions sit at the left of their passage, one mark per passage; marks on
// one line form a row, the line's own (whole-paragraph) reaction nearest the
// text. The reaction button for the paragraph or list item level with the
// pointer sits on that mark, or left of the row if there is none, so nothing
// moves. Hovering a mark shows its passage; clicking one (or a selection's
// highlight) opens the comment card for that passage, where its reactions can
// be added to or taken off. A reaction inside an item to consider counts as a
// reply to it.
type RailItem = { key: string; anchor: Anchor; quote: string; whole: boolean; emoji: string[]; drafts: NoteDraft[] }
const keyOf = (a: Anchor) => JSON.stringify(a)

function LeftRail({ sid, root, reacts, drafted }: { sid: string; root: React.RefObject<HTMLDivElement | null>; reacts: Reaction[]; drafted: NoteDraft[] }) {
  const [rows, setRows] = useState<{ top: number; items: RailItem[] }[]>([])
  const [target, setTarget] = useState<{ el: HTMLElement; key: string; anchor: Anchor; top: number } | null>(null)
  const [row, setRow] = useState(false)
  const [search, setSearch] = useState(false)
  const busy = useRef(false)
  // From the press on, so a drag up to the row doesn't pass the target to the line above.
  const pressing = useRef(false)
  busy.current = row || search || pressing.current
  const targetRef = useRef(target)
  targetRef.current = target

  // ---- the marks
  const items = (() => {
    const by = new Map<string, RailItem>()
    const add = (anchor: Anchor, emoji: string, whole: boolean, quote: string, draft?: NoteDraft) => {
      const k = keyOf(anchor)
      const it = by.get(k) ?? { key: k, anchor, quote, whole, emoji: [], drafts: [] }
      if (!it.emoji.includes(emoji)) it.emoji.push(emoji)
      if (draft) it.drafts.push(draft)
      by.set(k, it)
    }
    for (const r of reacts) add(r.anchor, r.emoji, r.whole, r.quote)
    for (const d of drafted) add(d.anchor, d.text.trim(), !!d.whole, d.quote, d)
    return [...by.values()]
  })()
  const place = () => {
    const el = root.current
    if (!el) return
    const at = new Map<number, RailItem[]>()
    for (const it of items) {
      const top = lineMid(rangesFor(it.anchor, el)[0] ?? null, el)
      if (top != null) at.set(top, [...(at.get(top) ?? []), it])
    }
    const next = [...at].map(([top, its]) => ({ top, items: its.sort((a, b) => Number(b.whole) - Number(a.whole)) }))
    setRows((prev) => JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
  }
  const placeRef = useRef(place)
  placeRef.current = place
  useLayoutEffect(place)

  // Without room left of the text, a row's emoji pile up (overlap), just enough to stay clear of the sidebar.
  const pile = () => {
    const el = root.current, pane = el?.closest('.transcript')
    if (!el || !pane) return
    const min = pane.getBoundingClientRect().left + 4
    for (const r of el.querySelectorAll<HTMLElement>(':scope > .rail-row')) {
      r.style.removeProperty('--pile')
      const over = min - r.getBoundingClientRect().left
      const ems = r.querySelectorAll<HTMLElement>('.em + .em')
      if (over <= 0 || !ems.length) continue
      // At least a third of each emoji stays in view.
      r.style.setProperty('--pile', `${-Math.min(over / ems.length, ems[0].offsetWidth * 2 / 3)}px`)
    }
  }
  const pileRef = useRef(pile)
  pileRef.current = pile
  useLayoutEffect(pile)
  useEffect(() => {
    const ro = new ResizeObserver(() => { placeRef.current(); pileRef.current() })
    if (root.current) ro.observe(root.current)
    return () => ro.disconnect()
  }, [root])

  // ---- which paragraph or list item the pointer is level with
  useEffect(() => {
    const el = root.current
    const zone = el?.closest('.transcript-inner')
    if (!el || !zone) return
    let raf = 0
    const move = (e: MouseEvent) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (busy.current || (e.target as Element).closest?.('.rail-row')) return
        const r = el.getBoundingClientRect()
        if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left - 72 || e.clientX > r.right) { if (targetRef.current) setTarget(null); return }
        // The innermost one level with the pointer; between two, keep the last.
        let best: HTMLElement | null = null, h = Infinity
        for (const c of el.querySelectorAll<HTMLElement>('li, [data-block]')) {
          // A passage in a closed <details> is laid out on top of what follows it.
          if (c.closest('.ask-card, .run-card, details:not([open])')) continue
          const b = c.getBoundingClientRect()
          if (e.clientY >= b.top - 2 && e.clientY <= b.bottom + 2 && b.height < h) { best = c; h = b.height }
        }
        if (!best || best === targetRef.current?.el) return
        const anchor = anchorFromRange(contentsOf(best), el)
        const top = anchor && lineMid(rangesFor(anchor, el)[0] ?? null, el)
        if (anchor && top != null) setTarget({ el: best, key: keyOf(anchor), anchor, top })
      })
    }
    const leave = () => { if (!busy.current) setTarget(null) }
    zone.addEventListener('mousemove', move as EventListener)
    zone.addEventListener('mouseleave', leave)
    return () => { cancelAnimationFrame(raf); zone.removeEventListener('mousemove', move as EventListener); zone.removeEventListener('mouseleave', leave) }
  }, [root])

  // Clicking the highlight of a reaction to a selection opens a comment on it.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const click = (e: MouseEvent) => {
      if (!getSelection()?.isCollapsed) return
      const hit = itemsRef.current.find((it) => !it.whole && onPassage(rangesFor(it.anchor, el), e.clientX, e.clientY))
      if (hit) commentOn(hit.anchor, hit.quote, false)
    }
    el.addEventListener('click', click)
    return () => el.removeEventListener('click', click)
  }, [root])
  const itemsRef = useRef(items)
  itemsRef.current = items

  useEffect(() => {
    if (!row) return
    const down = (e: MouseEvent) => { if (!(e.target as Element).closest('.rail-row')) setRow(false) }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [row])

  // The item to consider a passage sits in, if any.
  const itemOf = (anchor: Anchor) => {
    const n = root.current && rangesFor(anchor, root.current)[0]?.startContainer
    return (n?.nodeType === 1 ? n as Element : n?.parentElement)?.closest<HTMLElement>('.consider[data-item]')?.dataset.item
  }
  const commentOn = (anchor: Anchor, quote: string, whole: boolean) => {
    focusPassage(sid, null)
    const k = keyOf(anchor)
    const open = draftsOf(sid).find((d): d is NoteDraft => d.kind === 'note' && !d.reaction && keyOf(d.anchor) === k)
    // Without a gutter the card shows only after the render that state.focus causes, so focus it on the next frame.
    if (open) { state.focus = open.id; changed(); requestAnimationFrame(() => document.querySelector<HTMLElement>(`.note-card[data-id="${open.id}"] .ri-edit`)?.focus()); return }
    const itemKey = itemOf(anchor)
    addDraft(sid, { id: uid(), kind: 'note', anchor, quote, text: '', images: [], createdAt: Date.now(), ...(whole ? { whole } : {}), ...(itemKey ? { itemKey } : {}) })
  }
  // The target's own reactions not sent yet, and toggling one.
  const mine = () => { const t = targetRef.current; return t ? draftsOf(sid).filter((d): d is NoteDraft => d.kind === 'note' && !!d.whole && keyOf(d.anchor) === t.key) : [] }
  const toggle = (emoji: string) => {
    const t = targetRef.current
    setRow(false); setSearch(false)
    if (emoji === '+') return setSearch(true)
    if (!t) return
    if (emoji === 'comment') return commentOn(t.anchor, t.el.innerText.trim(), true)
    if (emoji === 'remove') { for (const d of mine()) removeDraft(sid, d.id); return }
    const cur = mine().find((d) => d.text.trim() === emoji)
    if (cur) return removeDraft(sid, cur.id)
    usedEmoji(emoji)
    const itemKey = t.el.closest<HTMLElement>('.consider[data-item]')?.dataset.item
    addDraft(sid, { id: uid(), kind: 'note', anchor: t.anchor, quote: t.el.innerText.trim(), text: emoji, images: [], createdAt: Date.now(), reaction: true, whole: true, ...(itemKey ? { itemKey } : {}) })
    state.focus = null
  }
  const press = (e: React.PointerEvent) => {
    e.preventDefault()
    pressing.current = busy.current = true
    let held = false
    const y0 = e.clientY
    const open = () => { if (!held) { held = true; setRow(true) } }
    const timer = setTimeout(open, 300)
    const move = (m: PointerEvent) => { if (y0 - m.clientY > 4) open() }
    const up = (u: PointerEvent) => {
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointermove', move)
      clearTimeout(timer)
      pressing.current = false
      // A held press opened the row, which keeps it busy; a click did not.
      if (!held) busy.current = false
      if (!held) {
        // On a line with reactions, a click opens its comment card; on a bare line it adds your last emoji.
        const t = targetRef.current, own = t && itemsRef.current.find((it) => it.whole && it.key === t.key)
        return own ? commentOn(own.anchor, own.quote, true) : toggle(lastEmoji())
      }
      const over = (document.elementFromPoint(u.clientX, u.clientY) as Element | null)?.closest<HTMLElement>('[data-emoji]')
      if (over) toggle(over.dataset.emoji!)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  const all = target && !rows.some((r) => r.top === target.top) ? [...rows, { top: target.top, items: [] }] : rows
  // Only reactions that draw something: a stray variation selector or skin tone would show as an empty ring.
  const on = new Set(target ? mine().map((d) => d.text.trim()).filter((e) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(e)) : [])
  // The row and the remove button to its left stay right of the transcript's edge, clear of the sidebar.
  const pop = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = pop.current, pane = el?.closest('.transcript')
    if (!el || !pane) return
    el.style.left = ''
    const left = Math.min(...[...el.children].map((c) => c.getBoundingClientRect().left))
    const min = pane.getBoundingClientRect().left + 8
    if (left < min) el.style.left = `${el.offsetLeft + min - left}px`
  }, [row, on.size])
  return <>{all.map((r) => {
    const here = target?.top === r.top
    const own = here ? r.items.find((it) => it.key === target!.key) : undefined
    const ack = (
      <div key="ack" className="rail-ack">
        <button className={`ack-btn${on.size ? ' on' : ''}${own ? ' over' : ''}`} title={own ? 'Comment or change reactions (hold or drag up for more)' : 'React with last emoji (hold or drag up for more)'} onPointerDown={press}
          onMouseEnter={() => focusPassage(sid, own ? { anchor: own.anchor } : null)} onMouseLeave={() => focusPassage(sid, null)}>
          <span>{own ? own.emoji.map((e) => <span key={e} className="em">{e}</span>) : lastEmoji()}</span>
        </button>
        {row && (
          <div className="ack-pop" ref={pop}>
          {/* Takes your reactions off this paragraph: outside the row, so it can't be mistaken for an emoji. */}
          {on.size > 0 && <button className="ack-clear" data-emoji="remove" title="Remove your reactions" onClick={() => toggle('remove')}><XIcon size={14} /></button>}
          <div className="ack-row">
            {[...new Set([...on, ...topEmoji(8)])].slice(0, Math.max(8, on.size)).map((e) => <button key={e} data-emoji={e} className={on.has(e) ? 'on' : ''} title={on.has(e) ? `Remove ${e}` : `Add ${e}`} onClick={() => toggle(e)}>{e}</button>)}
            <button className="more-emoji" data-emoji="+" title="Search emoji" onClick={() => toggle('+')}>+</button>
            <button className="more-emoji" data-emoji="comment" title="Comment" onClick={() => toggle('comment')}><CommentIcon size={14} /></button>
          </div>
          </div>
        )}
        {search && <EmojiPicker onPick={toggle} onClose={() => setSearch(false)} />}
      </div>
    )
    return (
      <div key={r.top} className="rail-row" style={{ top: r.top }}>
        {r.items.map((it) => it === own ? ack : (
          <button
            key={it.key} className={`react-mark${it.drafts.length ? ' draft' : ''}`}
            onMouseEnter={() => focusPassage(sid, { anchor: it.anchor })} onMouseLeave={() => focusPassage(sid, null)}
            onClick={() => commentOn(it.anchor, it.quote, it.whole)}
          >{it.emoji.map((e) => <span key={e} className="em">{e}</span>)}</button>
        ))}
        {here && !own && ack}
      </div>
    )
  })}</>
}

// A selection here starts a comment, so inline code (a URL, a password, an id) is
// hard to copy by hand: a click copies it. Its cursor says so (styles.css).
function useCodeCopy(root: React.RefObject<HTMLDivElement | null>, live: boolean) {
  useEffect(() => {
    const el = root.current
    if (!el || live) return
    const click = (e: MouseEvent) => {
      const code = (e.target as Element).closest<HTMLElement>('code')
      // Not code blocks, not code in a link, and not the end of a drag that selected some of it.
      if (!code || code.closest('pre, a') || !el.contains(code) || !getSelection()?.isCollapsed) return
      void navigator.clipboard.writeText(code.textContent ?? '').then(() => {
        // A flash of the accent colour that fades.
        code.classList.add('copied')
        setTimeout(() => code.classList.remove('copied'), 150)
      })
    }
    el.addEventListener('click', click)
    return () => el.removeEventListener('click', click)
  }, [root, live])
}

function Pieces({ c, pieces }: { c: Ctx; pieces: Piece[] }) {
  return <>{pieces.map((p) => {
    switch (p.kind) {
      case 'html': return <div key={p.block} data-block={p.block} className="md-block" dangerouslySetInnerHTML={{ __html: p.html }} />
      case 'ask': return <AskCard key={p.block} c={c} ask={p.ask} />
      case 'answer': return <div key={p.block} className="answer-block"><Pieces c={c} pieces={p.pieces} /></div>
      case 'details': return (
        <details key={p.block} className="more">
          <summary dangerouslySetInnerHTML={{ __html: renderInline(p.title || 'More details') }} />
          <div className="more-body"><Pieces c={c} pieces={p.pieces} /></div>
        </details>
      )
      case 'consider': return <ConsiderCard key={p.block} c={c} p={p} />
      case 'run': return <RunCard key={p.block} c={c} card={`${c.msg}:${p.block}`} title={p.title} command={p.command} ready={p.closed && !c.live} />
    }
  })}</>
}

function ConsiderCard({ c, p }: { c: Ctx; p: SectionPiece }) {
  const key = `${c.msg}:${p.id}`
  const item = c.items.get(key)
  const status = c.live ? 'live' : item?.status ?? 'open'
  const title = p.title || 'Item'

  // Comment on the item: a margin card on its title, tied to the item.
  const comment = (e: React.MouseEvent) => {
    // A reaction in the item has no card to go to.
    const existing = draftsOf(c.sid).find((d): d is NoteDraft => d.kind === 'note' && d.itemKey === key && !d.reaction)
    if (existing) { document.querySelector<HTMLElement>(`.note-card[data-id="${existing.id}"] .ri-edit`)?.focus(); return }
    const card = (e.currentTarget as HTMLElement).closest('.consider')!
    const head = card.querySelector<HTMLElement>('.consider-title')!
    const msgEl = card.closest<HTMLElement>('[data-msg]')!
    const r = document.createRange()
    r.selectNodeContents(head)
    const anchor = anchorFromRange(r, msgEl)
    if (!anchor) return
    for (const d of draftsOf(c.sid)) if (d.kind === 'note' && !d.text.trim() && !d.images.length) removeDraft(c.sid, d.id)
    addDraft(c.sid, { id: uid(), kind: 'note', anchor, quote: head.textContent ?? title, text: '', images: [], createdAt: Date.now(), itemKey: key })
  }

  return (
    <div className={`consider st-${status}`} data-item={key}>
      <div className="consider-head">
        <div data-block={p.block} className="md-block consider-title" dangerouslySetInnerHTML={{ __html: renderInline(title) }} />
        {status === 'open' && <span className="item-actions"><button className="icon-btn" title="Dismiss" onClick={() => dismissItem(c.sid, key, title)}><XIcon size={13} /></button></span>}
        {(status === 'dismissing' || status === 'completing') && <span className="item-actions"><button className="icon-btn pop-in" title="Undo" onClick={() => undismissItem(c.sid, key)}><UndoIcon size={14} /></button></span>}
        <Done status={status} />
      </div>
      <div className="consider-body"><Pieces c={{ ...c, within: { key, label: title, status } }} pieces={p.pieces} /></div>
      {(status === 'open' || status === 'drafted') && (
        <div className="consider-foot">
          {p.task && <button className="reply-btn" onClick={() => markDone(c.sid, key, title)}><CheckIcon size={13} /> Done</button>}
          <button className="reply-btn item-reply" onMouseDown={(e) => e.preventDefault()} onClick={comment}><CommentIcon size={13} /> Reply</button>
        </div>
      )}
      {status === 'completing' && <DoneProblem sid={c.sid} itemKey={key} />}
    </div>
  )
}

// Marked done: room to say what went wrong, if anything.
function DoneProblem({ sid, itemKey }: { sid: string; itemKey: string }) {
  const d = draftsOf(sid).find((x): x is DoneDraft => x.kind === 'done' && x.key === itemKey)
  if (!d) return null
  return (
    <div className="done-problem">
      <button className="done-mark pop-in" title="Undo" onClick={() => undismissItem(sid, itemKey)}><CheckIcon size={12} /> Done</button>
      <input placeholder="Any problem?" value={d.text} onChange={(e) => setDoneText(sid, itemKey, e.target.value)} />
    </div>
  )
}

// A command Claude wants you to run: open it in a new Terminal window in the
// session's directory, or copy it.
function RunCard({ c, card, title, command, ready }: { c: Ctx; card: string; title: string; command: string; ready: boolean }) {
  const st = useStore()
  const [done, setDone] = useState('')
  const flash = (s: string) => { setDone(s); setTimeout(() => setDone(''), 2000) }
  const run = Object.values(st.runs).findLast((r) => r.sid === c.sid && r.card === card)
  return (
    <div className="run-card" onMouseUp={(e) => e.stopPropagation()}>
      {title && <div className="run-title" dangerouslySetInnerHTML={{ __html: renderInline(title) }} />}
      <pre className="hljs" dangerouslySetInnerHTML={{ __html: highlight(command, 'bash') }} />
      {ready && command && (
        <div className="run-actions">
          {st.platform === 'darwin' && (
            <button className="primary" onClick={() => api<{ token: string }>(`/api/sessions/${c.sid}/run`, 'POST', { command }).then(({ token }) => {
              state.runs[token] = { sid: c.sid, card, command, ...(c.within ? { item: { key: c.within.key, label: c.within.label } } : {}) }
              changed()
            })}>
              <TerminalIcon size={13} /> Run in Terminal
            </button>
          )}
          <button onClick={() => navigator.clipboard.writeText(command).then(() => flash('Copied'))}>Copy</button>
          {done && <span className="muted">{done}</span>}
          {run && !done && (run.code == null ? <span className="muted">Running in Terminal…</span>
            : <span className={run.code === 0 ? 'run-ok' : 'run-bad'}>{run.code === 0 ? <CheckIcon size={12} /> : <XIcon size={12} />} Exit code {run.code}</span>)}
        </div>
      )}
      {run?.tail && <details className="run-out"><summary>Output</summary><pre>{run.tail}</pre></details>}
    </div>
  )
}

// Text Claude drafted for you (a commit message, an email). Untouched, it stays
// open: Approve sends it back as it is (and greys it out), or edit it, and your
// edits go back. Edited, it offers only Restore (two clicks), which returns it
// to untouched, and a grey "Edited" that shows the original over the field
// while the pointer is on it.
function DraftCard({ c, ask, compact }: { c: Ctx; ask: Ask & { draft: string }; compact?: boolean }) {
  const askKey = `${c.msg}:${ask.id}`
  const item = c.items.get(askKey)
  const status = c.live ? 'live' : item?.status ?? 'open'
  const draft = draftsOf(c.sid).find((d): d is AnswerDraft => d.kind === 'answer' && d.askKey === askKey)
  const answer = item?.reply?.kind === 'answer' ? item.reply : undefined
  const attrs = compact ? {} : { 'data-item': askKey }
  const [confirm, setConfirm] = useState(false)
  const [peek, setPeek] = useState(false)
  useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(false), 4000); return () => clearTimeout(t) }, [confirm])
  const head = (mark: React.ReactNode) => (
    <div className="ask-row">
      <div className="ask-q draft-title" dangerouslySetInnerHTML={{ __html: renderInline(ask.question) }} />
      {mark}
    </div>
  )

  if (answer || (status !== 'open' && status !== 'drafted')) {
    const text = answer?.text ?? ask.draft
    return (
      <div className={`ask-card draft-card ${answer ? 'answered' : `st-${status}`}`} {...attrs} onMouseUp={(e) => e.stopPropagation()}>
        {head(<>
          {answer && <span className="muted draft-how">{answer.draft === 'edited' ? 'Edited' : 'Approved'}</span>}
          {status === 'dismissing' && <button className="icon-btn pop-in" title="Undo" onClick={() => undismissItem(c.sid, askKey)}><UndoIcon size={14} /></button>}
          <Done status={answer ? 'answered' : status} />
        </>)}
        {!compact && status !== 'dismissing' && status !== 'dismissed' && <div className="draft-text md" dangerouslySetInnerHTML={{ __html: renderText(text) }} />}
      </div>
    )
  }

  const patch = (p: Partial<AnswerDraft>) => {
    if (draft) updateDraft(c.sid, draft.id, p)
    else { state.drafts[c.sid] = [...draftsOf(c.sid), { id: uid(), kind: 'answer', askKey, question: ask.question, choices: [], text: ask.draft, images: [], createdAt: Date.now(), original: ask.draft, ...p }]; changed() }
  }
  const text = draft?.text ?? ask.draft
  const edited = text.trim() !== ask.draft.trim()
  const approved = !edited && !!draft?.approved
  return (
    <div className={`ask-card draft-card${approved || edited ? ' queued' : ''}${approved ? ' approved' : ''}`} {...attrs} onMouseUp={(e) => e.stopPropagation()}>
      {head(status === 'open' && <button className="icon-btn" title="Dismiss" onClick={() => dismissItem(c.sid, askKey, ask.question)}><XIcon size={13} /></button>)}
      {/* An edit ends an approval: the edits are what goes back. */}
      <div className="draft-field">
        <RichInput value={text} onChange={(t) => patch({ text: t, approved: false })} images={[]} onImages={() => {}} placeholder="Draft" minRows={2} />
        {edited && peek && <Original text={ask.draft} />}
      </div>
      <div className="draft-actions">
        {!edited && (
          <button className={`reply-btn draft-approve${approved ? ' on' : ''}`} title={approved ? 'Sends as is with your next message. Click to undo' : 'Send as is with your next message'} onClick={() => patch({ approved: !approved })}>
            <CheckIcon size={13} /> {approved ? 'Approved' : 'Approve'}
          </button>
        )}
        {edited && (
          <button className={`reply-btn${confirm ? ' draft-confirm' : ''}`} title="Restore Claude's original text" onClick={() => {
            if (!confirm) return setConfirm(true)
            setConfirm(false)
            if (draft) removeDraft(c.sid, draft.id)
          }}><UndoIcon size={13} /> {confirm ? 'Restore the original?' : 'Restore'}</button>
        )}
        {edited && <span className="muted draft-edited" onMouseEnter={() => setPeek(true)} onMouseLeave={() => setPeek(false)}>Edited</span>}
      </div>
    </div>
  )
}

// The original draft, drawn the way the field draws it, laid over the field.
function Original({ text }: { text: string }) {
  const el = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { renderLive(el.current!, text) }, [text])
  return <div ref={el} className="ri-edit draft-orig" />
}

export function AskCard({ c, ask, compact }: { c: Ctx; ask: Ask; compact?: boolean }) {
  return ask.draft != null ? <DraftCard c={c} ask={ask as Ask & { draft: string }} compact={compact} /> : <QuestionCard c={c} ask={ask} compact={compact} />
}

function QuestionCard({ c, ask, compact }: { c: Ctx; ask: Ask; compact?: boolean }) {
  const askKey = `${c.msg}:${ask.id}`
  const item = c.items.get(askKey)
  const status = c.live ? 'live' : item?.status ?? 'open'
  const draft = draftsOf(c.sid).find((d): d is AnswerDraft => d.kind === 'answer' && d.askKey === askKey)
  const question = useMemo(() => DOMPurify.sanitize(marked.parse(ask.question, { async: false }) as string), [ask.question])
  const answer = item?.reply?.kind === 'answer' ? item.reply : undefined
  const label = ask.question.split('\n')[0]
  const attrs = compact ? {} : { 'data-item': askKey }

  if (answer) {
    return (
      <div className="ask-card answered" {...attrs} onMouseUp={(e) => e.stopPropagation()}>
        <div className="ask-row">
          <div className="ask-q" dangerouslySetInnerHTML={{ __html: question }} />
          <Done status="answered" />
        </div>
        <div className="ask-answer">
          {answer.choices?.length ? <b>{answer.choices.join('; ')}</b> : null} {answer.text}
          <Thumbs images={answer.images} />
        </div>
      </div>
    )
  }
  if (status !== 'open' && status !== 'drafted') {
    return (
      <div className={`ask-card st-${status}`} {...attrs} onMouseUp={(e) => e.stopPropagation()}>
        <div className="ask-row">
          <div className="ask-q" dangerouslySetInnerHTML={{ __html: question }} />
          {status === 'dismissing' && <button className="icon-btn pop-in" title="Undo" onClick={() => undismissItem(c.sid, askKey)}><UndoIcon size={14} /></button>}
          <Done status={status} />
        </div>
        {status === 'live' && ask.options.length > 0 && <div className="ask-options">{ask.options.map((o) => <span key={o} className="chip static">{o}</span>)}</div>}
      </div>
    )
  }

  const choices = draft?.choices ?? []
  function patch(p: Partial<AnswerDraft>) {
    const list = draftsOf(c.sid)
    if (draft) updateDraft(c.sid, draft.id, p)
    else {
      state.drafts[c.sid] = [...list, { id: uid(), kind: 'answer', askKey, question: ask.question, choices: [], text: '', images: [], createdAt: Date.now(), ...p }]
      changed()
    }
  }
  const toggle = (o: string) => patch({ choices: choices.includes(o) ? choices.filter((x) => x !== o) : [...choices, o] })

  return (
    <div className={`ask-card${status === 'drafted' ? ' queued' : ''}`} {...attrs} onMouseUp={(e) => e.stopPropagation()}>
      <div className="ask-row">
        <div className="ask-q" dangerouslySetInnerHTML={{ __html: question }} />
        {status === 'open' && <button className="icon-btn" title="Dismiss" onClick={() => { if (draft) removeDraft(c.sid, draft.id); dismissItem(c.sid, askKey, label) }}><XIcon size={13} /></button>}
      </div>
      {ask.options.length > 0 && (
        <div className="ask-options">
          {ask.options.map((o) => <button key={o} className={`chip${choices.includes(o) ? ' on' : ''}`} onClick={() => toggle(o)}>{o}</button>)}
        </div>
      )}
      <RichInput
        value={draft?.text ?? ''}
        onChange={(text) => patch({ text })}
        images={draft?.images ?? []}
        onImages={(images) => patch({ images })}
        placeholder="Answer"
        minRows={1}
      />
    </div>
  )
}
