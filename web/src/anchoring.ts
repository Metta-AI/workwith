// Selections → anchors → highlights. Anchoring is Marginer's: a quote is a run
// of text plus which occurrence of it ("nth") it is, inside a root element.
// Here each rendered markdown block is its own root, so the reply cards we
// insert between blocks never shift the text being counted.

import { quotePiecesFromRange, resolveNthQuote } from './vendor/anchor.ts'
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
      if (q.startsWith('![')) return
      const r = resolveNthQuote(q, p.nths[i] ?? 1, el)
      if (r) out.push(r)
    })
  }
  return out
}

// CSS Custom Highlights paint ranges without touching the DOM, which keeps
// React's markdown nodes (and so every other anchor) intact.
const registry = new Map<string, { kind: string; ranges: Range[] }>()
let raf = 0
export function setHighlights(key: string, kind: string, ranges: Range[]) {
  if (ranges.length) registry.set(key, { kind, ranges })
  else registry.delete(key)
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(paint)
}
function paint() {
  if (!('highlights' in CSS)) return
  const byKind = new Map<string, Range[]>()
  for (const { kind, ranges } of registry.values()) byKind.set(kind, [...(byKind.get(kind) ?? []), ...ranges])
  for (const kind of ['draft', 'sent', 'others', 'focus']) {
    const r = byKind.get(kind) ?? []
    if (r.length) CSS.highlights.set(`cd-${kind}`, new Highlight(...r))
    else CSS.highlights.delete(`cd-${kind}`)
  }
}
