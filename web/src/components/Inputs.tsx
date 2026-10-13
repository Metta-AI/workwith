// A text field that grows with its text and takes pasted or dropped images,
// which sit in the text where they were put (as image links, shared/images.ts).
// It is a plain-text contenteditable: the DOM is the truth while you type, and
// is rebuilt from `value` only when the value changes from outside.

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ImageRef } from '../../../shared/types.ts'
import { imageToken, splitImages } from '../../../shared/images.ts'
import { imagesFrom, uploadImage } from '../util.ts'
import { ImageIcon, XIcon } from './Icons.tsx'

type Props = {
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

function imgNode(src: string, url?: string): HTMLImageElement {
  const img = document.createElement('img')
  img.src = src
  img.className = 'ri-img'
  if (url) img.dataset.url = url
  else img.classList.add('loading')
  return img
}

function toDom(el: HTMLElement, value: string) {
  el.replaceChildren(...splitImages(value).map((r) => 'url' in r ? imgNode(r.url, r.url) : document.createTextNode(r.text)))
}

function fromDom(el: Node): string {
  let out = ''
  el.childNodes.forEach((n, i) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent
    else if (n instanceof HTMLImageElement) { if (n.dataset.url) out += imageToken(n.dataset.url) }
    // The browser keeps a <br> at the very end so a final newline shows; it is not text.
    else if (n.nodeName === 'BR') { if (i < el.childNodes.length - 1) out += '\n' }
    else if (n instanceof HTMLElement) out += (out && !out.endsWith('\n') && /^(DIV|P)$/.test(n.nodeName) ? '\n' : '') + fromDom(n)
  })
  return out
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

export function RichInput({ value, onChange, images, onImages, placeholder, autoFocus, onSubmit, onEscape, minRows = 2, onKey }: Props) {
  const ed = useRef<HTMLDivElement>(null)
  const last = useRef<string | null>(null)   // what this field last reported
  const caret = useRef<Range | null>(null)   // where the caret last was inside the field
  const change = useRef(onChange)
  change.current = onChange

  const sync = () => {
    const el = ed.current!
    const v = fromDom(el)
    el.toggleAttribute('data-empty', !v && !el.querySelector('img'))
    if (v === last.current) return
    last.current = v
    change.current(v)
  }

  useLayoutEffect(() => {
    const el = ed.current!
    if (value === last.current) return
    last.current = value
    toDom(el, value)
    el.toggleAttribute('data-empty', !value)
    if (document.activeElement === el) placeCaretAtEnd(el)
  }, [value])

  useEffect(() => {
    const el = ed.current!
    if (autoFocus) { el.focus(); placeCaretAtEnd(el) }
  }, [autoFocus])

  useEffect(() => {
    const save = () => {
      const s = getSelection()
      if (s?.rangeCount && ed.current?.contains(s.anchorNode)) caret.current = s.getRangeAt(0).cloneRange()
    }
    document.addEventListener('selectionchange', save)
    return () => document.removeEventListener('selectionchange', save)
  }, [])

  // Each image shows at once and fills in when its upload is done.
  async function add(files: File[], at: Range | null) {
    const el = ed.current!
    for (const f of files) {
      const img = imgNode(URL.createObjectURL(f))
      const r = at && el.contains(at.startContainer) ? at : endOf(el)
      r.deleteContents()
      r.insertNode(img)
      r.setStartAfter(img)
      r.collapse(true)
      if (document.activeElement === el) { const s = getSelection()!; s.removeAllRanges(); s.addRange(r) }
      at = r
      el.removeAttribute('data-empty')
      try {
        const ref = await uploadImage(f)
        img.src = ref.url
        img.dataset.url = ref.url
        img.classList.remove('loading')
      } catch { img.remove() /* the store shows the error */ }
      sync()
    }
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
              <img src={im.url} alt="" />
              <button title="Remove image" onClick={() => onImages(images.filter((_, j) => j !== i))}><XIcon size={10} /></button>
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
          onPaste={(e) => { const f = imagesFrom(e.clipboardData); if (f.length) { e.preventDefault(); void add(f, caret.current) } }}
          onKeyDown={(e) => {
            if (onKey?.(e)) { e.preventDefault(); return }
            if (markdownKey(e)) { e.preventDefault(); return }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) { e.preventDefault(); onSubmit() }
            if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape() }
          }}
        />
        <label className="attach" title="Attach images" onMouseDown={(e) => e.preventDefault()}>
          <input type="file" accept="image/*" multiple hidden onChange={(e) => { void add([...(e.target.files ?? [])], caret.current); e.target.value = '' }} />
          <ImageIcon />
        </label>
      </div>
    </div>
  )
}

// Markdown by keyboard, as in most editors: the selection gets wrapped (or
// unwrapped, if it already is); with nothing selected, the caret lands inside.
const WRAP: Record<string, [string, string]> = { b: ['**', '**'], i: ['_', '_'], e: ['`', '`'], x: ['~~', '~~'], k: ['[', ']()'] }
function markdownKey(e: React.KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false
  const k = e.key.toLowerCase()
  if (!WRAP[k] || (k === 'x') !== e.shiftKey) return false
  const [a, b] = WRAP[k]
  const sel = getSelection()
  if (!sel?.rangeCount) return false
  // Markers just outside the selection count too: take them in, so the text comes unwrapped.
  const r = sel.getRangeAt(0)
  const sc = r.startContainer, ec = r.endContainer
  if (k !== 'k' && sc.nodeType === Node.TEXT_NODE && ec.nodeType === Node.TEXT_NODE && r.startOffset >= a.length
    && sc.textContent!.slice(r.startOffset - a.length, r.startOffset) === a && ec.textContent!.slice(r.endOffset, r.endOffset + b.length) === b) {
    const wide = r.cloneRange()
    wide.setStart(sc, r.startOffset - a.length)
    wide.setEnd(ec, r.endOffset + b.length)
    sel.removeAllRanges()
    sel.addRange(wide)
  }
  const text = sel.toString()
  const wrapped = k !== 'k' && text.length >= a.length + b.length && text.startsWith(a) && text.endsWith(b)
  const inner = wrapped ? text.slice(a.length, text.length - b.length) : text
  document.execCommand('insertText', false, wrapped ? inner : a + text + b)
  // Select the text again (or, for a link, put the caret where the URL goes).
  const s = sel as Selection & { modify?(alter: string, dir: string, unit: string): void }
  if (!s.modify) return true
  if (k === 'k') { s.modify('move', 'backward', 'character'); return true }
  if (!wrapped) for (let i = 0; i < b.length; i++) s.modify('move', 'backward', 'character')
  for (let i = 0; i < inner.length; i++) s.modify('extend', 'backward', 'character')
  return true
}

function endOf(el: HTMLElement): Range {
  const r = document.createRange()
  r.selectNodeContents(el)
  r.collapse(false)
  return r
}

function placeCaretAtEnd(el: HTMLElement) {
  const s = getSelection()
  if (!s) return
  s.removeAllRanges()
  s.addRange(endOf(el))
}

export function Thumbs({ images }: { images?: ImageRef[] }) {
  if (!images?.length) return null
  return <div className="thumbs sent">{images.map((im, i) => <a key={i} href={im.url} target="_blank" rel="noreferrer"><img src={im.url} alt="" /></a>)}</div>
}
