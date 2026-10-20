// The changes for review (the For review section of the Files tab, components/Review.tsx): a group is
// the files of a <review> tag in a reply (the agent asks for a decision), or else the files the agent
// wrote or edited in one turn. Your verdicts wait as drafts (store.ts VerdictDraft) until you send;
// then the sent message keeps them (a 'review' part).

import type { Event } from '../../shared/types.ts'
import type { Verdict } from '../../shared/review.ts'
import { reviewsOf } from '../../shared/blocks.ts'
import { addDraft, changed, draftsOf, localId, machineOf, media, removeDraft, state, uid, type LineDraft, type VerdictDraft } from './store.ts'

// key: for a turn, the seq of the message that started it ('0' before the first one); for a <review>
// tag, "<seq>.<block>:r<n>" (its message and its place in it). asked: the agent asked with a tag.
export type Group = { key: string; label: string; ts: number; files: string[]; live: boolean; asked?: boolean; text?: string }

const EDIT = /^(Write|Edit|MultiEdit|NotebookEdit)$/
// The agent's own notes and memory are not changes to review.
const own = (p: string) => /[\\/]\.codinger[\\/]notes[\\/]/.test(p) || (!!state.home && p.startsWith(`${state.home}/.claude/`))

const firstWords = (e: Extract<Event, { t: 'user' }>) => {
  const p = e.parts.find((x) => x.kind === 'text' && x.text.trim()) ?? e.parts.find((x) => x.kind === 'mail')
  if (p?.kind === 'mail') return `Message from ${p.title}`
  const t = (p?.text ?? '').replace(/\s+/g, ' ').trim()
  return t ? (t.length > 60 ? t.slice(0, 60) + '…' : t) : 'Your replies'
}

