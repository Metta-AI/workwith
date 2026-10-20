// The For review section at the top of the Files tab (FileBrowser.tsx): the files the agent asked you
// to decide on (a <review> tag) and the files it changed in each turn, each with approve or reject, a
// group all at once, and the counts of what you approved, rejected and have left. Only what waits for
// you shows: a file goes when you send its verdict, and a file of a turn when git has it committed. A comment on lines of a file (LineCard) shows in the
// file's view (FileView.tsx). They all go to the agent with your other replies (store.ts queuedParts).

import { useState } from 'react'
import type { SessionMeta } from '../../../shared/types.ts'
import type { LineVerdict, Verdict } from '../../../shared/review.ts'
import { changed, removeDraft, state, useStore, type LineDraft } from '../store.ts'
import { groupsOf, resolve, setVerdict, uncommittedOf, updateLine, verdictsOf, type Group } from '../review.ts'
import { CheckIcon, ChevronIcon, TrashIcon, XIcon } from './Icons.tsx'
import { renderInline } from '../util.ts'
import { baseName, dirName, ltr } from './FileView.tsx'
import { FileTypeIcon, openFile } from './FileBrowser.tsx'

const RECENT = 5   // outside a git repository, the files of the newest turns show

// The groups with what waits for you (decided: also the files whose verdict you sent). A file shows
// only in the newest group that has it: its changes show as one diff, whichever turn made them. n: your verdicts
// not sent yet, and the files left; asked: the files left that the agent asked about with a tag.
export function useReview(m: SessionMeta, decided = false) {
  const st = useStore()
  const groups = groupsOf(m.id, m.cwd, m.status === 'working' || m.status === 'permission')
  const of = verdictsOf(m.id)
  const git = uncommittedOf(m.id)
  const inCwd = (f: string) => f.startsWith(m.cwd + '/') ? f.slice(m.cwd.length + 1) : null
  const shown: Group[] = []
  let turns = 0, sent = 0
  const seen = new Set<string>()
  for (const g of groups) {
    const recent = g.asked || turns++ < RECENT
    const files = g.files.filter((f) => {
      if (seen.has(f)) return false
      const v = of(g.key, f)
      if (v.verdict && !v.sent) return true
      if (v.sent) { sent++; return decided }
      if (g.asked || g.live) return true
      const r = inCwd(f)
      return git && r != null ? git.has(r) : recent
    })
    for (const f of g.files) seen.add(f)
    if (files.length) shown.push({ ...g, files })
  }
  const n = { approve: 0, reject: 0, left: 0 }
  let asked = 0
  for (const g of shown) for (const f of g.files) {
    const v = of(g.key, f)
    if (!v.verdict) { n.left++; if (g.asked) asked++ } else if (!v.sent) n[v.verdict]++
  }
  const comments = (st.drafts[m.id] ?? []).filter((d) => d.kind === 'line' && d.text.trim()).length
  return { shown, of, n, asked, comments, sent }
}

// The group for review of a file: the one you opened it from, or else the newest that has it.
export function groupOfFile(groups: Group[], path: string, from: string | undefined, rel: (p: string) => string): Group | undefined {
  const has = (g: Group) => g.files.some((f) => rel(f) === rel(path))
  return groups.find((g) => g.key === from && has(g)) ?? groups.find(has)
}

export function Counts({ n, comments }: { n: { approve: number; reject: number; left: number }; comments?: number }) {
  return (
    <span className="rv-counts">
      <span className="rv-ok"><CheckIcon size={10} /> {n.approve}</span>
      <span className="rv-bad"><XIcon size={10} /> {n.reject}</span>
      <span className={n.left ? 'rv-left' : 'muted'}>{n.left} left</span>
      {!!comments && <span className="muted">{comments} {comments === 1 ? 'comment' : 'comments'}</span>}
    </span>
  )
}

export function VerdictButtons({ value, sent, onSet, label }: { value?: Verdict; sent?: boolean; onSet(v: Verdict | null): void; label?: boolean }) {
  const b = (v: Verdict, icon: React.ReactNode, word: string) => (
    <button className={`rv-btn ${v}${value === v ? ' on' : ''}${value === v && sent ? ' sent' : ''}`} aria-pressed={value === v} data-pid={`verdict-${v}`}
      onClick={(e) => { e.stopPropagation(); onSet(value === v && !sent ? null : v) }}>
      {icon}{label && <span>{word}</span>}
    </button>
  )
  return <span className="rv-btns">{b('approve', <CheckIcon size={11} />, 'Approve')}{b('reject', <XIcon size={11} />, 'Reject')}</span>
}

type Props = { m: SessionMeta; rel(p: string): string; isOn(p: string): boolean; onOpen(path: string, group: string): void }

