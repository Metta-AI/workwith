// Search every emoji by name. Opens as a small popover; Enter takes the first match.

import { useEffect, useRef, useState } from 'react'
import { allEmoji, topEmoji, type EmojiInfo } from '../emoji.ts'

export function EmojiPicker({ onPick, onClose }: { onPick(e: string): void; onClose(): void }) {
  const [list, setList] = useState<EmojiInfo[]>([])
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)   // the emoji Enter picks; arrows move it
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { void allEmoji().then(setList) }, [])
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [onClose])
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const found = words.length ? list.filter((e) => words.every((w) => e.name.includes(w))).slice(0, 120) : []
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
    <div className="emoji-picker" ref={box} onMouseDown={(e) => { if (e.target !== e.currentTarget.querySelector('input')) e.preventDefault() }}>
      <input autoFocus placeholder="Search emoji" value={q} onChange={(e) => { setQ(e.target.value); setAt(0) }} onKeyDown={(e) => {
        const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key]
        if (move) { e.preventDefault(); setAt((i) => Math.max(0, Math.min(flat.length - 1, i + move))) }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
        if (e.key === 'Enter' && flat[at]) { e.preventDefault(); onPick(flat[at]) }
      }} />
      <div className="emoji-grid">
        {shown.map((e, i) => btn(e, i))}
        {words.length > 0 && !found.length && <span className="muted">No match</span>}
        {(() => { let i = shown.length; return groups.map(([g, es]) => <div key={g} className="emoji-group"><div className="emoji-group-name">{g}</div>{es.map((e) => btn(e.emoji, i++))}</div>) })()}
      </div>
    </div>
  )
}
