// Comments on an artifact page, from inside the page. The artifact server adds this file to
// each page that Codinger's preview pane shows (server/artifacts.ts), after Marginer's text
// anchoring (web/src/vendor/anchor.ts), as one script: so it uses nothing else from outside.
// The page runs on another origin than Codinger, so Codinger cannot read it: this script
// finds what you comment on and paints the highlights, and Codinger's page draws the cards
// over the frame (web/src/components/ArtifactNotes.tsx). They talk over postMessage.
//
// A selection of text, or a click on a mark (an element with data-pid, aria-label or
// data-label, an SVG shape, an image or a canvas), starts a comment. An Option-click (Alt)
// starts one on anything, buttons and links too. On a touch screen a long press does what
// a click does.

import type { ArtifactAnchor } from '../../../shared/types.ts'
import { occurrenceOf, resolveNthQuote } from '../vendor/anchor.ts'

declare const CODINGER_APP: string

type Mark = { id: string; kind: 'draft' | 'sent'; anchor: ArtifactAnchor }
type Box = { left: number; top: number; right: number; bottom: number; last: { left: number; right: number; bottom: number } }

export function startNotes() {
  const send = (m: Record<string, unknown>) => parent.postMessage({ codinger: 'notes', ...m }, CODINGER_APP)
  // A card in Codinger takes the focus for a comment, but Chrome lets Codinger's page take it
  // from this frame only when the frame gives it back first.
  const handBack = () => { try { parent.focus() } catch { /* not allowed */ } }
  const UI = 'data-codinger-ui'
  const isOurs = (n: EventTarget | null) => n instanceof Element && !!n.closest(`[${UI}]`)
  const at = (n: Node) => (n.nodeType === 1 ? n as Element : n.parentElement)

  // ---- where a thing is ----

  const pidOf = (el: Element | null) => el?.closest<Element>('[data-pid]') ?? null
  const clip = (s: string, n: number) => (s = s.replace(/\s+/g, ' ').trim()).length > n ? s.slice(0, n - 1) + '…' : s
  // What an element says: its label, the <title> of an SVG shape, the heading of a card, else its text.
  const labelOf = (el: Element) => clip(
    el.getAttribute('aria-label') || el.getAttribute('data-label')
      || (el instanceof SVGElement ? el.querySelector(':scope > title')?.textContent : '')
      || el.querySelector('h1, h2, h3, h4, h5, h6')?.textContent
      || (el instanceof HTMLElement ? el.innerText : el.textContent) || el.getAttribute('alt') || '', 200)
  // A CSS path from root (left out) down to el.
  const pathOf = (el: Element, root: Element) => {
    const steps: string[] = []
    for (let e: Element | null = el; e && e !== root && e !== document.documentElement; e = e.parentElement) {
      if (e.id && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1) { steps.unshift(`#${CSS.escape(e.id)}`); return steps.join(' > ') }
      const tag = e.localName
      const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.localName === tag) : []
      steps.unshift(same.length > 1 ? `${CSS.escape(tag)}:nth-of-type(${same.indexOf(e) + 1})` : CSS.escape(tag))
    }
    return steps.join(' > ')
  }
  const elementAnchor = (el: Element): Omit<ArtifactAnchor, 'artifact'> => {
    const named = pidOf(el)
    const out: Omit<ArtifactAnchor, 'artifact'> = { tag: el instanceof SVGElement && el.localName !== 'svg' ? `svg ${el.localName}` : el.localName, label: labelOf(el) }
    if (named) out.pid = named.getAttribute('data-pid')!
    if (named !== el) out.path = pathOf(el, named ?? document.body)
    return out
  }
  const elementOf = (a: ArtifactAnchor): Element | null => {
    let root: Element | null = document.body
    try {
      // A path from an element with an id starts at that id.
      if (a.path?.startsWith('#')) return document.querySelector(a.path)
      if (a.pid) root = document.querySelector(`[data-pid="${CSS.escape(a.pid)}"]`)
      if (root && a.path) return root.querySelector(`:scope > ${a.path}`)
    } catch { return null }
    return root
  }
  const rangeOf = (a: ArtifactAnchor): Range | null => {
    const root = elementOf(a)
    return root && a.text ? resolveNthQuote(a.text.quote, a.text.nth, root) : null
  }

  // ---- starting a comment ----

  const MARK = '[data-pid], [aria-label], [data-label]'
  const SHAPE = 'rect, circle, ellipse, path, polygon, polyline, line, img, canvas, video'
  const CONTROL = 'a, button, input, select, textarea, label, summary, option, [contenteditable], [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="slider"]'
  const markAt = (t: Element, any: boolean): Element | null => {
    if (isOurs(t) || (!any && t.closest(CONTROL))) return null
    const el = t.closest(MARK) ?? (t.matches(SHAPE) ? t : null) ?? (any ? t : null)
    return el && el !== document.body && el !== document.documentElement ? el : null
  }
  const boxOf = (rects: DOMRect[]): Box | null => {
    const rs = rects.filter((r) => r.width || r.height)
    if (!rs.length) return null
    const l = rs[rs.length - 1]
    return { left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)), right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)), last: { left: l.left, right: l.right, bottom: l.bottom } }
  }
  const startOn = (el: Element) => {
    handBack()
    send({ t: 'new', anchor: elementAnchor(el), quote: labelOf(el), box: boxOf([el.getBoundingClientRect()]) })
  }
  const textTarget = () => {
    const sel = getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) return null
    const r = sel.getRangeAt(0)
    const common = at(r.commonAncestorContainer)
    if (!common || isOurs(common) || common.closest('input, textarea, [contenteditable]')) return null
    return { sel, r, root: pidOf(common) ?? document.body }
  }
  const startOnText = () => {
    const t = textTarget()
    if (!t) return false
    const quote = clip(t.sel.toString(), 1000)
    const anchor = { ...(t.root === document.body ? {} : elementAnchor(t.root)), text: { quote, nth: occurrenceOf(t.r, t.root) } }
    delete anchor.label
    handBack()
    send({ t: 'new', anchor, quote, box: boxOf([...t.r.getClientRects()]) })
    t.sel.removeAllRanges()
    return true
  }

  // A click waits a moment: a double click selects a word, and that comment wins.
  let wait = 0, downAt = { x: 0, y: 0 }
  addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY } }, true)
  addEventListener('mouseup', () => setTimeout(() => { if (startOnText()) clearTimeout(wait) }, 0))
  addEventListener('click', (e) => {
    clearTimeout(wait)
    if (!e.isTrusted || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || touched) return
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return
    const el = markAt(e.target as Element, e.altKey)
    const hit = markHit(e.clientX, e.clientY, el)
    if (hit) { handBack(); send({ t: 'open', id: hit }); return }
    if (!el) return
    if (e.altKey) { e.preventDefault(); e.stopPropagation() }
    wait = window.setTimeout(() => { if (!textTarget()) startOn(el) }, e.altKey ? 0 : 250)
  }, true)
  addEventListener('dblclick', () => clearTimeout(wait), true)

  // Touch: a long press on a mark starts a comment on it; a selection starts one when it stops changing.
  let touched = false, press = 0, from: { x: number; y: number } | null = null, settle = 0
  addEventListener('touchstart', (e) => {
    touched = true
    clearTimeout(press)
    if (e.touches.length !== 1) return
    const t = e.touches[0], el = markAt(e.target as Element, false)
    from = { x: t.clientX, y: t.clientY }
    if (el) press = window.setTimeout(() => { if (from && !textTarget()) { from = null; startOn(el) } }, 500)
  }, { passive: true })
  addEventListener('touchmove', (e) => { const t = e.touches[0]; if (from && Math.hypot(t.clientX - from.x, t.clientY - from.y) > 10) { clearTimeout(press); from = null } }, { passive: true })
  addEventListener('touchend', () => { clearTimeout(press); from = null; setTimeout(() => { touched = false }, 400) }, { passive: true })
  document.addEventListener('selectionchange', () => {
    clearTimeout(settle)
    if (touched) settle = window.setTimeout(() => { if (!from) startOnText() }, 600)
  })

  // ---- highlights ----

  let marks: Mark[] = [], focus: string | null = null
  let layer: HTMLElement | null = null
  const ensureLayer = () => {
    if (layer?.isConnected) return layer
    layer = document.createElement('div')
    layer.setAttribute(UI, '')
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646'
    const css = document.createElement('style')
    css.textContent = `
      ::highlight(cd-draft){background-color:rgba(255,196,0,.38)} ::highlight(cd-sent){background-color:rgba(255,196,0,.16)} ::highlight(cd-focus){background-color:rgba(255,170,0,.62)}
      [${UI}] .cd-box{position:fixed;border-radius:4px;box-shadow:0 0 0 3px rgba(255,196,0,.75);background:rgba(255,196,0,.14)}
      [${UI}] .cd-box.sent{box-shadow:0 0 0 2px rgba(255,196,0,.4);background:none}
      [${UI}] .cd-box.focus{box-shadow:0 0 0 3px rgba(255,150,0,.95);background:rgba(255,170,0,.22)}`
    layer.appendChild(css)
    document.documentElement.appendChild(layer)
    return layer
  }
  // Each mark found again in the page now: its text, or its element.
  let found: { m: Mark; range: Range | null; el: Element | null }[] = []
  const resolve = () => { found = marks.map((m) => m.anchor.text ? { m, range: rangeOf(m.anchor), el: null } : { m, range: null, el: elementOf(m.anchor) }) }
  const rectsOf = (f: (typeof found)[number]) => f.range ? [...f.range.getClientRects()] : f.el ? [f.el.getBoundingClientRect()] : []
  // The comment a click opens: one on the mark clicked, or on the text under the pointer. A
  // comment on a card does not catch a click on a bar inside it: that starts a comment on the bar.
  const markHit = (x: number, y: number, el: Element | null) => {
    for (const f of found) {
      if (f.m.kind !== 'draft') continue
      if (f.el ? f.el === el : rectsOf(f).some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2)) return f.m.id
    }
    return null
  }
  let raf = 0
  const paint = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      const l = ensureLayer()
      for (const b of [...l.querySelectorAll('.cd-box')]) b.remove()
      const kind = (m: Mark) => m.id === focus ? 'focus' : m.kind
      if ('highlights' in CSS) for (const k of ['draft', 'sent', 'focus']) {
        const rs = found.filter((f) => f.range && kind(f.m) === k).map((f) => f.range!)
        if (rs.length) CSS.highlights.set(`cd-${k}`, new Highlight(...rs)); else CSS.highlights.delete(`cd-${k}`)
      }
      const boxes: Record<string, Box | null> = {}
      for (const f of found) {
        const rects = rectsOf(f)
        boxes[f.m.id] = boxOf(rects)
        if (!f.el || !rects.length) continue
        const r = rects[0], b = document.createElement('div')
        b.className = `cd-box ${kind(f.m)}`
        Object.assign(b.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` })
        l.appendChild(b)
      }
      send({ t: 'boxes', boxes, h: innerHeight, w: innerWidth })
    })
  }
  addEventListener('scroll', paint, { capture: true, passive: true })
  addEventListener('resize', paint)
  // The page draws again (new data, a filter): find each mark again.
  let redo = 0
  new MutationObserver((ms) => {
    if (ms.every((m) => isOurs(m.target))) return
    clearTimeout(redo)
    redo = window.setTimeout(() => { resolve(); paint() }, 100)
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-pid', 'aria-label', 'class', 'style', 'transform', 'd', 'x', 'y', 'width', 'height'] })

  // The pointer over a mark lights up its card in Codinger.
  let hovered: string | null = null, moveRaf = 0
  addEventListener('mousemove', (e) => {
    cancelAnimationFrame(moveRaf)
    moveRaf = requestAnimationFrame(() => {
      let id: string | null = null
      for (const f of found) if (rectsOf(f).some((r) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)) { id = f.m.id; if (f.m.kind === 'draft') break }
      if (id !== hovered) { hovered = id; send({ t: 'hover', id }) }
    })
  }, { passive: true })
  document.documentElement.addEventListener('mouseleave', () => { if (hovered) { hovered = null; send({ t: 'hover', id: null }) } })

  addEventListener('message', (e) => {
    if (e.source !== parent || e.origin !== CODINGER_APP || e.data?.codinger !== 'notes') return
    const m = e.data
    if (m.t === 'marks') { marks = m.items ?? []; focus = m.focus ?? null; resolve(); paint() }
    else if (m.t === 'reveal') {
      const f = found.find((x) => x.m.id === m.id)
      const el = f?.el ?? (f?.range ? at(f.range.startContainer) : null)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  })
  send({ t: 'ready' })
}
