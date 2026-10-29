// On a touch screen the finger covers the emoji under it, so a bigger copy shows
// above the emoji while the finger is on it: in a passage's row of emoji (also
// while a held press slides along it), the emoji search and a comment's reactions.
// "+", the comment button and the remove button get one too, a copy of the button's own content.

import { visibleBox } from './util.ts'

const EMOJI = '.ack-row button, .ack-clear, .emoji-picker button, .note-card .reactions button'

export function initPeek() {
  const box = document.createElement('div')
  box.className = 'emoji-peek'
  box.setAttribute('aria-hidden', 'true')
  document.body.appendChild(box)
  let finger: number | null = null, at: Element | null = null

  const hide = () => { at = null; box.classList.remove('on') }
  const peek = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest(EMOJI) ?? null
    if (el === at) return
    const text = el?.textContent?.trim() ?? ''
    const icon = !!el?.matches('.more-emoji, .ack-clear')
    if (!el || (!icon && !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text))) return hide()
    at = el
    if (icon) box.innerHTML = el.innerHTML
    else box.textContent = text
    box.classList.add('on')
    // Inside what you see, which a phone's keyboard pans (visibleBox).
    const r = el.getBoundingClientRect(), v = visibleBox()
    box.style.left = `${Math.max(v.left + 6, Math.min(r.left + r.width / 2 - box.offsetWidth / 2, v.right - box.offsetWidth - 6)) - v.fixed.left}px`
    box.style.top = `${Math.max(v.top + 6, r.top - box.offsetHeight - 20) - v.fixed.top}px`
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return
    finger = e.pointerId
    peek(e.clientX, e.clientY)
  })
  document.addEventListener('pointermove', (e) => { if (e.pointerId === finger) peek(e.clientX, e.clientY) })
  const end = (e: PointerEvent) => { if (e.pointerId === finger) { finger = null; hide() } }
  document.addEventListener('pointerup', end)
  document.addEventListener('pointercancel', end)
  document.addEventListener('scroll', hide, true)
}
