// A drag handle that resizes the panel before (or after) it. Widths persist.

import { useState } from 'react'

export function useWidth(key: string, initial: number): [number, (w: number) => void] {
  const [w, setW] = useState(() => Number(localStorage.getItem(`codinger.w.${key}`)) || initial)
  return [w, (n) => { setW(n); localStorage.setItem(`codinger.w.${key}`, String(Math.round(n))) }]
}

// reverse: the panel is after the handle (on its right), so dragging left widens it.
// onClick: a click that does not drag calls it (and a double-click no longer resets the width,
// as its first click would already call it).
// vertical: the handle is a line across, and resizes a height (width is then the height).
type Props = { width: number; setWidth(w: number): void; min: number; max: number; initial: number; reverse?: boolean; vertical?: boolean; onClick?(): void; tip?: string }

export function Splitter({ width, setWidth, min, max, initial, reverse, vertical, onClick, tip }: Props) {
  const at = (e: { clientX: number; clientY: number }) => vertical ? e.clientY : e.clientX
  return (
    <div
      className={vertical ? 'splitter splitter-v' : 'splitter'}
      title={tip ?? 'Drag to resize · double-click to reset'}
      onDoubleClick={onClick ? undefined : () => setWidth(initial)}
      onPointerDown={(e) => {
        e.preventDefault()
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        const x0 = at(e), w0 = width
        let dragged = false
        document.body.classList.add(vertical ? 'resizing-v' : 'resizing')
        const move = (ev: PointerEvent) => {
          if (Math.abs(at(ev) - x0) > 3) dragged = true
          if (dragged) setWidth(Math.max(min, Math.min(max, w0 + (at(ev) - x0) * (reverse ? -1 : 1))))
        }
        const up = () => {
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
          document.body.classList.remove('resizing', 'resizing-v')
          if (!dragged) onClick?.()
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
      }}
    />
  )
}
