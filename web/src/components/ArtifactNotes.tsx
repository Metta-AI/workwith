// Comments on an artifact in the preview pane. The page runs on another origin, so a script
// in it (web/src/frame/notes.ts) finds what you select or click, paints the highlights, and
// says where each one is; this layer over the frame draws the cards, as the margin does for
// comments on messages when there is no gutter: a card shows under its highlight while you
// write in it, after you click the highlight, or while the pointer is on the highlight. The
// comments go with your next message, as comments on messages do (store.ts queuedParts).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { addDraft, draftsOf, removeDraft, state, uid, useStore, type ArtDraft } from '../store.ts'
import { isReaction } from '../emoji.ts'
import { focusField } from './Inputs.tsx'
import { CARD_W, NoteCard } from './Margin.tsx'

type Box = { left: number; top: number; right: number; bottom: number; last: { left: number; right: number; bottom: number } }
type FromFrame =
  | { t: 'ready' }
  | { t: 'new'; anchor: Omit<ArtDraft['anchor'], 'artifact'>; quote: string; box: Box | null }
  | { t: 'boxes'; boxes: Record<string, Box | null> }
  | { t: 'hover'; id: string | null }
  | { t: 'open'; id: string }

const isEmpty = (d: { text: string; images: unknown[] }) => !d.text.trim() && !d.images.length

export function ArtifactNotes({ sid, artifact, v, frame }: { sid: string; artifact: string; v?: number; frame: React.RefObject<HTMLIFrameElement | null> }) {
  useStore()
  const all = draftsOf(sid).filter((d): d is ArtDraft => d.kind === 'artifact' && d.anchor.artifact === artifact && d.anchor.v === v)
  const cards = all.filter((d) => !d.reaction)
  const layer = useRef<HTMLDivElement>(null)
  const [boxes, setBoxes] = useState<Record<string, Box | null>>({})
  // The card showing (after a click on its highlight, or while you write in it), and the one under the pointer.
  const [open, setOpen] = useState<string | null>(null)
  const [peek, setPeek] = useState<string | null>(null)
  // The comment whose highlight darkens: the card under the pointer, else the one with the focus.
  const [lit, setLit] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)

  const post = (m: Record<string, unknown>) => {
    const f = frame.current
    if (!f?.contentWindow || !f.src) return
    f.contentWindow.postMessage({ codinger: 'notes', ...m }, new URL(f.src).origin)
  }
  const marks = JSON.stringify(all.map((d) => ({ id: d.id, kind: 'draft', anchor: d.anchor })))
  const focus = lit ?? focused
  const sendMarks = () => post({ t: 'marks', items: JSON.parse(marks), focus })
  const sendRef = useRef(sendMarks)
  sendRef.current = sendMarks
  useEffect(sendMarks, [marks, focus])

  const openCard = (id: string) => {
    setOpen(id)
    requestAnimationFrame(() => focusField(layer.current?.querySelector<HTMLElement>(`.note-card[data-id="${id}"] .ri-edit`)))
  }
  const peekTimer = useRef(0)
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const f = frame.current
      if (!f || e.source !== f.contentWindow || e.data?.codinger !== 'notes') return
      const m = e.data as FromFrame
      if (m.t === 'ready') sendRef.current()
      else if (m.t === 'boxes') setBoxes(m.boxes)
      else if (m.t === 'hover') {
        clearTimeout(peekTimer.current)
        // It goes one frame after the pointer leaves the highlight.
        if (m.id) setPeek(m.id); else peekTimer.current = window.setTimeout(() => setPeek(null), 16)
        setLit(m.id)
      } else if (m.t === 'open') openCard(m.id)
      else if (m.t === 'new') {
        // One empty comment at a time: a new one drops the untouched last one.
        for (const d of draftsOf(sid)) if ((d.kind === 'note' || d.kind === 'artifact') && !d.reaction && isEmpty(d)) removeDraft(sid, d.id)
        const id = uid()
        const anchor = { ...m.anchor, artifact, ...(v != null ? { v } : {}) }
        if (m.box) setBoxes((b) => ({ ...b, [id]: m.box }))
        addDraft(sid, { id, kind: 'artifact', anchor, quote: String(m.quote ?? '').slice(0, 1000), text: '', images: [], createdAt: Date.now() })
        setOpen(id)
      }
    }
    addEventListener('message', on)
    return () => removeEventListener('message', on)
  }, [sid, artifact, v])

  // Place each card under the last line of its highlight, centred on it, inside the pane.
  // A highlight out of view hides its card, unless you write in it.
  useLayoutEffect(() => {
    const el = layer.current
    if (!el) return
    const w = el.clientWidth, h = el.clientHeight
    for (const c of el.querySelectorAll<HTMLElement>('.note-card, .react-badge')) {
      const id = c.dataset.id!, b = boxes[id]
      const writing = c.contains(document.activeElement)
      const shown = c.classList.contains('react-badge') || [open, peek, focused, state.focus].includes(id) || writing
      if (!b || !shown || (!writing && (b.bottom < 0 || b.top > h))) { c.style.display = 'none'; continue }
      c.style.display = ''
      if (c.classList.contains('react-badge')) {
        c.style.left = `${Math.min(b.right + 2, w - c.offsetWidth - 2)}px`
        c.style.top = `${Math.max(2, b.top - c.offsetHeight / 2)}px`
        continue
      }
      const cw = Math.min(CARD_W, w - 8)
      c.style.width = `${cw}px`
      const mid = (b.last.left + b.last.right) / 2
      c.style.left = `${Math.max(4, Math.min(mid - cw / 2, w - cw - 4))}px`
      c.style.top = `${Math.max(4, Math.min(b.last.bottom + 6, h - c.offsetHeight - 4))}px`
    }
  })

  // Reactions show as one badge for each place, at the right of its highlight; a click takes one off.
  const badges = new Map<string, ArtDraft[]>()
  for (const d of all) if (d.reaction && isReaction(d.text)) { const k = JSON.stringify(d.anchor); badges.set(k, [...(badges.get(k) ?? []), d]) }
  // A badge is placed by the first comment on its place that the page reported.
  const boxFor = (ds: ArtDraft[]) => ds.find((d) => boxes[d.id])?.id ?? ds[0].id

  return (
    <div className="artifact-notes" ref={layer}>
      {cards.map((d) => (
        <NoteCard
          key={d.id} sid={sid} note={d} onOpen={() => setOpen(d.id)}
          onHover={(on) => setLit(on ? d.id : null)}
          onFocus={() => { if (state.focus === d.id) state.focus = null; setFocused(d.id); setOpen(d.id) }}
          onBlur={() => {
            setFocused((f) => f === d.id ? null : f)
            setTimeout(() => { if (!layer.current?.querySelector(`.note-card[data-id="${d.id}"]`)?.contains(document.activeElement)) setOpen((o) => o === d.id ? null : o) }, 250)
          }}
        />
      ))}
      {[...badges.values()].map((ds) => (
        <button key={ds[0].id} data-id={boxFor(ds)} className="react-badge draft" onMouseEnter={() => setLit(boxFor(ds))} onMouseLeave={() => setLit(null)}
          onClick={() => { setLit(null); removeDraft(sid, ds[ds.length - 1].id) }}>{ds.map((d) => d.text.trim()).join('')}</button>
      ))}
    </div>
  )
}
