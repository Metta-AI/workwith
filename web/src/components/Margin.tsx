// Comment cards in the margin, the way Marginer lays them out: each card sits
// level with the first line of its highlight, cards that would overlap stack
// downward, and the focused card is pinned to its highlight, pushing its
// neighbours out of the way. When the transcript is too narrow for a gutter,
// a card shows only while you write in it, after you click its highlight, or
// while you hover the highlight: under the highlight's last line, centred on
// it, over the text that follows.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { rangesFor, setHighlights } from '../anchoring.ts'
import { addDraft, draftsOf, removeDraft, state, uid, updateDraft, useStore, type NoteDraft } from '../store.ts'
import type { Anchor, Event, ImageRef } from '../../../shared/types.ts'
import { isReaction, topEmoji, usedEmoji } from '../emoji.ts'
import { holdKeyboard, renderMd, visibleBox } from '../util.ts'
import { EmojiPicker } from './EmojiPicker.tsx'
import { focusField, RichInput, Thumbs } from './Inputs.tsx'
import { XIcon } from './Icons.tsx'
import { TextDialog, WithPastes } from './Paste.tsx'

export const CARD_W = 272
export const GUTTER_GAP = 20
const GAP = 10

const isEmpty = (d: NoteDraft) => !d.text.trim() && !d.images.length

const msgEl = (sid: string, msg: string) => document.querySelector<HTMLElement>(`[data-sid="${sid}"][data-msg="${msg}"]`)
export const rangesOfNote = (sid: string, d: { anchor: NoteDraft['anchor'] }) => {
  const el = msgEl(sid, d.anchor.msg)
  return el ? rangesFor(d.anchor, el) : []
}

// Is the point on the passage? Each line's box reaches down to the next line of
// the passage, so the gap between two lines counts as on it.
export function onPassage(ranges: Range[], x: number, y: number) {
  const rects = ranges.flatMap((r) => [...r.getClientRects()]).sort((a, b) => a.top - b.top)
  return rects.some((b, i) => {
    const next = rects.slice(i + 1).find((n) => n.top >= b.bottom)
    const bottom = next && next.top - b.bottom < b.height ? next.top : b.bottom
    return x >= b.left && x <= b.right && y >= b.top && y <= bottom
  })
}

// Darken one comment's passage while its card (or its sent copy) is hovered or focused.
export function focusPassage(sid: string, d: { anchor: NoteDraft['anchor'] } | null) {
  setHighlights('focus', 'focus', d ? rangesOfNote(sid, d) : [])
}

type Props = { sid: string; inner: React.RefObject<HTMLDivElement | null>; column: React.RefObject<HTMLDivElement | null>; gutter: boolean; events: Event[] }

// What the margin shows: comments being written, comments already sent (read
// only), and reactions (an emoji alone), as small badges.
type Entry = { id: string; anchor: Anchor; kind: 'draft' | 'sent' | 'badge'; text: string; images?: ImageRef[]; draft?: NoteDraft }

function sentEntries(events: Event[]): Entry[] {
  const out: Entry[] = []
  for (const e of events) {
    if (e.t !== 'user') continue
    e.parts.forEach((p, i) => {
      // A reply to a whole item (the lead's) has no passage to sit beside.
      if (p.kind !== 'note' || !p.anchor.pieces.length) return
      // Reactions show beside their passage (AssistantMessage).
      if (isReaction(p.text) && !p.images?.length) return
      out.push({ id: `s${e.seq}.${i}`, anchor: p.anchor, kind: 'sent', text: p.text, images: p.images })
    })
  }
  return out
}

