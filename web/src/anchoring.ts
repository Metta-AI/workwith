// Selections → anchors → highlights. Anchoring is Marginer's: a quote is a run
// of text plus which occurrence of it ("nth") it is, inside a root element.
// Here each rendered markdown block is its own root, so the reply cards we
// insert between blocks never shift the text being counted.

import { quotePiecesFromRange, resolveImageQuote, resolveNthQuote } from './vendor/anchor.ts'
import type { Anchor, AnchorPiece } from '../../shared/types.ts'

// Blocks can sit inside a "more details" section, so they are found at any depth.
const blocksOf = (msgEl: Element) => [...msgEl.querySelectorAll<HTMLElement>('[data-block]')]

export function anchorFromRange(range: Range, msgEl: HTMLElement): Anchor | null {
  const pieces: AnchorPiece[] = []
  for (const el of blocksOf(msgEl)) {
    if (!range.intersectsNode(el)) continue
    const r = document.createRange()
    r.selectNodeContents(el)
    if (el.contains(range.startContainer)) r.setStart(range.startContainer, range.startOffset)
    if (el.contains(range.endContainer)) r.setEnd(range.endContainer, range.endOffset)
    const q = quotePiecesFromRange(r, el)
    if (q?.quotes.length) pieces.push({ block: Number(el.dataset.block), ...q })
  }
  return pieces.length ? { msg: msgEl.dataset.msg!, pieces } : null
}

export function rangesFor(anchor: Anchor, msgEl: HTMLElement): Range[] {
  const out: Range[] = []
  for (const p of anchor.pieces) {
    const el = msgEl.querySelector<HTMLElement>(`[data-block="${p.block}"]`)
    if (!el) continue
    p.quotes.forEach((q, i) => {
      // An image, a video or a player: the range holds just that element.
      if (q.startsWith('![')) {
        const m = resolveImageQuote(q, p.nths[i] ?? 1, el)
        if (!m) return
        const r = document.createRange()
        r.selectNode(m)
        return void out.push(r)
      }
      const r = resolveNthQuote(q, p.nths[i] ?? 1, el)
      if (r) out.push(r)
    })
  }
  return out
}

// What a comment or reaction on a whole passage quotes: its images, videos and players
// first, as markdown images with the path the server keeps them at (Claude gets only
// the first words of a quote), then its text.
export function passageQuote(el: HTMLElement): string {
  const media = [...el.querySelectorAll<HTMLElement>('img, video, audio, iframe.media-frame')]
    .map((m) => `![](${(m.getAttribute('src') ?? '').replace(/^.*?(?=\/api\/(images|media)\/)/, '').replace(/\s/g, '%20')})`)
  return [...media, el.innerText.trim()].filter((s) => s && s !== '![]()').join(' ')
}

// The image, video or player a range holds by itself (rangesFor), if any.
export function mediaIn(r: Range): HTMLElement | null {
  const n = r.startContainer === r.endContainer && r.endOffset - r.startOffset === 1 ? r.startContainer.childNodes[r.startOffset] : null
  return n instanceof HTMLElement && n.matches('img, video, audio, iframe') ? n : null
}

// CSS Custom Highlights paint ranges without touching the DOM, which keeps
// React's markdown nodes (and so every other anchor) intact. They paint text
// only, so an image, a video or a player gets a class instead (styles.css).
const registry = new Map<string, { kind: string; ranges: Range[] }>()
let raf = 0
export function setHighlights(key: string, kind: string, ranges: Range[]) {
  if (ranges.length) registry.set(key, { kind, ranges })
  else registry.delete(key)
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(paint)
}
let outlined: HTMLElement[] = []
function paint() {
  const byKind = new Map<string, Range[]>()
  for (const { kind, ranges } of registry.values()) byKind.set(kind, [...(byKind.get(kind) ?? []), ...ranges])
  for (const m of outlined) m.classList.remove('hl-draft', 'hl-sent', 'hl-focus', 'hl-pick')
  outlined = []
  for (const [kind, ranges] of byKind) for (const r of ranges) {
    const m = mediaIn(r)
    if (m) { m.classList.add(`hl-${kind}`); outlined.push(m) }
  }
  if (!('highlights' in CSS)) return
  for (const kind of ['draft', 'sent', 'focus', 'pick']) {
    const r = byKind.get(kind) ?? []
    if (r.length) CSS.highlights.set(`cd-${kind}`, new Highlight(...r))
    else CSS.highlights.delete(`cd-${kind}`)
  }
}
