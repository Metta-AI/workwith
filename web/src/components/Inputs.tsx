// A text field that grows with its text and takes pasted or dropped images,
// which sit in the text where they were put (as image links, shared/images.ts).
// The text is markdown, drawn live (mdlive.ts): the field rebuilds itself from
// the text after each change, so it keeps its own undo history.

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ImageRef } from '../../../shared/types.ts'
import { htmlToMarkdown } from '../htmlmd.ts'
import { activate, enterKey, fromDom, imageCaret, imgNode, rangeAt, render, select, selectionOffsets, snapCaret, wrapKey } from '../mdlive.ts'
import { imagesFrom, uploadImage } from '../util.ts'
import { media } from '../store.ts'
import { ImageIcon, XIcon } from './Icons.tsx'

type Props = {
  machine?: string   // the machine its images go to; the current one by default
  value: string
  onChange(v: string): void
  // Images attached the older way, beside the text rather than in it.
  images: ImageRef[]
  onImages(imgs: ImageRef[]): void
  placeholder?: string
  autoFocus?: boolean
  onSubmit?(): void
  onEscape?(): void
  minRows?: number
  // Gets first look at keys; return true to swallow one (the slash menu does).
  onKey?(e: React.KeyboardEvent<HTMLElement>): boolean
}

function caretAt(x: number, y: number): Range | null {
  const d = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null }
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y)
    if (!p) return null
    const r = document.createRange()
    r.setStart(p.offsetNode, p.offset)
    return r
  }
  return document.caretRangeFromPoint?.(x, y) ?? null
}

type Snap = { v: string; s: number; e: number; t: number }

