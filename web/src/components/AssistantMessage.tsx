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
import { askOf, commandOf, isTask, segmentsOf, type Segment } from '../../../shared/blocks.ts'
import type { Anchor } from '../../../shared/types.ts'
import { marked, renderInline } from '../util.ts'
import { anchorFromRange, rangesFor, setHighlights } from '../anchoring.ts'
import { addDraft, api, changed, dismissItem, draftsOf, markDone, removeDraft, setDoneText, state, uid, undismissItem, updateDraft, useStore, type AnswerDraft, type DoneDraft, type NoteDraft } from '../store.ts'
import type { TrackedItem } from '../items.ts'
import { RichInput, Thumbs } from './Inputs.tsx'
import { CheckIcon, CommentIcon, TerminalIcon, UndoIcon, XIcon } from './Icons.tsx'
import { EmojiPicker } from './EmojiPicker.tsx'
import { focusPassage } from './Margin.tsx'
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
  let base = 0, asks = 0, considers = 0
  const walk = (segs: Segment[]): Piece[] => segs.flatMap((s): Piece[] => {
    if (!('text' in s)) {
      if (s.kind === 'ask') return [{ kind: 'ask', block: base++, ask: askOf(s, asks++) }]
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
  const notes = live ? [] : draftsOf(sid).filter((d): d is NoteDraft => d.kind === 'note' && d.anchor.msg === msg && !d.whole)
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

  return (
    <div className={`assistant-text md${live ? ' streaming' : ''}`} ref={root} {...(live ? {} : { 'data-msg': msg, 'data-sid': sid })}>
      <Pieces c={{ sid, msg, items, live }} pieces={pieces} />
      {!live && <LeftRail sid={sid} root={root} reacts={reacts} drafted={drafted} />}
    </div>
  )
})

// The top of an element's first line of text, from the top of the message:
// reactions and the reaction button sit level with it.
function lineTop(r: Range | null, root: HTMLElement): number | null {
  const box = r?.getClientRects()[0]
  return box ? Math.round(box.top - root.getBoundingClientRect().top) : null
}
const contentsOf = (el: HTMLElement) => { const r = document.createRange(); r.selectNodeContents(el); return r }

// Reactions sit at the left of their passage, one mark per passage; marks on
// one line form a row, the line's own (whole-paragraph) reaction nearest the
// text. The reaction button for the paragraph or list item level with the
// pointer sits on that mark, or left of the row if there is none, so nothing
// moves. Hovering a mark shows its passage; clicking a selection's mark (or
// its highlight) opens a comment on that passage.
type RailItem = { key: string; anchor: Anchor; quote: string; whole: boolean; emoji: string[]; drafts: NoteDraft[] }
const keyOf = (a: Anchor) => JSON.stringify(a)

function LeftRail({ sid, root, reacts, drafted }: { sid: string; root: React.RefObject<HTMLDivElement | null>; reacts: Reaction[]; drafted: NoteDraft[] }) {
  const [rows, setRows] = useState<{ top: number; items: RailItem[] }[]>([])
  const [target, setTarget] = useState<{ el: HTMLElement; key: string; anchor: Anchor; top: number } | null>(null)
  const [row, setRow] = useState(false)
  const [search, setSearch] = useState(false)
  const busy = useRef(false)
  busy.current = row || search
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
      const top = lineTop(rangesFor(it.anchor, el)[0] ?? null, el)
      if (top != null) at.set(top, [...(at.get(top) ?? []), it])
    }
    const next = [...at].map(([top, its]) => ({ top, items: its.sort((a, b) => Number(b.whole) - Number(a.whole)) }))
    setRows((prev) => JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
  }
  const placeRef = useRef(place)
  placeRef.current = place
  useLayoutEffect(place)
  useEffect(() => {
    const ro = new ResizeObserver(() => placeRef.current())
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
          if (c.closest('.ask-card, .run-card')) continue
          const b = c.getBoundingClientRect()
          if (e.clientY >= b.top - 2 && e.clientY <= b.bottom + 2 && b.height < h) { best = c; h = b.height }
        }
        if (!best || best === targetRef.current?.el) return
        const anchor = anchorFromRange(contentsOf(best), el)
        const top = anchor && lineTop(rangesFor(anchor, el)[0] ?? null, el)
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
      const hit = itemsRef.current.find((it) => !it.whole && rangesFor(it.anchor, el).some((r) => [...r.getClientRects()].some((b) =>
        e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom)))
      if (hit) commentOn(hit.anchor, hit.quote)
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

  const commentOn = (anchor: Anchor, quote: string) => {
    focusPassage(sid, null)
    const k = keyOf(anchor)
    const open = draftsOf(sid).find((d): d is NoteDraft => d.kind === 'note' && !d.reaction && keyOf(d.anchor) === k)
    if (open) { state.focus = open.id; changed(); document.querySelector<HTMLElement>(`.note-card[data-id="${open.id}"] .ri-edit`)?.focus(); return }
    addDraft(sid, { id: uid(), kind: 'note', anchor, quote, text: '', images: [], createdAt: Date.now() })
  }
  // The target's own reactions not sent yet, and toggling one.
  const mine = () => { const t = targetRef.current; return t ? draftsOf(sid).filter((d): d is NoteDraft => d.kind === 'note' && !!d.whole && keyOf(d.anchor) === t.key) : [] }
  const toggle = (emoji: string) => {
    const t = targetRef.current
    setRow(false); setSearch(false)
    if (emoji === '+') return setSearch(true)
    if (!t) return
    if (emoji === 'comment') return commentOn(t.anchor, t.el.innerText.trim())
    const cur = mine().find((d) => d.text.trim() === emoji)
    if (cur) return removeDraft(sid, cur.id)
    usedEmoji(emoji)
    addDraft(sid, { id: uid(), kind: 'note', anchor: t.anchor, quote: t.el.innerText.trim(), text: emoji, images: [], createdAt: Date.now(), reaction: true, whole: true })
    state.focus = null
  }
  const press = (e: React.PointerEvent) => {
    e.preventDefault()
    let held = false
    const y0 = e.clientY
    const open = () => { if (!held) { held = true; setRow(true) } }
    const timer = setTimeout(open, 300)
    const move = (m: PointerEvent) => { if (y0 - m.clientY > 4) open() }
    const up = (u: PointerEvent) => {
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointermove', move)
      clearTimeout(timer)
      if (!held) return toggle(lastEmoji())
      const over = (document.elementFromPoint(u.clientX, u.clientY) as Element | null)?.closest<HTMLElement>('[data-emoji]')
      if (over) toggle(over.dataset.emoji!)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  const all = target && !rows.some((r) => r.top === target.top) ? [...rows, { top: target.top, items: [] }] : rows
  const on = new Set(target ? mine().map((d) => d.text.trim()) : [])
  return <>{all.map((r) => {
    const here = target?.top === r.top
    const own = here ? r.items.find((it) => it.key === target!.key) : undefined
    const ack = (
      <div key="ack" className="rail-ack">
        <button className={`ack-btn${on.size ? ' on' : ''}${own ? ' over' : ''}`} title="React (click for your last emoji; hold or drag up for more)" onPointerDown={press}
          onMouseEnter={() => focusPassage(sid, own ? { anchor: own.anchor } : null)} onMouseLeave={() => focusPassage(sid, null)}>
          <span>{own ? own.emoji.join('') : lastEmoji()}</span>
        </button>
        {row && (
          <div className="ack-row">
            {topEmoji(6).map((e) => <button key={e} data-emoji={e} className={on.has(e) ? 'on' : ''} onClick={() => toggle(e)}>{e}</button>)}
            <button className="more-emoji" data-emoji="+" title="Search emoji" onClick={() => toggle('+')}>+</button>
            <button className="more-emoji" data-emoji="comment" title="Comment on this" onClick={() => toggle('comment')}><CommentIcon size={14} /></button>
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
            onClick={() => it.whole ? undefined : commentOn(it.anchor, it.quote)}
          >{it.emoji.join('')}</button>
        ))}
        {here && !own && ack}
      </div>
    )
  })}</>
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
    const existing = draftsOf(c.sid).find((d): d is NoteDraft => d.kind === 'note' && d.itemKey === key)
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
        {(status === 'dismissing' || status === 'completing') && <span className="item-actions"><button className="icon-btn" title="Undo" onClick={() => undismissItem(c.sid, key)}><UndoIcon size={14} /></button></span>}
        <Done status={status} />
      </div>
      <div className="consider-body"><Pieces c={{ ...c, within: { key, label: title, status } }} pieces={p.pieces} /></div>
      {(status === 'open' || status === 'drafted') && (
        <div className="consider-foot">
          {p.task && <button className="reply-btn" onClick={() => markDone(c.sid, key, title)}><CheckIcon size={13} /> Done</button>}
          <button className="reply-btn" onMouseDown={(e) => e.preventDefault()} onClick={comment}><CommentIcon size={13} /> Reply</button>
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
      <span className="done-mark"><CheckIcon size={12} /> Done</span>
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

export function AskCard({ c, ask, compact }: { c: Ctx; ask: Ask; compact?: boolean }) {
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
          {status === 'dismissing' && <button className="icon-btn" title="Undo" onClick={() => undismissItem(c.sid, askKey)}><UndoIcon size={14} /></button>}
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
