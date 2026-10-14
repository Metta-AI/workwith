// The session's questions and items to consider in one place: the open ones
// to answer or dismiss from here, and earlier ones for reference.

import { dismissItem, markDone, undismissItem } from '../store.ts'
import { revealItem, useItems, type TrackedItem } from '../items.ts'
import { AskCard } from './AssistantMessage.tsx'
import { useState } from 'react'
import { CheckIcon, ChevronIcon, CommentIcon, DashIcon, UndoIcon, XIcon } from './Icons.tsx'
import { renderInline } from '../util.ts'
import { withoutImages } from '../../../shared/images.ts'

const OPEN = new Set(['open', 'drafted', 'dismissing', 'completing'])

export function AttentionPanel({ sid, width, onHide }: { sid: string; width: number; onHide(): void }) {
  const [showDone, setShowDone] = useState(() => localStorage.getItem('codinger.panel.done') === '1')
  const toggleDone = () => { localStorage.setItem('codinger.panel.done', showDone ? '0' : '1'); setShowDone(!showDone) }
  const items = useItems(sid)
  const map = new Map(items.map((i) => [i.key, i]))
  const open = items.filter((i) => OPEN.has(i.status))
  // Newest message first; within a message, reading order.
  const msgs = [...new Set(items.map((i) => i.msg))].reverse()
  const done = msgs.flatMap((m) => items.filter((i) => i.msg === m && !OPEN.has(i.status)))
  const waiting = open.filter((i) => i.status === 'open').length
  return (
    <aside className="attention" style={{ width }}>
      <div className="attention-top">
        <span className="attention-head">Open {waiting > 0 && <span className="count">{waiting}</span>}</span>
        <button className="icon-btn" title="Hide" onClick={onHide}><XIcon size={13} /></button>
      </div>
      {!open.length && <div className="attention-empty muted">Nothing open</div>}
      {open.map((i) => i.kind === 'ask'
        ? (
          <div key={i.key} className="panel-item" onClick={(e) => { if ((e.target as HTMLElement).closest('.ask-q')) revealItem(i.key) }}>
            <AskCard c={{ sid, msg: i.msg, items: map, live: false }} ask={i.ask} compact />
          </div>
        )
        : <PanelConsider key={i.key} sid={sid} item={i} />)}
      {done.length > 0 && (
        <button className={`attention-head attention-done-head${showDone ? ' on' : ''}`} onClick={toggleDone}>
          <ChevronIcon size={11} className="chevron" /> Completed <span className="done-count">{done.length}</span>
        </button>
      )}
      {showDone && <div className="attention-done">{done.map((i) => <Done key={i.key} item={i} />)}</div>}
    </aside>
  )
}

function PanelConsider({ sid, item }: { sid: string; item: TrackedItem }) {
  // Commenting happens on the item itself, so its margin card sits beside it.
  const comment = () => {
    revealItem(item.key)
    document.querySelector<HTMLButtonElement>(`[data-item="${CSS.escape(item.key)}"] > .consider-foot > .item-reply`)?.click()
  }
  return (
    <div className={`panel-item consider st-${item.status}`}>
      <div className="consider-head">
        <button className="link panel-title" onClick={() => revealItem(item.key)} dangerouslySetInnerHTML={{ __html: renderInline(item.label) }} />
        <span className="item-actions">
          {item.status === 'open' && <button className="icon-btn" title="Dismiss" onClick={() => dismissItem(sid, item.key, item.label)}><XIcon size={13} /></button>}
          {(item.status === 'dismissing' || item.status === 'completing') && <button className="icon-btn pop-in" title="Undo" onClick={() => undismissItem(sid, item.key)}><UndoIcon size={14} /></button>}
        </span>
      </div>
      {(item.status === 'open' || item.status === 'drafted') && (
        <div className="consider-foot">
          {item.kind === 'consider' && item.done && <button className="reply-btn" onClick={() => markDone(sid, item.key, item.label)}><CheckIcon size={13} /> Done</button>}
          <button className="reply-btn" onClick={comment}><CommentIcon size={13} /> Reply</button>
        </div>
      )}
      {item.status === 'completing' && <div className="consider-foot"><button className="done-mark pop-in" title="Undo" onClick={() => undismissItem(sid, item.key)}><CheckIcon size={12} /> Done</button></div>}
    </div>
  )
}

function Done({ item }: { item: TrackedItem }) {
  const r = item.reply
  const reply = withoutImages(r?.kind === 'answer' ? [r.choices?.join('; '), r.text].filter(Boolean).join(' · ') : r?.kind === 'note' ? r.text : '')
  const Icon = item.status === 'answered' || item.status === 'completed' ? CheckIcon : item.status === 'dismissed' ? XIcon : DashIcon
  return (
    <button className={`panel-done st-${item.status}`} onClick={() => revealItem(item.key)}>
      <span className="panel-done-icon"><Icon size={12} /></span>
      <span className="panel-done-main">
        <span className="panel-done-label" dangerouslySetInnerHTML={{ __html: renderInline(item.label) }} />
        {reply && <span className="panel-done-reply">{reply}</span>}
      </span>
    </button>
  )
}
