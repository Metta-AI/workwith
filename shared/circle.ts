// A fast circle drawn with one finger on a touch screen opens the command palette
// (web/src/components/Palette.tsx): the direction of the path turns by most of a full turn, in
// under a second, around a box at least 50px on each side that is near square, and the finger
// ends near where it started. A scroll or a swipe turns little, so it does not count. done runs
// when the finger lifts: iOS brings up the keyboard from a touchend, not from a touchmove.
// The artifact server adds this function to each artifact page by its source (server/artifacts.ts),
// since a touch in an artifact's frame does not reach Codinger's page. So it uses nothing from
// outside itself.
export function onCircle(done: () => void): () => void {
  if (!matchMedia('(pointer: coarse)').matches) return () => {}
  let pts: { x: number; y: number; t: number }[] = []
  let turn = 0, dir: number | null = null, drawn = false
  const start = (e: TouchEvent) => { pts = e.touches.length === 1 ? [{ x: e.touches[0].clientX, y: e.touches[0].clientY, t: e.timeStamp }] : []; turn = 0; dir = null; drawn = false }
  const move = (e: TouchEvent) => {
    if (!pts.length || e.touches.length !== 1) { pts = []; return }
    const p = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: e.timeStamp }, last = pts[pts.length - 1]
    if (Math.hypot(p.x - last.x, p.y - last.y) < 6) return
    const d = Math.atan2(p.y - last.y, p.x - last.x)
    if (dir !== null) { let dd = d - dir; while (dd > Math.PI) dd -= 2 * Math.PI; while (dd < -Math.PI) dd += 2 * Math.PI; turn += dd }
    dir = d
    pts.push(p)
    while (pts.length > 2 && p.t - pts[0].t > 1000) pts.shift()
    if (Math.abs(turn) < 1.6 * Math.PI) return
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y)
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys)
    const back = Math.hypot(p.x - pts[0].x, p.y - pts[0].y)
    if (w >= 50 && h >= 50 && w / h < 2.2 && h / w < 2.2 && back < 0.6 * Math.max(w, h) && p.t - pts[0].t < 1000) { pts = []; drawn = true }
  }
  const end = (e: TouchEvent) => { pts = []; if (drawn && e.type === 'touchend') done(); drawn = false }
  document.addEventListener('touchstart', start, { passive: true })
  document.addEventListener('touchmove', move, { passive: true })
  document.addEventListener('touchend', end)
  document.addEventListener('touchcancel', end)
  return () => {
    document.removeEventListener('touchstart', start)
    document.removeEventListener('touchmove', move)
    document.removeEventListener('touchend', end)
    document.removeEventListener('touchcancel', end)
  }
}
