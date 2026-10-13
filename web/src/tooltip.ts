// Tooltips that show quickly, for any element with a data-tip attribute. The
// browser's own (title) waits about a second and can't be styled; this one
// waits a moment, sits below the element (above it near the bottom of the
// window) and stays inside the window. A title becomes a data-tip the first
// time the pointer is on it, so the browser's own never shows; React sets the
// title again only when it changes, and then it moves over again.

const DELAY = 200

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
    const left = Math.max(6, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 6))
    const below = r.bottom + 6 + t.height < innerHeight - 6
    tip.style.left = `${left}px`
    tip.style.top = `${below ? r.bottom + 6 : r.top - 6 - t.height}px`
  }

  document.addEventListener('mouseover', (e) => {
    const el = (e.target as Element | null)?.closest?.('[data-tip], [title]') as HTMLElement | null
    const title = el?.getAttribute('title')
    if (el && title) {
      el.dataset.tip = title
      el.removeAttribute('title')
      // An icon-only button keeps a name for screen readers.
      if (!el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title)
    }
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
