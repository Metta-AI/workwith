// Tooltips that show quickly, for any element with a data-tip attribute. The
// browser's own (title) waits about a second and can't be styled; this one
// waits a moment, sits below the element (above it near the bottom of the
// window) and stays inside the window. In the sidebar it sits to the right of
// the element, over the page, so it covers none of the list. A title becomes a data-tip the first
// time the pointer is on it, so the browser's own never shows; React sets the
// title again only when it changes, and then it moves over again.
//
// On a touch screen there is no hover. A finger that holds still on an element
// shows its tip, and the click when the finger lets go is dropped. A tap shows
// the tip only on an element that does nothing on a tap.

const DELAY = 200
const HOLD = 500
const CLICKABLE = 'button, a[href], [role="button"], input, select, textarea, label, summary'

export function initTooltips() {
  const tip = document.createElement('div')
  tip.className = 'tip'
  tip.setAttribute('role', 'tooltip')
  document.body.appendChild(tip)
  let target: HTMLElement | null = null
  let timer = 0

  const hide = () => { clearTimeout(timer); target = null; tip.classList.remove('on') }
  const show = (el: HTMLElement) => {
    const text = el.dataset.tip
    if (!text || !el.isConnected) return
    tip.textContent = text
    tip.classList.add('on')
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect()
    const side = el.closest('.sidebar')?.getBoundingClientRect()
    if (side && side.right + 8 + t.width < innerWidth - 6) {
      tip.style.left = `${side.right + 8}px`
      tip.style.top = `${Math.max(6, Math.min(r.top + r.height / 2 - t.height / 2, innerHeight - t.height - 6))}px`
      return
    }
    const left = Math.max(6, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 6))
    const below = r.bottom + 6 + t.height < innerHeight - 6
    tip.style.left = `${left}px`
    tip.style.top = `${below ? r.bottom + 6 : r.top - 6 - t.height}px`
  }

  // The element with a tip at the target, if any. Its title moves over to data-tip.
  const tipped = (at: EventTarget | null) => {
    const el = (at as Element | null)?.closest?.('[data-tip], [title]') as HTMLElement | null
    const title = el?.getAttribute('title')
    if (el && title) {
      el.dataset.tip = title
      el.removeAttribute('title')
      // An icon-only button keeps a name for screen readers.
      if (!el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title)
    }
    return el
  }

  // A touch: the time of the last one (the browser sends a mouseover after a tap), and the
  // tip a hold showed, whose click goes nowhere.
  let touchAt = 0, held: HTMLElement | null = null, start: { x: number; y: number } | null = null
  document.addEventListener('touchstart', (e) => {
    touchAt = Date.now()
    hide()
    held = null
    const el = e.touches.length === 1 ? tipped(e.target) : null
    if (!el) { start = null; return }
    target = el
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    // A hold that drags a row in the sidebar shows no tip.
    timer = window.setTimeout(() => { if (!document.body.classList.contains('sorting')) { held = el; show(el) } }, HOLD)
  }, { passive: true })
  document.addEventListener('touchmove', (e) => {
    if (start && Math.hypot(e.touches[0].clientX - start.x, e.touches[0].clientY - start.y) > 10) { start = null; hide() }
  }, { passive: true })
  document.addEventListener('touchend', (e) => {
    touchAt = Date.now()
    clearTimeout(timer)
    const el = target
    if (held || !el || !start) return
    start = null
    if (!(e.target as Element).closest?.(CLICKABLE) && getComputedStyle(e.target as Element).cursor !== 'pointer') show(el)
    else target = null
  })
  document.addEventListener('touchcancel', () => { start = null; hide() })
  document.addEventListener('click', (e) => {
    if (!held || Date.now() - touchAt > 1000) return
    held = null
    e.preventDefault()
    e.stopPropagation()
  }, true)

  document.addEventListener('mouseover', (e) => {
    if (Date.now() - touchAt < 1000) return
    const el = tipped(e.target)
    if (el === target) return
    hide()
    if (!el) return
    target = el
    timer = window.setTimeout(() => show(el), DELAY)
  })
  // Text that changes under the pointer (a countdown, a click that cycles) shows at once.
  new MutationObserver(() => { if (target && tip.classList.contains('on')) show(target) })
    .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-tip'] })
  document.addEventListener('scroll', hide, true)
  window.addEventListener('blur', hide)
}