export function RichInput({ value, onChange, images, onImages, placeholder, autoFocus, onSubmit, onEscape, minRows = 2, onKey, machine }: Props) {
  const ed = useRef<HTMLDivElement>(null)
  const fake = useRef<HTMLSpanElement>(null)       // the caret beside an image (mdlive.ts imageCaret)
  const last = useRef<string | null>(null)        // what this field last reported
  const caret = useRef<[number, number] | null>(null) // where the caret last was, as text offsets
  const composing = useRef(false)                  // an IME is mid-word: leave the DOM alone
  const past = useRef<Snap[]>([])                  // undo history, latest last
  const future = useRef<Snap[]>([])
  const change = useRef(onChange)
  change.current = onChange

  const emit = (v: string) => {
    const el = ed.current!
    el.toggleAttribute('data-empty', !v && !el.querySelector('img'))
    if (v === last.current) return
    last.current = v
    change.current(v)
  }
  // Typing within a moment of the last change is one step to undo, up to a space or line break.
  const record = (v: string, sel: [number, number] | null) => {
    const now = Date.now(), top = past.current.at(-1)
    const snap = { v, s: sel?.[0] ?? v.length, e: sel?.[1] ?? v.length, t: now }
    const breaks = /\s/.test(v[snap.s - 1] ?? '')
    if (top && top.v !== v && now - top.t < 600 && past.current.length > 1 && !breaks) past.current[past.current.length - 1] = snap
    else if (!top || top.v !== v) past.current.push(snap)
    if (past.current.length > 200) past.current.shift()
    future.current = []
  }
  const apply = (snap: Snap) => {
    const el = ed.current!
    render(el, snap.v)
    select(el, snap.s, snap.e)
    activate(el)
    reveal(el, snap.e === snap.v.length)
    emit(snap.v)
  }
  const undo = () => { if (past.current.length > 1) { future.current.push(past.current.pop()!); apply(past.current.at(-1)!) } }
  const redo = () => { const s = future.current.pop(); if (s) { past.current.push(s); apply(s) } }

  // After the browser changes the DOM: read the text, draw it again, put the caret back.
  const sync = () => {
    const el = ed.current!
    const sel = selectionOffsets(el)
    const v = fromDom(el)
    // An image still uploading is not in the text yet; drawing again would drop it.
    if (!composing.current && !el.querySelector('img.loading')) {
      render(el, v)
      if (sel && document.activeElement === el) select(el, sel[0], sel[1])
    }
    activate(el)
    if (sel) reveal(el, sel[1] === v.length)
    if (v !== last.current) record(v, sel)
    emit(v)
  }

  useLayoutEffect(() => {
    const el = ed.current!
    if (value === last.current) return
    last.current = value
    render(el, value)
    el.toggleAttribute('data-empty', !value)
    past.current = [{ v: value, s: value.length, e: value.length, t: 0 }]
    future.current = []
    if (document.activeElement === el) select(el, value.length)
  }, [value])

  useEffect(() => {
    const el = ed.current!
    if (autoFocus) { el.focus(); select(el, fromDom(el).length) }
  }, [autoFocus])

  useEffect(() => {
    const save = () => {
      const el = ed.current
      if (!el) return
      const sel = selectionOffsets(el)
      if (sel) caret.current = sel
      if (document.activeElement === el) snapCaret(el)
      activate(el)
      imageCaret(el, fake.current!)
    }
    // An image that loads changes size, and so moves the caret.
    const loaded = () => { if (ed.current) imageCaret(ed.current, fake.current!) }
    const el = ed.current!
    document.addEventListener('selectionchange', save)
    el.addEventListener('load', loaded, true)
    return () => { document.removeEventListener('selectionchange', save); el.removeEventListener('load', loaded, true) }
  }, [])

  // Each image shows at once and fills in when its upload is done.
  async function add(files: File[], at: Range | null) {
    const el = ed.current!
    for (const f of files) {
      const img = imgNode(URL.createObjectURL(f))
      const r = at && el.contains(at.startContainer) ? at : caret.current ? rangeAt(el, caret.current[0], caret.current[1]) : endOf(el)
      r.deleteContents()
      r.insertNode(img)
      r.setStartAfter(img)
      r.collapse(true)
      if (document.activeElement === el) { const s = getSelection()!; s.removeAllRanges(); s.addRange(r) }
      at = r
      el.removeAttribute('data-empty')
      try {
        const ref = await uploadImage(f, machine)
        img.src = media(ref.url, machine)
        img.dataset.url = ref.url
        img.classList.remove('loading')
      } catch { img.remove() /* the store shows the error */ }
      sync()
      at = caret.current ? rangeAt(el, caret.current[1]) : null
    }
  }

  // Markdown keys and Enter change the text here, not in the DOM.
  const keyEdit = (e: React.KeyboardEvent) => {
    const el = ed.current!
    const sel = selectionOffsets(el)
    if (!sel || composing.current) return false
    const plainEnter = e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey
    const r = plainEnter ? enterKey(fromDom(el), sel[0], sel[1]) : wrapKey(e, fromDom(el), sel[0], sel[1])
    if (!r) return false
    edit(r.value, r.start, r.end)
    return true
  }
  const edit = (v: string, s: number, e = s) => {
    const snap = { v, s, e, t: 0 }
    past.current.push(snap)
    future.current = []
    apply(snap)
  }

  // Copy gives the markdown as it is; the styled DOM would copy as odd indents.
  const copy = (e: React.ClipboardEvent, cut: boolean) => {
    const el = ed.current!
    const sel = selectionOffsets(el)
    if (!sel || sel[0] === sel[1]) return
    const v = fromDom(el)
    e.preventDefault()
    e.clipboardData.setData('text/plain', v.slice(sel[0], sel[1]))
    if (cut) edit(v.slice(0, sel[0]) + v.slice(sel[1]), sel[0])
  }
  // Paste keeps the formatting of rich text, as markdown.
  const paste = (e: React.ClipboardEvent) => {
    const f = imagesFrom(e.clipboardData)
    if (f.length) { e.preventDefault(); void add(f, null); return }
    const el = ed.current!
    const sel = selectionOffsets(el)
    const html = e.clipboardData.getData('text/html')
    const t = ((html && htmlToMarkdown(html)) || e.clipboardData.getData('text/plain')).replace(/\r\n?/g, '\n')
    if (!sel || !t || composing.current) return
    e.preventDefault()
    const v = fromDom(el)
    edit(v.slice(0, sel[0]) + t + v.slice(sel[1]), sel[0] + t.length)
  }

  return (
    <div
      className="rich-input"
      onDragOver={(e) => { if (imagesFrom(e.dataTransfer).length || e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={(e) => { const f = imagesFrom(e.dataTransfer); if (f.length) { e.preventDefault(); void add(f, caretAt(e.clientX, e.clientY)) } }}
    >
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((im, i) => (
            <span className="thumb" key={im.url + i}>
              <img src={media(im.url, machine)} alt="" />
              <button type="button" title="Remove image" onClick={() => onImages(images.filter((_, j) => j !== i))}><XIcon size={10} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="ri-field">
        <div
          ref={ed}
          className="ri-edit"
          contentEditable="plaintext-only"
          suppressContentEditableWarning
          role="textbox"
          aria-multiline
          data-placeholder={placeholder}
          style={{ minHeight: `${minRows * 20 + 12}px` }}
          onInput={sync}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false; sync() }}
          onBeforeInput={(e) => {
            const t = (e.nativeEvent as InputEvent).inputType
            if (t === 'historyUndo') { e.preventDefault(); undo() }
            if (t === 'historyRedo') { e.preventDefault(); redo() }
          }}
          onScroll={() => imageCaret(ed.current!, fake.current!)}
          onBlur={() => imageCaret(ed.current!, fake.current!)}
          onPaste={paste}
          onCopy={(e) => copy(e, false)}
          onCut={(e) => copy(e, true)}
          onKeyDown={(e) => {
            if (onKey?.(e)) { e.preventDefault(); return }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
            if (keyEdit(e)) { e.preventDefault(); return }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) { e.preventDefault(); onSubmit() }
            if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape() }
          }}
        />
        <span ref={fake} className="ri-caret" hidden />
        <label className="attach" title="Attach images" onMouseDown={(e) => e.preventDefault()}>
          <input type="file" accept="image/*" multiple hidden onChange={(e) => { void add([...(e.target.files ?? [])], null); e.target.value = '' }} />
          <ImageIcon />
        </label>
      </div>
    </div>
  )
}

// Keep the caret in view, in the field and in whatever scrolls around it. Drawing
// the text again loses the browser's own scrolling, and a new empty last line
// gives the caret no box: at the end, the caret is at the bottom of the field.
function reveal(el: HTMLElement, atEnd: boolean) {
  const s = getSelection()
  if (!s?.rangeCount || !el.contains(s.focusNode) || document.activeElement !== el) return
  const caret = () => {
    const r = s.getRangeAt(0).cloneRange()
    r.collapse(false)
    const box = r.getClientRects()[0]
    if (box?.height) return box
    const e = el.getBoundingClientRect()
    return atEnd ? new DOMRect(e.left, e.bottom - 25, 0, 20) : null
  }
  const PAD = 6
  if (atEnd) el.scrollTop = el.scrollHeight
  else {
    const b = caret(), e = el.getBoundingClientRect()
    if (b && b.bottom > e.bottom - PAD) el.scrollTop += b.bottom - e.bottom + PAD
    else if (b && b.top < e.top + PAD) el.scrollTop -= e.top + PAD - b.top
  }
  const b = caret()
  if (!b) return
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight <= p.clientHeight || !/auto|scroll/.test(getComputedStyle(p).overflowY)) continue
    const pb = p.getBoundingClientRect()
    if (b.bottom > pb.bottom - PAD) p.scrollTop += b.bottom - pb.bottom + PAD
    break
  }
}

function endOf(el: HTMLElement): Range {
  const r = document.createRange()
  r.selectNodeContents(el)
  r.collapse(false)
  return r
}

export function Thumbs({ images }: { images?: ImageRef[] }) {
  if (!images?.length) return null
  return <div className="thumbs sent">{images.map((im, i) => <a key={i} href={media(im.url)} target="_blank" rel="noreferrer"><img src={media(im.url)} alt="" /></a>)}</div>
}