// A path in a <review> tag: absolute, ~/, or under the session's folder.
export const resolve = (p: string, cwd: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) ? p
  : p.startsWith('~/') && state.home ? state.home + p.slice(1)
  : cwd + '/' + p.replace(/^\.\//, '')

// The groups, newest first. busy: the agent still works on the last turn. The files of a turn that
// a <review> tag in it names are in that group, not in the turn's.
export function groupsOf(sid: string, cwd: string, busy: boolean): Group[] {
  const out: Group[] = []
  let cur: Group = { key: '0', label: 'Start of the session', ts: 0, files: [], live: false }
  let asked: Group[] = []
  const close = () => {
    const named = new Set(asked.flatMap((g) => g.files))
    cur.files = cur.files.filter((f) => !named.has(f))
    if (cur.files.length) out.push(cur)
    out.push(...asked)
    asked = []
  }
  for (const e of state.events[sid] ?? []) {
    if (e.t === 'user') { close(); cur = { key: String(e.seq), label: firstWords(e), ts: e.ts, files: [], live: false }; continue }
    if (e.t !== 'assistant' || e.synthetic) continue
    e.blocks.forEach((b, i) => {
      if (b.type === 'text') reviewsOf(b.text).forEach((r, n) => asked.push({ key: `${e.seq}.${i}:r${n + 1}`, label: r.title || 'Review', ts: e.ts, files: r.files.map((f) => resolve(f, cwd)), live: false, asked: true, text: r.text }))
      if (b.type !== 'tool_use' || !EDIT.test(b.name)) return
      const p = b.input?.file_path ?? b.input?.notebook_path
      if (typeof p === 'string' && !own(p) && !cur.files.includes(p)) cur.files.push(p)
    })
  }
  if (busy) cur.live = true
  close()
  return out.reverse()
}

const k = (group: string, path: string) => `${group}\n${path}`

// The verdicts sent before, by group and file; the last one wins.
function sentOf(sid: string): Map<string, Verdict> {
  const out = new Map<string, Verdict>()
  for (const e of state.events[sid] ?? []) if (e.t === 'user') for (const p of e.parts) if (p.kind === 'review') for (const f of p.files) out.set(k(f.group, f.path), f.verdict)
  return out
}

// What each file of each group has: your draft, or else what you sent; a file without a verdict of its
// own has the decision on its whole review (path ''). The decision itself: path ''.
export function verdictsOf(sid: string): (group: string, path: string) => { verdict?: Verdict; sent: boolean } {
  const sent = sentOf(sid)
  const drafts = new Map(draftsOf(sid).flatMap((d) => d.kind === 'verdict' ? [[k(d.group, d.path), d.verdict] as const] : []))
  return (group, path) => {
    const d = drafts.get(k(group, path)) ?? drafts.get(k(group, ''))
    if (d) return { verdict: d, sent: false }
    const s = sent.get(k(group, path)) ?? sent.get(k(group, ''))
    return { verdict: s, sent: !!s }
  }
}

// A click on the verdict a file has takes your draft back; a verdict equal to the sent one is no draft.
// path '': the decision on a whole review, rel its title; its note stays when the verdict changes.
export function setVerdict(sid: string, group: string, path: string, rel: string, verdict: Verdict | null) {
  const sent = sentOf(sid).get(k(group, path))
  const had = draftsOf(sid).find((d): d is VerdictDraft => d.kind === 'verdict' && d.group === group && d.path === path)
  state.drafts[sid] = draftsOf(sid).filter((d) => d !== had)
  if (verdict && (verdict !== sent || had?.text)) state.drafts[sid].push({ id: uid(), kind: 'verdict', group, path, rel, verdict, ...(had?.text ? { text: had.text } : {}), createdAt: Date.now() } satisfies VerdictDraft)
  changed()
}

// Your note with the decision on a whole review.
export const decisionOf = (sid: string, group: string) => draftsOf(sid).find((d): d is VerdictDraft => d.kind === 'verdict' && d.group === group && !d.path)
export function setDecisionText(sid: string, group: string, text: string) {
  state.drafts[sid] = draftsOf(sid).map((d) => d.kind === 'verdict' && d.group === group && !d.path ? { ...d, text } : d)
  changed()
}

export const linesOf = (sid: string, path: string) => draftsOf(sid).filter((d): d is LineDraft => d.kind === 'line' && d.path === path)

export function addLine(sid: string, c: Omit<LineDraft, 'id' | 'kind' | 'createdAt'>) {
  // A comment you did not write goes when you start another.
  for (const d of draftsOf(sid)) if (d.kind === 'line' && !d.text.trim()) removeDraft(sid, d.id)
  addDraft(sid, { id: uid(), kind: 'line', createdAt: Date.now(), ...c })
}

export function updateLine(sid: string, id: string, patch: Partial<Pick<LineDraft, 'text' | 'verdict'>>) {
  state.drafts[sid] = draftsOf(sid).map((d) => d.id === id && d.kind === 'line' ? { ...d, ...patch } : d)
  changed()
}

// The files of each session's folder with changes git has not committed (relative to the folder when
// they are in it); null: no git repository, or not known yet. Asked again 1.5 s after the agent did
// more, and when it is older than 15 s (a commit you made yourself).
const pending = new Map<string, { n: number; at: number; files: Set<string> | null; timer?: number }>()
export function uncommittedOf(sid: string): Set<string> | null {
  const n = state.events[sid]?.length ?? 0
  const had = pending.get(sid) ?? { n: -1, at: 0, files: null }
  if (had.timer || (had.n === n && Date.now() - had.at < 15000)) return had.files
  had.timer = window.setTimeout(() => {
    void fetch(media(`/api/sessions/${localId(sid)}/uncommitted`, machineOf(sid)))
      .then((r) => r.ok ? r.json() : { files: null })
      .then((j: { files: string[] | null }) => { pending.set(sid, { n, at: Date.now(), files: j.files ? new Set(j.files) : null }); changed() })
      .catch(() => { pending.set(sid, { n, at: Date.now(), files: null }) })
  }, had.n < 0 ? 0 : 1500)
  pending.set(sid, had)
  return had.files
}
