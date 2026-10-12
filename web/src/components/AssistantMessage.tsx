// One block of Claude's text, rendered markdown block by markdown block: each
// block is an anchoring root for comments (whose cards live in the margin, see
// Margin.tsx). The sections Claude marks (shared/blocks.ts) get their own
// treatment: <answer> stands out, <details> folds, <consider> items and <ask>
// questions each want a reply or a dismissal. With `live` (a reply still
// streaming) everything renders read-only and an unfinished section shows what
// has arrived.

import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import type { Token, Tokens } from 'marked'
import DOMPurify from 'dompurify'
import { parseAskBody, type Ask } from '../../../shared/asks.ts'
import { askOf, segmentsOf, type Segment } from '../../../shared/blocks.ts'
import type { Anchor } from '../../../shared/types.ts'
import { marked, renderInline } from '../util.ts'
import { anchorFromRange, rangesFor, setHighlights } from '../anchoring.ts'
import { addDraft, changed, dismissItem, draftsOf, removeDraft, state, uid, undismissItem, updateDraft, useStore, type AnswerDraft, type NoteDraft } from '../store.ts'
import type { TrackedItem } from '../items.ts'
import { RichInput, Thumbs } from './Inputs.tsx'
import { CheckIcon, CommentIcon, UndoIcon, XIcon } from './Icons.tsx'

// The mark on a completed question or item.
const Done = ({ status }: { status: string }) =>
  status === 'answered' ? <span className="item-done ok" title="Answered"><CheckIcon size={13} /></span>
  : status === 'dismissed' ? <span className="item-done" title="Dismissed"><XIcon size={12} /></span>
  : null

type SectionPiece = { kind: 'answer' | 'details' | 'consider'; title: string; id: string; pieces: Piece[]; block: number; closed: boolean }
type Piece =
  | { kind: 'html'; html: string; block: number }
  | { kind: 'ask'; ask: Ask; block: number }
  | SectionPiece

function piecesOf(text: string): Piece[] {
  // Block numbers run through the whole message; without sections they are the token indices.
  let base = 0, asks = 0, considers = 0
  const walk = (segs: Segment[]): Piece[] => segs.flatMap((s): Piece[] => {
    if (!('text' in s)) {
      if (s.kind === 'ask') return [{ kind: 'ask', block: base++, ask: askOf(s, asks++) }]
      const id = s.kind === 'consider' ? `c${++considers}` : ''
      return [{ kind: s.kind, title: s.title, id, block: base++, closed: s.closed, pieces: walk(s.body) }]
    }
    const tokens = marked.lexer(s.text)
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

type Props = { sid: string; msg: string; text: string; items?: Map<string, TrackedItem>; sent?: Anchor[]; live?: boolean }
type Ctx = { sid: string; msg: string; items: Map<string, TrackedItem>; live: boolean }
const NO_ITEMS = new Map<string, TrackedItem>()

export const AssistantMessage = memo(function AssistantMessage({ sid, msg, text, items = NO_ITEMS, sent = [], live = false }: Props) {
  useStore()
  const pieces = useMemo(() => piecesOf(live ? trimPartialTag(text) : text), [text, live])
  const root = useRef<HTMLDivElement>(null)
  const notes = live ? [] : draftsOf(sid).filter((d): d is NoteDraft => d.kind === 'note' && d.anchor.msg === msg)
  const noteKey = notes.map((n) => n.id + JSON.stringify(n.anchor.pieces)).join('|')
  const sentKey = JSON.stringify(sent)

  useLayoutEffect(() => {
    const el = root.current
    if (!el || live) return
    setHighlights(`d:${sid}:${msg}`, 'draft', notes.flatMap((n) => rangesFor(n.anchor, el)))
    setHighlights(`s:${sid}:${msg}`, 'sent', sent.flatMap((a) => rangesFor(a, el)))
    return () => { setHighlights(`d:${sid}:${msg}`, 'draft', []); setHighlights(`s:${sid}:${msg}`, 'sent', []) }
  }, [noteKey, sentKey, pieces, sid, msg, live])

  return (
    <div className={`assistant-text md${live ? ' streaming' : ''}`} ref={root} {...(live ? {} : { 'data-msg': msg, 'data-sid': sid })}>
      <Pieces c={{ sid, msg, items, live }} pieces={pieces} />
    </div>
  )
})

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
    if (existing) { document.querySelector<HTMLTextAreaElement>(`.note-card[data-id="${existing.id}"] textarea`)?.focus(); return }
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
        {(status === 'open' || status === 'drafted') && (
          <span className="item-actions">
            <button className="icon-btn" title="Comment" onMouseDown={(e) => e.preventDefault()} onClick={comment}><CommentIcon size={14} /></button>
            {status === 'open' && <button className="icon-btn" title="Dismiss" onClick={() => dismissItem(c.sid, key, title)}><XIcon size={13} /></button>}
          </span>
        )}
        {status === 'dismissing' && <span className="item-actions"><button className="icon-btn" title="Undo" onClick={() => undismissItem(c.sid, key)}><UndoIcon size={14} /></button></span>}
        <Done status={status} />
      </div>
      <div className="consider-body"><Pieces c={c} pieces={p.pieces} /></div>
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
