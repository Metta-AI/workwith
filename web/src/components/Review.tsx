// The For review section at the top of the Files tab (FileBrowser.tsx). An agent asks for your decision
// with a <review> tag (shared/blocks.ts): what it changed, their state (committed, deployed), what to
// test, what it needs from you, and the files. You answer Go or No go, with a note if you like, and
// can approve or reject single files. The files the agent changed in each turn without a tag are
// here too, each with approve or reject. The counts say what you approved, rejected and have left.
// Only what waits for you shows: a decision goes when you send it, and a file of a turn when git has
// it committed. A comment on lines of a file (LineCard) shows in the file's view (FileView.tsx). They
// all go to the agent with your other replies (store.ts queuedParts).

import { useState } from 'react'
import type { SessionMeta } from '../../../shared/types.ts'
import type { LineVerdict, Verdict } from '../../../shared/review.ts'
import { changed, removeDraft, state, useStore, type LineDraft } from '../store.ts'
import { decide, decisionOf, groupsOf, resolve, reviewStatus, setDecisionText, setFileVerdict, setVerdict, uncommittedOf, updateLine, verdictsOf, type Group } from '../review.ts'
import { CheckIcon, ChevronIcon, TrashIcon, XIcon } from './Icons.tsx'
import { renderInline, renderMd } from '../util.ts'
import { baseName, dirName, ltr } from './FileView.tsx'
import { FileTypeIcon, openFile } from './FileBrowser.tsx'

const RECENT = 5   // outside a git repository, the files of the newest turns show

// The groups with what waits for you (decided: also what you sent). A file shows only in the newest
// group that has it: its changes show as one diff, whichever turn made them. Each review the agent
// asked for counts as one decision, and each file of a turn as one. n: your verdicts not sent yet, and
// what is left; asked: the reviews the agent asked for that wait for your decision.
export function useReview(m: SessionMeta, decided = false) {
  const st = useStore()
  const groups = groupsOf(m.id, m.cwd, m.status === 'working' || m.status === 'permission')
  const of = verdictsOf(m.id)
  const git = uncommittedOf(m.id)
  const inCwd = (f: string) => f.startsWith(m.cwd + '/') ? f.slice(m.cwd.length + 1) : null
  const shown: Group[] = []
  const n = { approve: 0, reject: 0, left: 0 }
  let turns = 0, sent = 0, asked = 0
  const seen = new Set<string>()
  const count = (v: { verdict?: Verdict; sent: boolean }) => { if (!v.verdict) n.left++; else if (!v.sent) n[v.verdict]++ }
  for (const g of groups) {
    if (g.asked) {
      const v = reviewStatus(m.id, g)
      for (const f of g.files) seen.add(f)
      if (v.done && v.sent) { sent++; if (!decided) continue }
      count(v.done ? v : { sent: false })
      if (!v.done) asked++
      shown.push(g)
      continue
    }
    const recent = turns++ < RECENT
    const files = g.files.filter((f) => {
      if (seen.has(f)) return false
      const v = of(g.key, f)
      if (v.verdict && !v.sent) return true
      if (v.sent) { sent++; return decided }
      if (g.live) return true
      const r = inCwd(f)
      return git && r != null ? git.has(r) : recent
    })
    for (const f of g.files) seen.add(f)
    for (const f of files) count(of(g.key, f))
    if (files.length) shown.push({ ...g, files })
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

// Reject, then approve: the button that says yes is at the right. words: Go and No go, for a whole review.
// dim: the files have mixed verdicts, so neither button of the whole review is chosen.
export function VerdictButtons({ value, sent, onSet, label, words, big, dim }: { value?: Verdict; sent?: boolean; onSet(v: Verdict | null): void; label?: boolean; words?: [string, string]; big?: boolean; dim?: boolean }) {
  const [no, yes] = words ?? ['Reject', 'Approve']
  const b = (v: Verdict, icon: React.ReactNode, word: string) => (
    <button className={`rv-btn ${v}${value === v ? ' on' : ''}${value === v && sent ? ' sent' : ''}`} aria-pressed={value === v} data-pid={`verdict-${v}`}
      onClick={(e) => { e.stopPropagation(); onSet(value === v && !sent ? null : v) }}>
      {icon}{(label || words) && <span>{word}</span>}
    </button>
  )
  return <span className={`rv-btns${big ? ' big' : ''}${dim ? ' dim' : ''}`}>{b('reject', <XIcon size={11} />, no)}{b('approve', <CheckIcon size={11} />, yes)}</span>
}

// The agent's text in a review: what it changed, their state, what to test, what it needs (in a reply,
// AssistantMessage.tsx renders it, so you can comment on it and react to it).
const Say = ({ text }: { text?: string }) => text ? <div className="md rv-say" dangerouslySetInnerHTML={{ __html: renderMd(text) }} /> : null

// In the Files tab the agent's text is closed until you ask for it.
function Details({ text }: { text?: string }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return <>
    <button className="link rv-details" onClick={(e) => { e.stopPropagation(); setOpen(!open) }}>{open ? 'Hide details' : 'Show details'}</button>
    {open && <Say text={text} />}
  </>
}

// What a review waits for, in words.


// Your decision on a review, with a note: Approve approves all its files, Reject rejects all of them. It follows its files when they all get the same verdict (review.ts setFileVerdict).
// The note box is there before you decide too, for a note on files you approve and reject one by one.
type Review = { key: string; label: string; files: string[]; asked?: boolean }
function Decision({ sid, g, rel, ro }: { sid: string; g: Review; rel(p: string): string; ro: boolean }) {
  const v = verdictsOf(sid)(g.key, '')
  const d = decisionOf(sid, g.key)
  return <>
    {!ro && (
      <div className="rv-decide">
        <textarea className="rv-text" rows={2} placeholder={v.verdict === 'reject' ? 'What is wrong (optional)' : 'A note for the agent (optional)'} value={d?.text ?? ''}
          onChange={(e) => setDecisionText(sid, g.key, g.label, e.target.value)} onClick={(e) => e.stopPropagation()} />
        <VerdictButtons value={v.verdict} sent={v.sent} onSet={(x) => decide(sid, g, rel, x)} label big dim={reviewStatus(sid, g).mixed} />
      </div>
    )}
  </>
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
        const status = g.asked ? reviewStatus(m.id, g) : undefined
        const left = status ? (status.done ? 0 : 1) : vs.filter((v) => !v.verdict).length
        const same = vs.length && vs.every((v) => v.verdict === vs[0].verdict) ? vs[0].verdict : undefined
        const open = (left > 0) !== flip.has(g.key)
        const toggle = () => setFlip((s) => { const x = new Set(s); if (x.has(g.key)) x.delete(g.key); else x.add(g.key); return x })
        const all = (v: Verdict | null) => { for (const f of g.files) setVerdict(m.id, g.key, f, rel(f), v) }
        return (
          <div key={g.key} className={`rv-group${g.asked ? ' asked' : ''}`} data-pid={`review-group-${g.key}`}>
            <div className="rv-ghead" onClick={toggle}>
              <span className={`fb-chev${open ? ' open' : ''}`}><ChevronIcon size={10} /></span>
              {g.asked && <span className="rv-asked">Asked</span>}
              <span className="rv-label">{g.label}</span>
              <span className="muted rv-meta">{g.live ? 'working' : status ? status.word : left ? `${left} of ${g.files.length} left` : `${g.files.length} done`}</span>
              {!g.asked && <VerdictButtons value={same} sent={vs.every((v) => v.sent)} onSet={all} />}
            </div>
            {open && g.asked && <div className="rv-body"><Details text={g.text} /></div>}
            {open && g.files.map((f, i) => (
              <div key={f} className={`fb-row rv-file${isOn(f) ? ' on' : ''}`} role="button" tabIndex={0}
                onClick={() => onOpen(f, g.key)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(f, g.key) }}>
                <FileTypeIcon name={f} /><span className="fb-name">{baseName(f)}</span>
                <span className="fb-dir muted">{ltr(dirName(rel(f)))}</span>
                <VerdictButtons value={vs[i].verdict} sent={vs[i].sent} onSet={(v) => setFileVerdict(m.id, g, f, rel, v)} />
              </div>
            ))}
            {open && g.asked && <Decision sid={m.id} g={g} rel={rel} ro={false} />}
          </div>
        )
      })}
      {!shown.length && <div className="fb-note muted">Nothing waits for your decision.</div>}
      {sent > 0 && <button className="link rv-older" onClick={() => setDecided(!decided)}>{decided ? 'Hide what you decided' : `Show what you decided (${sent})`}</button>}
    </div>
  )
}

