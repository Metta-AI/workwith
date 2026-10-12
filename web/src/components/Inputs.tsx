// A textarea that grows with its text and takes pasted or dropped images.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ImageRef } from '../../../shared/types.ts'
import { imagesFrom, uploadImage } from '../util.ts'
import { ImageIcon, XIcon } from './Icons.tsx'

type Props = {
  value: string
  onChange(v: string): void
  images: ImageRef[]
  onImages(imgs: ImageRef[]): void
  placeholder?: string
  autoFocus?: boolean
  onSubmit?(): void
  onEscape?(): void
  minRows?: number
  // Gets first look at keys; return true to swallow one (the slash menu does).
  onKey?(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean
  // 'top' puts thumbnails above the text; 'overlay' floats them above the input, over the transcript.
  thumbs?: 'overlay' | 'top'
}

export function RichInput({ value, onChange, images, onImages, placeholder, autoFocus, onSubmit, onEscape, minRows = 2, onKey, thumbs = 'top' }: Props) {
  const ta = useRef<HTMLTextAreaElement>(null)
  const [busy, setBusy] = useState(0)
  const imgs = useRef(images)
  imgs.current = images

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, 420)}px`
  }, [value])
  useEffect(() => { if (autoFocus) ta.current?.focus() }, [autoFocus])

  async function add(files: File[]) {
    if (!files.length) return
    setBusy((n) => n + files.length)
    for (const f of files) {
      try { const ref = await uploadImage(f); onImages([...imgs.current, ref]) } catch { /* the store shows the error */ }
      setBusy((n) => n - 1)
    }
  }

  return (
    <div
      className={`rich-input ${thumbs}`}
      onDragOver={(e) => { if (imagesFrom(e.dataTransfer).length || e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={(e) => { const f = imagesFrom(e.dataTransfer); if (f.length) { e.preventDefault(); void add(f) } }}
    >
      {(images.length > 0 || busy > 0) && (
        <div className={`thumbs ${thumbs}`}>
          {images.map((im, i) => (
            <span className="thumb" key={im.url + i}>
              <img src={im.url} alt="" />
              <button title="Remove image" onClick={() => onImages(images.filter((_, j) => j !== i))}><XIcon size={10} /></button>
            </span>
          ))}
          {busy > 0 && <span className="thumb loading">…</span>}
        </div>
      )}
      <div className="ri-field">
        <textarea
          ref={ta}
          rows={minRows}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => { const f = imagesFrom(e.clipboardData); if (f.length) { e.preventDefault(); void add(f) } }}
          onKeyDown={(e) => {
            if (onKey?.(e)) { e.preventDefault(); return }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) { e.preventDefault(); onSubmit() }
            if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape() }
          }}
        />
        <label className="attach" title="Attach images">
          <input type="file" accept="image/*" multiple hidden onChange={(e) => { void add([...(e.target.files ?? [])]); e.target.value = '' }} />
          <ImageIcon />
        </label>
      </div>
    </div>
  )
}

export function Thumbs({ images }: { images?: ImageRef[] }) {
  if (!images?.length) return null
  return <div className="thumbs sent">{images.map((im, i) => <a key={i} href={im.url} target="_blank" rel="noreferrer"><img src={im.url} alt="" /></a>)}</div>
}
