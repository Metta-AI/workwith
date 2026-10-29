import { useEffect, useRef } from 'react'
import { XIcon } from './Icons.tsx'

const MAX = 8

// An image shown full size. It zooms on its own (the page itself does not zoom on a phone, main.tsx):
// a pinch, a trackpad pinch or the mouse wheel zooms at the fingers or the pointer, a drag or a
// two-finger move on a trackpad moves a zoomed image, and a double tap or double-click zooms in or back out. A click outside the image,
// the X or Escape closes it.
export function Lightbox({ src, onClose }: { src: string; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const el = box.current!, im = img.current!
    let s = 1, tx = 0, ty = 0
    const draw = () => {
      im.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`
      im.style.cursor = s > 1 ? 'grab' : 'zoom-in'
    }
    // Zoom to n with the screen point (px, py) kept in place. The image scales from its top left corner.
    const zoom = (n: number, px: number, py: number) => {
      n = Math.min(MAX, Math.max(1, n))
      if (n === 1) { s = 1; tx = ty = 0; draw(); return }
      const lx = px - im.offsetLeft, ly = py - im.offsetTop
      tx = lx - n * (lx - tx) / s
      ty = ly - n * (ly - ty) / s
      s = n
      draw()
    }
    const toggle = (px: number, py: number) => zoom(s > 1 ? 1 : 2.5, px, py)

    // A trackpad pinch comes as a wheel event with ctrlKey and small steps, and zooms; so does a
    // mouse wheel. A two-finger move on a trackpad moves a zoomed image. The browsers do not say
    // which device sent a wheel event: a trackpad has wheelDeltaY = -3 × deltaY (Chrome, Safari),
    // or a sideways part; a mouse wheel in Firefox counts in lines (deltaMode 1).
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY
      const pad = e.deltaX !== 0 || (wd ? Math.abs(wd + 3 * e.deltaY) < 2 : e.deltaMode === 0)
      if (e.ctrlKey || !pad) { zoom(s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY); return }
      if (s === 1) return
      tx -= e.deltaX; ty -= e.deltaY
      draw()
    }

    const pts = new Map<number, { x: number; y: number }>()
    let moved = false, lastTap = 0, mouse = false, sx = 0, sy = 0
    const onImage = (x: number, y: number) => { const r = im.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom }
    let pinch: { d: number; mx: number; my: number } | null = null
    const span = () => {
      const [a, b] = [...pts.values()]
      return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
    }
    const down = (e: PointerEvent) => {
      if ((e.target as Element).closest('button')) return
      mouse = e.pointerType === 'mouse'
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      el.setPointerCapture(e.pointerId)
      if (pts.size === 1) { moved = false; sx = e.clientX; sy = e.clientY }
      if (pts.size === 2) pinch = span()
    }
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId)
      if (!p) return
      const dx = e.clientX - p.x, dy = e.clientY - p.y
      p.x = e.clientX; p.y = e.clientY
      moved = moved || pts.size > 1 || Math.hypot(e.clientX - sx, e.clientY - sy) > 6
      if (pts.size === 2 && pinch) {
        const now = span()
        tx += now.mx - pinch.mx; ty += now.my - pinch.my
        zoom(s * now.d / pinch.d, now.mx, now.my)
        pinch = now
      } else if (pts.size === 1 && s > 1) {
        tx += dx; ty += dy
        draw()
      }
    }
    const up = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return
      if (pts.size < 2) pinch = null
      if (pts.size || moved) return
      const hit = onImage(e.clientX, e.clientY)
      if (mouse) { if (!hit) close.current(); return }
      // A tap: two in a short time zoom, one outside the image closes it.
      const t = performance.now()
      if (t - lastTap < 300) { lastTap = 0; toggle(e.clientX, e.clientY); return }
      lastTap = t
      if (!hit && s === 1) setTimeout(() => { if (lastTap === t) close.current() }, 300)
    }
    const dbl = (e: MouseEvent) => { if (mouse && onImage(e.clientX, e.clientY)) toggle(e.clientX, e.clientY) }

    draw()
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('dblclick', dbl)
    return () => {
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('dblclick', dbl)
    }
  }, [src])

  return (
    <div className="lightbox" ref={box}>
      <img ref={img} src={src} alt="" draggable={false} />
      <button className="icon-btn lightbox-x" aria-label="Close" onClick={onClose}><XIcon size={20} /></button>
    </div>
  )
}
