// Search every emoji by name. Opens as a small popover; Enter takes the first match.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { allEmoji, searchEmoji, topEmoji, type EmojiInfo } from '../emoji.ts'

export function EmojiPicker({ onPick, onClose }: { onPick(e: string): void; onClose(): void }) {
  const [list, setList] = useState<EmojiInfo[]>([])
  const [q, setQ] = useState('')
  // The emoji Enter picks: none until you arrow down into the grid; typing leaves it again.
  const [at, setAt] = useState(-1)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { void allEmoji().then(setList) }, [])
  // Opens below its button, unless that runs past the bottom of the pane that scrolls it
  // (the composer sits under the transcript): then above, or if there's no room there either,
  // scroll the pane until it fits.
  const [up, setUp] = useState(false)
  useLayoutEffect(() => {
    const el = box.current, anchor = el?.offsetParent
    if (!el || !anchor) return
    let pane: HTMLElement | null = el.parentElement
    while (pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement
    const lim = pane ? pane.getBoundingClientRect() : { top: 0, bottom: innerHeight }
    const a = anchor.getBoundingClientRect(), h = el.offsetHeight, gap = 20
    const fitsDown = a.bottom + 4 + h <= lim.bottom - gap
    const fitsUp = a.top - 4 - h >= lim.top + gap
    setUp(!fitsDown && fitsUp)
    if (!fitsDown && !fitsUp && pane) pane.scrollTop += a.bottom + 4 + h - (lim.bottom - gap)
  }, [list.length > 0])
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [onClose])
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const found = searchEmoji(list, q).slice(0, 120)
  const shown = words.length ? found.map((e) => e.emoji) : topEmoji(16)
  // With no search, your most used, then every emoji by group to scroll through.
  const groups: [string, EmojiInfo[]][] = []
  if (!words.length) for (const e of list) { const g = groups.at(-1); if (g?.[0] === e.group) g[1].push(e); else groups.push([e.group, [e]]) }
  const flat = [...shown, ...groups.flatMap(([, es]) => es.map((e) => e.emoji))]
  const COLS = 8
  const btn = (e: string, i: number) => (
    <button key={`${i}${e}`} className={i === at ? 'on' : ''} title={list.find((x) => x.emoji === e)?.name ?? ''} onClick={() => onPick(e)}
      ref={i === at ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>{e}</button>
  )
  return (
    <div className="emoji-picker" ref={box} style={up ? { top: 'auto', bottom: 'calc(100% + 4px)' } : undefined} onMouseDown={(e) => { if (e.target !== e.currentTarget.querySelector('input')) e.preventDefault() }}>
      <input autoFocus placeholder="Search emoji" value={q} onChange={(e) => { setQ(e.target.value); setAt(-1) }} onKeyDown={(e) => {
        const grid = at >= 0
        if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => i < 0 ? 0 : Math.min(flat.length - 1, i + COLS)) }
        else if (e.key === 'ArrowUp' && grid) { e.preventDefault(); setAt((i) => i - COLS < 0 ? -1 : i - COLS) }
        else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && grid) { e.preventDefault(); setAt((i) => Math.max(0, Math.min(flat.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))) }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
        // Enter takes the emoji arrowed to, or else the first match of a search.
        if (e.key === 'Enter') { const pick = grid ? flat[at] : words.length ? flat[0] : undefined; if (pick) { e.preventDefault(); onPick(pick) } }
      }} />
      <div className="emoji-grid">
        {shown.map((e, i) => btn(e, i))}
        {words.length > 0 && !found.length && <span className="muted">No match</span>}
        {(() => { let i = shown.length; return groups.map(([g, es]) => <div key={g} className="emoji-group"><div className="emoji-group-name">{g}</div>{es.map((e) => btn(e.emoji, i++))}</div>) })()}
      </div>
    </div>
  )
}
