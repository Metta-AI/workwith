// A drag handle that resizes the panel before (or after) it. Widths persist.

import { useState } from 'react'

export function useWidth(key: string, initial: number): [number, (w: number) => void] {
  const [w, setW] = useState(() => Number(localStorage.getItem(`codinger.w.${key}`)) || initial)
  return [w, (n) => { setW(n); localStorage.setItem(`codinger.w.${key}`, String(Math.round(n))) }]
}

// reverse: the panel is after the handle (on its right), so dragging left widens it.
type Props = { width: number; setWidth(w: number): void; min: number; max: number; initial: number; reverse?: boolean }

export function Splitter({ width, setWidth, min, max, initial, reverse }: Props) {
  return (
    <div
      className="splitter"
      title="Drag to resize · double-click to reset"
      onDoubleClick={() => setWidth(initial)}
      onPointerDown={(e) => {
        e.preventDefault()
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        const x0 = e.clientX, w0 = width
        document.body.classList.add('resizing')
        const move = (ev: PointerEvent) => setWidth(Math.max(min, Math.min(max, w0 + (ev.clientX - x0) * (reverse ? -1 : 1))))
        const up = () => {
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
          document.body.classList.remove('resizing')
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
      }}
    />
  )
}