// A <review> tag in a reply: what the agent asks you to decide on, its files, and Go or No go.
// A click on a file opens it on its changes in the Files tab.
// block: the title's number among the message's blocks, for comments on it; children: the agent's text.
export function ReviewCard({ sid, group, title, block, files, live, children }: { sid: string; group: string; title: string; block: number; files: string[]; live: boolean; children: React.ReactNode }) {
  const st = useStore()
  const m = st.sessions.find((x) => x.id === sid)
  const cwd = m?.cwd ?? ''
  const of = verdictsOf(sid)
  const ro = !!state.share || live
  const paths = files.map((f) => resolve(f, cwd))
  const rel = (p: string) => p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p
  const review: Review = { key: group, label: title || 'Review', files: paths, asked: true }
  // Like an item to consider (AssistantMessage.tsx): orange until you decided on it or on each of its
  // files, green after; then the words say how you decided.
  const status = reviewStatus(sid, review)
  const st8 = status.done ? (status.sent ? 'answered' : 'drafted') : live ? 'live' : 'open'
  return (
    <div className={`rv-ask st-${st8}`} data-pid="review-card" data-item={group}>
      <div className="rv-ask-head">
        <div data-block={block} className="md-block rv-label" dangerouslySetInnerHTML={{ __html: renderInline(title || 'Review') }} />
        <span className={`rv-meta ${status.done ? (status.verdict === 'approve' ? 'rv-ok' : 'rv-bad') : 'muted'}`}>{status.word}</span>
      </div>
      <div className="rv-say">{children}</div>
      {paths.map((p) => {
        const fv = of(group, p)
        return (
          <div key={p} className="fb-row rv-file" role="button" tabIndex={0} onClick={() => openFile(sid, p, true, group)}>
            <FileTypeIcon name={p} /><span className="fb-name">{baseName(p)}</span>
            <span className="fb-dir muted">{ltr(dirName(rel(p)))}</span>
            {!ro && <VerdictButtons value={fv.verdict} sent={fv.sent} onSet={(x) => setFileVerdict(sid, review, p, rel, x)} />}
          </div>
        )
      })}
      <Decision sid={sid} g={review} rel={rel} ro={ro} />
    </div>
  )
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