export function Margin({ sid, inner, column, gutter, events }: Props) {
  useStore()
  const drafts = draftsOf(sid).filter((d): d is NoteDraft => d.kind === 'note')
  const notes: Entry[] = [
    ...sentEntries(events),
    ...drafts.filter((d) => !d.reaction).map((d): Entry => ({ id: d.id, anchor: d.anchor, kind: 'draft', text: d.text, images: d.images, draft: d })),
  ]
  const layer = useRef<HTMLDivElement>(null)
  const focused = useRef<string | null>(null)
  // Without a gutter: the one card showing.
  const [open, setOpen] = useState<string | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  // Without a gutter: the card of the highlight under the pointer. It goes one frame after the pointer leaves; a click keeps it open.
  const [peek, setPeek] = useState<string | null>(null)
  const peekRef = useRef(peek)
  peekRef.current = peek

  const layout = () => {
    const box = inner.current, col = column.current, el = layer.current
    if (!box || !col || !el) return
    const ib = box.getBoundingClientRect()
    const cb = col.getBoundingClientRect()
    const cards = [...el.children] as HTMLElement[]
    const items = cards.map((card) => {
      const d = notes.find((n) => n.id === card.dataset.id)
      const ranges = d ? rangesOfNote(sid, d) : []
      const first = ranges[0]?.getClientRects()[0]
      const lastRects = ranges.at(-1)?.getClientRects()
      const last = lastRects?.[lastRects.length - 1]
      const badge = card.classList.contains('react-badge')
      // A new card (state.focus) shows at once, so that it can take the focus.
      const hidden = !first || (!gutter && !badge && ![openRef.current, peekRef.current, state.focus].includes(card.dataset.id!))
      card.style.display = hidden ? 'none' : ''
      if (hidden) return { card, want: null, h: 0, id: card.dataset.id }
      if (gutter) {
        card.style.left = `${cb.right - ib.left + GUTTER_GAP}px`
        if (!badge) card.style.width = `${Math.min(CARD_W, ib.right - cb.right - GUTTER_GAP - 12)}px`
      } else if (badge) {
        card.style.left = `${cb.right - ib.left + 2}px`
      } else {
        // Centred on the highlight's last line, inside the column.
        const w = Math.min(CARD_W, cb.width - 8)
        const mid = (last!.left + last!.right) / 2 - ib.left
        card.style.width = `${w}px`
        card.style.left = `${Math.max(cb.left - ib.left + 4, Math.min(mid - w / 2, cb.right - ib.left - w - 4))}px`
      }
      const want = gutter || badge ? first!.top - ib.top - 6 : last!.bottom - ib.top + 6
      return { card, want, h: card.offsetHeight, id: card.dataset.id }
    }).filter((it) => it.want != null)
    items.sort((a, b) => a.want! - b.want!)
    const top: number[] = []
    let y = -Infinity
    items.forEach((it, i) => { top[i] = Math.max(it.want!, y + GAP); y = top[i] + it.h })
    const f = items.findIndex((it) => it.id === focused.current)
    if (f >= 0) {
      top[f] = items[f].want!
      for (let i = f - 1; i >= 0; i--) top[i] = Math.min(top[i], top[i + 1] - GAP - items[i].h)
      for (let i = f + 1; i < items.length; i++) top[i] = Math.max(items[i].want!, top[i - 1] + items[i - 1].h + GAP)
    }
    let bottom = 0
    items.forEach((it, i) => {
      it.card.style.top = `${Math.max(0, top[i])}px`
      bottom = Math.max(bottom, Math.max(0, top[i]) + it.h)
    })
    // Cards hanging below the last message make room for themselves, with space to spare.
    const min = bottom ? `${bottom + 96}px` : ''
    if (box.style.minHeight !== min) box.style.minHeight = min
  }
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  // The card you write in stays in view as it grows, and when the keyboard comes up: the transcript scrolls to show all of it.
  // So does a card you open.
  const keepInView = () => {
    const card = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.note-card')
      ?? (openRef.current ? layer.current?.querySelector<HTMLElement>(`.note-card[data-id="${CSS.escape(openRef.current)}"]`) : null)
    const sc = inner.current?.closest<HTMLElement>('.transcript')
    if (!card || !sc || !layer.current?.contains(card)) return
    const over = card.getBoundingClientRect().bottom + 8 - Math.min(sc.getBoundingClientRect().bottom, visibleBox().bottom)
    if (over > 0) sc.scrollTop += over
  }

  useLayoutEffect(() => layout())
  useEffect(() => {
    const ro = new ResizeObserver(() => { layoutRef.current(); keepInView() })
    if (inner.current) ro.observe(inner.current)
    if (layer.current) for (const c of layer.current.children) ro.observe(c)
    visualViewport?.addEventListener('resize', keepInView)
    return () => { ro.disconnect(); visualViewport?.removeEventListener('resize', keepInView) }
  }, [notes.length, gutter])
  useEffect(() => { layoutRef.current() }, [events, open, peek])
  useEffect(() => { if (open) keepInView() }, [open])

  // A click on a highlight puts the caret in its card (and without a gutter, shows the card).
  useEffect(() => {
    const box = inner.current
    if (!box) return
    const click = (e: MouseEvent) => {
      if (!getSelection()?.isCollapsed || (e.target as Element).closest?.('.note-card')) return
      const hit = notesRef.current.find((n) => n.kind === 'draft' && onPassage(rangesOfNote(sid, n), e.clientX, e.clientY))
      if (!hit) return
      holdKeyboard()
      setOpen(hit.id)
      requestAnimationFrame(() => focusField(layer.current?.querySelector<HTMLElement>(`.note-card[data-id="${hit.id}"] .ri-edit`)))
    }
    box.addEventListener('click', click)
    return () => box.removeEventListener('click', click)
  }, [sid, gutter])

  // Highlights are painted, not elements, so hovering one is found by testing the
  // pointer against each comment's text boxes. The hovered comment's card lights
  // up and its passage darkens.
  const hovered = useRef<string | null>(null)
  useEffect(() => {
    const box = inner.current
    if (!box) return
    let raf = 0, timer = 0
    const show = (id: string | null) => {
      clearTimeout(timer)
      if (id) setPeek(id)
      else timer = window.setTimeout(() => setPeek(null), 16)
    }
    const set = (id: string | null) => {
      if (hovered.current === id) return
      hovered.current = id
      for (const c of layer.current?.children ?? []) c.classList.toggle('hover', (c as HTMLElement).dataset.id === id)
      const n = notesRef.current.find((x) => x.id === (id ?? focused.current))
      focusPassage(sid, n ?? null)
    }
    // Without a gutter, the gap between a highlight and the card under it counts as on the highlight.
    const bridge = (x: number, y: number) => {
      const n = !gutter && notesRef.current.find((d) => d.id === peekRef.current)
      const card = n && layer.current?.querySelector<HTMLElement>(`.note-card[data-id="${n.id}"]`)
      if (!n || !card || card.style.display === 'none') return null
      const b = card.getBoundingClientRect()
      const bottom = Math.max(...rangesOfNote(sid, n).flatMap((r) => [...r.getClientRects()].map((c) => c.bottom)))
      return x >= b.left && x <= b.right && y >= bottom && y <= b.top ? n.id : null
    }
    const move = (e: MouseEvent) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const t = e.target as Element | null
        const card = t?.closest?.<HTMLElement>('.note-card')
        if (card) return show(card.dataset.id ?? null) // the card handles its own hover
        const gap = bridge(e.clientX, e.clientY)
        if (gap) { show(gap); return set(gap) }
        if (!t?.closest?.('.assistant-text')) { show(null); return set(null) }
        const hit = notesRef.current.find((n) => onPassage(rangesOfNote(sid, n), e.clientX, e.clientY))
        show(hit?.id ?? null)
        set(hit?.id ?? null)
      })
    }
    const leave = () => { show(null); set(null) }
    box.addEventListener('mousemove', move)
    box.addEventListener('mouseleave', leave)
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); box.removeEventListener('mousemove', move); box.removeEventListener('mouseleave', leave) }
  }, [sid, gutter])
  const notesRef = useRef(notes)
  notesRef.current = notes
  // Without a gutter, a touch or click outside the open card puts it away at once: its field
  // may not have the focus, so no blur would take it away.
  useEffect(() => {
    if (gutter || !open) return
    const away = (e: PointerEvent) => {
      const card = layer.current?.querySelector<HTMLElement>(`.note-card[data-id="${open}"]`), t = e.target as Element
      if (!card || card.contains(t) || t.closest?.('.emoji-picker, .rail-row')) return
      if (card.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
      if (state.focus === open) state.focus = null
      setOpen(null)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open, gutter])

  return (
    <div className="margin" ref={layer}>
      {notes.map((n) => n.kind === 'draft' ? (
        <NoteCard
          key={n.id} sid={sid} note={n.draft!} onOpen={() => setOpen(n.id)}
          onFocus={() => { if (state.focus === n.id) state.focus = null; focused.current = n.id; setOpen(n.id); layout(); keepInView(); focusPassage(sid, n) }}
          onBlur={() => {
            if (focused.current === n.id) focused.current = null
            focusPassage(sid, null)
            // Without a gutter, the card goes once the focus has left it.
            setTimeout(() => { if (!layer.current?.querySelector(`.note-card[data-id="${n.id}"]`)?.contains(document.activeElement)) setOpen((o) => o === n.id ? null : o) }, 250)
          }}
        />
      ) : n.kind === 'badge' ? (
        <button
          key={n.id} data-id={n.id} className={`react-badge${n.draft ? ' draft' : ''}`}
          onMouseEnter={() => focusPassage(sid, n)} onMouseLeave={() => focusPassage(sid, null)}
          onClick={() => { if (n.draft) { focusPassage(sid, null); removeDraft(sid, n.id) } }}
        >{n.text.trim()}</button>
      ) : (
        <SentCard key={n.id} sid={sid} n={n} />
      ))}
    </div>
  )
}

// A long comment folds to its first lines. "Show more" opens it in place or, when it is
// very long, in a dialog: in place it would push the cards under it far down.
function SentCard({ sid, n }: { sid: string; n: Entry }) {
  const body = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<'short' | 'long' | 'huge'>('short')
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState(false)
  useLayoutEffect(() => {
    const box = body.current, inner = box?.firstElementChild
    if (!box || !inner || open) return
    // A comment folds only when the fold hides a fair part of it, not a line or two.
    const ro = new ResizeObserver(() => {
      const h = inner.scrollHeight / parseFloat(getComputedStyle(box).fontSize)
      setSize(h > 40 ? 'huge' : h > 14 ? 'long' : 'short')
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [open])
  const text = <><WithPastes text={n.text} render={renderMd} sid={sid} /><Thumbs images={n.images} /></>
  return (
    <div data-id={n.id} className="note-card sent" onMouseEnter={() => focusPassage(sid, n)} onMouseLeave={() => focusPassage(sid, null)}>
      <div ref={body} className={`note-fold${size !== 'short' ? ' long' : ''}${open ? ' open' : ''}`}><div>{text}</div></div>
      {size !== 'short' && (
        <button className="link note-more" onClick={() => size === 'huge' ? setDialog(true) : setOpen(!open)}>{open ? 'Show less' : size === 'huge' ? 'Show all' : 'Show more'}</button>
      )}
      {dialog && <TextDialog title="Comment" onClose={() => setDialog(false)}><div className="comment-full">{text}</div></TextDialog>}
    </div>
  )
}

function NoteCard({ sid, note, onOpen, onFocus, onBlur }: { sid: string; note: NoteDraft; onOpen(): void; onFocus(): void; onBlur(): void }) {
  const [focus] = useState(() => state.focus === note.id)
  const card = useRef<HTMLDivElement>(null)
  // A new card stays open even if the focus misses it, as a phone allows a focus only in a touch
  // handler (a selection can end with none). Then a touch elsewhere takes it away while empty.
  useEffect(() => {
    if (state.focus !== note.id) return
    state.focus = null
    onOpen()
    const away = (e: PointerEvent) => {
      if (card.current?.contains(e.target as Node) || card.current?.contains(document.activeElement)) return
      document.removeEventListener('pointerdown', away)
      const d = draftsOf(sid).find((x) => x.id === note.id) as NoteDraft | undefined
      if (d && isEmpty(d)) removeDraft(sid, note.id)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [note.id])
  // A comment of more than one line moves its image button down under the X (data-multi), so its
  // text can use that width. It counts the lines with the button at the top, else a line that fits
  // only without the button would change the state again and again.
  const measure = () => {
    const el = card.current, ed = el?.querySelector<HTMLElement>('.ri-edit')
    if (!el || !ed) return
    el.removeAttribute('data-multi')
    el.toggleAttribute('data-multi', ed.scrollHeight > 30)
  }
  useLayoutEffect(measure, [note.text])
  // An image that loads, or a new width of the card, can change the lines.
  useEffect(() => {
    const el = card.current!
    let width = el.offsetWidth, frame = 0
    el.addEventListener('load', measure, true)
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth === width) return
      width = el.offsetWidth
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    ro.observe(el)
    return () => { el.removeEventListener('load', measure, true); ro.disconnect(); cancelAnimationFrame(frame) }
  }, [])
  const [picking, setPicking] = useState(false)
  // The passage's reactions (not sent yet), which the emoji row shows first, on.
  const k = JSON.stringify(note.anchor)
  const reactions = draftsOf(sid).filter((d): d is NoteDraft => d.kind === 'note' && !!d.reaction && !!d.whole === !!note.whole && JSON.stringify(d.anchor) === k)
  const on = [...new Set(reactions.map((d) => d.text.trim()))]
  // An emoji from the row is a reaction, never text in the comment: a click on one that is on takes it
  // off, any other adds it. The card stays, with the caret in it, so you can add words; left empty, it
  // goes as usual and only the reaction stays.
  const react = (r: string) => {
    if (on.includes(r)) for (const d of reactions) { if (d.text.trim() === r) removeDraft(sid, d.id) }
    else {
      usedEmoji(r)
      addDraft(sid, { ...note, id: uid(), text: r, images: [], reaction: true, createdAt: Date.now() })
      state.focus = null
    }
    const ed = card.current?.querySelector<HTMLElement>('.ri-edit')
    if (ed && document.activeElement !== ed) focusField(ed)
  }
  return (
    <div
      className={`note-card${isEmpty(note) ? ' blank' : ''}`}
      data-id={note.id}
      ref={card}
      onFocus={onFocus}
      onMouseEnter={() => focusPassage(sid, note)}
      onMouseLeave={() => { if (!card.current?.contains(document.activeElement)) focusPassage(sid, null) }}
      onBlur={() => {
        onBlur()
        // Clicked away from an empty comment: it leaves no trace. (Not while a
        // file dialog has the focus, or while focus just moved within the card.)
        setTimeout(() => {
          const d = draftsOf(sid).find((x) => x.id === note.id) as NoteDraft | undefined
          if (d && isEmpty(d) && document.hasFocus() && !card.current?.contains(document.activeElement)) removeDraft(sid, note.id)
        }, 200)
      }}
    >
      <button className="card-x" title="Discard" onMouseDown={(e) => e.preventDefault()} onClick={() => { focusPassage(sid, null); removeDraft(sid, note.id) }}><XIcon size={12} /></button>
      <RichInput
        value={note.text}
        onChange={(text) => updateDraft(sid, note.id, { text })}
        images={note.images}
        onImages={(images) => updateDraft(sid, note.id, { images })}
        placeholder="Comment"
        autoFocus={focus}
        minRows={1}
        onEscape={() => { if (isEmpty(note)) removeDraft(sid, note.id); else (document.activeElement as HTMLElement | null)?.blur() }}
      />
      {/* The emoji keep the focus in the comment; the picker's search field can take it. */}
      <div className="reactions" onMouseDown={(e) => { if (!(e.target as Element).closest('input')) e.preventDefault() }}>
        {/* The passage's reactions first, whatever they are, then your most used. */}
        {[...new Set([...on, ...topEmoji(8)])].slice(0, Math.max(8, on.length)).map((r) => (
          <button key={r} className={on.includes(r) ? 'on' : ''} onClick={() => react(r)}>{r}</button>
        ))}
        <button className="more-emoji" onClick={() => setPicking(true)}>+</button>
        {picking && <EmojiPicker onPick={(r) => { react(r); setPicking(false) }} onClose={() => setPicking(false)} />}
      </div>
    </div>
  )
}
