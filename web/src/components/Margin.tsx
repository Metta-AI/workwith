// Comment cards in the margin, the way Marginer lays them out: each card sits
// level with the first line of its highlight, cards that would overlap stack
// downward, and the focused card is pinned to its highlight, pushing its
// neighbours out of the way. When the transcript is too narrow for a gutter,
// cards sit under their highlight instead, over the text that follows.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { rangesFor, setHighlights } from '../anchoring.ts'
import { draftsOf, removeDraft, state, updateDraft, useStore, type NoteDraft } from '../store.ts'
import { RichInput } from './Inputs.tsx'
import { XIcon } from './Icons.tsx'

export const CARD_W = 272
export const GUTTER_GAP = 20
const GAP = 10

const isEmpty = (d: NoteDraft) => !d.text.trim() && !d.images.length

const msgEl = (sid: string, msg: string) => document.querySelector<HTMLElement>(`[data-sid="${sid}"][data-msg="${msg}"]`)
export const rangesOfNote = (sid: string, d: { anchor: NoteDraft['anchor'] }) => {
  const el = msgEl(sid, d.anchor.msg)
  return el ? rangesFor(d.anchor, el) : []
}

// Darken one comment's passage while its card (or its sent copy) is hovered or focused.
export function focusPassage(sid: string, d: { anchor: NoteDraft['anchor'] } | null) {
  setHighlights('focus', 'focus', d ? rangesOfNote(sid, d) : [])
}

type Props = { sid: string; inner: React.RefObject<HTMLDivElement | null>; column: React.RefObject<HTMLDivElement | null>; gutter: boolean }

export function Margin({ sid, inner, column, gutter }: Props) {
  useStore()
  const notes = draftsOf(sid).filter((d): d is NoteDraft => d.kind === 'note')
  const layer = useRef<HTMLDivElement>(null)
  const focused = useRef<string | null>(null)

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
      card.style.display = first ? '' : 'none'
      if (gutter) {
        card.style.left = `${cb.right - ib.left + GUTTER_GAP}px`
        card.style.width = `${Math.min(CARD_W, ib.right - cb.right - GUTTER_GAP - 12)}px`
      } else {
        card.style.left = `${cb.left - ib.left + 12}px`
        card.style.width = `${cb.width - 24}px`
      }
      const want = !first ? null : gutter ? first.top - ib.top - 6 : last!.bottom - ib.top + 6
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
    // Cards hanging below the last message make room for themselves.
    const min = bottom ? `${bottom + 40}px` : ''
    if (box.style.minHeight !== min) box.style.minHeight = min
  }
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  useLayoutEffect(() => layout())
  useEffect(() => {
    const ro = new ResizeObserver(() => layoutRef.current())
    if (inner.current) ro.observe(inner.current)
    if (layer.current) for (const c of layer.current.children) ro.observe(c)
    return () => ro.disconnect()
  }, [notes.length, gutter])

  // Highlights are painted, not elements, so hovering one is found by testing the
  // pointer against each comment's text boxes. The hovered comment's card lights
  // up and its passage darkens.
  const hovered = useRef<string | null>(null)
  useEffect(() => {
    const box = inner.current
    if (!box) return
    let raf = 0
    const set = (id: string | null) => {
      if (hovered.current === id) return
      hovered.current = id
      for (const c of layer.current?.children ?? []) c.classList.toggle('hover', (c as HTMLElement).dataset.id === id)
      const n = notesRef.current.find((x) => x.id === (id ?? focused.current))
      focusPassage(sid, n ?? null)
    }
    const move = (e: MouseEvent) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const t = e.target as Element | null
        if (t?.closest?.('.note-card')) return // the card handles its own hover
        if (!t?.closest?.('.assistant-text')) return set(null)
        const hit = notesRef.current.find((n) => rangesOfNote(sid, n).some((r) => [...r.getClientRects()].some((b) =>
          e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom)))
        set(hit?.id ?? null)
      })
    }
    const leave = () => set(null)
    box.addEventListener('mousemove', move)
    box.addEventListener('mouseleave', leave)
    return () => { cancelAnimationFrame(raf); box.removeEventListener('mousemove', move); box.removeEventListener('mouseleave', leave) }
  }, [sid])
  const notesRef = useRef(notes)
  notesRef.current = notes

  return (
    <div className="margin" ref={layer}>
      {notes.map((n) => (
        <NoteCard
          key={n.id} sid={sid} note={n}
          onFocus={() => { focused.current = n.id; layout(); focusPassage(sid, n) }}
          onBlur={() => { if (focused.current === n.id) focused.current = null; focusPassage(sid, null) }}
        />
      ))}
    </div>
  )
}

function NoteCard({ sid, note, onFocus, onBlur }: { sid: string; note: NoteDraft; onFocus(): void; onBlur(): void }) {
  const [focus] = useState(() => state.focus === note.id)
  useEffect(() => { if (state.focus === note.id) state.focus = null }, [note.id])
  const card = useRef<HTMLDivElement>(null)
  return (
    <div
      className={`note-card${isEmpty(note) ? ' empty' : ''}`}
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
    </div>
  )
}