export function ReviewSection({ m, rel, isOn, onOpen }: Props) {
  const [decided, setDecided] = useState(false)
  const [flip, setFlip] = useState<Set<string>>(new Set())   // groups you opened or closed against their default
  const { shown, of, n, comments, sent } = useReview(m, decided)
  if (!shown.length && !sent) return null
  return (
    <div className="fb-group rv" data-pid="review">
      <div className="attention-head rv-head">For review<span className="grow" /><Counts n={n} comments={comments} /></div>
      {shown.map((g) => {
        const vs = g.files.map((f) => of(g.key, f))
        const left = vs.filter((v) => !v.verdict).length
        const same = vs.every((v) => v.verdict === vs[0].verdict) ? vs[0].verdict : undefined
        const open = (left > 0) !== flip.has(g.key)
        const toggle = () => setFlip((s) => { const x = new Set(s); if (x.has(g.key)) x.delete(g.key); else x.add(g.key); return x })
        const all = (v: Verdict | null) => { for (const f of g.files) setVerdict(m.id, g.key, f, rel(f), v) }
        return (
          <div key={g.key} className="rv-group" data-pid={`review-group-${g.key}`}>
            <div className="rv-ghead" onClick={toggle}>
              <span className={`fb-chev${open ? ' open' : ''}`}><ChevronIcon size={10} /></span>
              {g.asked && <span className="rv-asked">Asked</span>}
              <span className="rv-label">{g.label}</span>
              <span className="muted rv-meta">{g.live ? 'working' : left ? `${left} of ${g.files.length} left` : `${g.files.length} done`}</span>
              <VerdictButtons value={same} sent={vs.every((v) => v.sent)} onSet={all} />
            </div>
            {open && g.files.map((f, i) => (
              <div key={f} className={`fb-row rv-file${isOn(f) ? ' on' : ''}`} role="button" tabIndex={0}
                onClick={() => onOpen(f, g.key)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(f, g.key) }}>
                <FileTypeIcon name={f} /><span className="fb-name">{baseName(f)}</span>
                <span className="fb-dir muted">{ltr(dirName(rel(f)))}</span>
                <VerdictButtons value={vs[i].verdict} sent={vs[i].sent} onSet={(v) => setVerdict(m.id, g.key, f, rel(f), v)} />
              </div>
            ))}
          </div>
        )
      })}
      {!shown.length && <div className="fb-note muted">Nothing waits for your decision.</div>}
      {sent > 0 && <button className="link rv-older" onClick={() => setDecided(!decided)}>{decided ? 'Hide the files you decided' : `Show the files you decided (${sent})`}</button>}
    </div>
  )
}

// A <review> tag in a reply: the files the agent asks you to decide on, each with its verdict.
// A click on a file opens it on its changes in the Files tab.
export function ReviewCard({ sid, group, title, files, live }: { sid: string; group: string; title: string; files: string[]; live: boolean }) {
  const st = useStore()
  const m = st.sessions.find((x) => x.id === sid)
  const cwd = m?.cwd ?? ''
  const of = verdictsOf(sid)
  const ro = !!state.share || live
  const paths = files.map((f) => resolve(f, cwd))
  const rel = (p: string) => p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p
  const left = paths.filter((p) => !of(group, p).verdict).length
  const show = () => { const first = paths.find((p) => !of(group, p).verdict) ?? paths[0]; if (first) openFile(sid, first, true, group) }
  return (
    <div className="rv-ask" data-pid="review-card">
      <div className="rv-ask-head">
        <span className="rv-asked">For review</span>
        <span className="rv-label" dangerouslySetInnerHTML={{ __html: renderInline(title || 'Review') }} />
        <span className="muted rv-meta">{left ? `${left} of ${paths.length} left` : `${paths.length} decided`}</span>
        {!ro && <button className="link" onClick={show}>Open in Files</button>}
      </div>
      {paths.map((p) => {
        const v = of(group, p)
        return (
          <div key={p} className="fb-row rv-file" role="button" tabIndex={0} onClick={() => openFile(sid, p, true, group)}>
            <FileTypeIcon name={p} /><span className="fb-name">{baseName(p)}</span>
            <span className="fb-dir muted">{ltr(dirName(rel(p)))}</span>
            {!ro && <VerdictButtons value={v.verdict} sent={v.sent} onSet={(x) => setVerdict(sid, group, p, rel(p), x)} />}
          </div>
        )
      })}
    </div>
  )
}

// Shows the Files tab, where the For review section is.
export function showReview() {
  state.panelTab = 'files'
  changed()
}

const LINE_WORDS: [LineVerdict, string][] = [['approve', 'Approve'], ['reject', 'Reject'], ['unsure', 'Unsure']]

// A comment on lines of a file, below the last of them.
export function LineCard({ sid, d, focus }: { sid: string; d: LineDraft; focus: boolean }) {
  const at = d.end > d.line ? `Lines ${d.line}–${d.end}` : `Line ${d.line}`
  return (
    <div className={`rv-card ${d.verdict}`} data-pid="line-comment" onPointerDown={(e) => e.stopPropagation()}>
      <div className="rv-card-head">
        <span className="muted">{at}{d.old ? ' (removed)' : ''}</span>
        <span className="grow" />
        <span className="rv-seg">
          {LINE_WORDS.map(([v, w]) => <button key={v} className={`rv-chip ${v}${d.verdict === v ? ' on' : ''}`} onClick={() => updateLine(sid, d.id, { verdict: v })}>{w}</button>)}
        </span>
        <button className="icon-btn" data-tip="Delete the comment" onClick={() => removeDraft(sid, d.id)}><TrashIcon size={12} /></button>
      </div>
      <textarea className="rv-text" rows={2} placeholder="Comment" value={d.text} autoFocus={focus}
        onChange={(e) => updateLine(sid, d.id, { text: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Escape' && !d.text.trim()) removeDraft(sid, d.id) }} />
    </div>
  )
}
