// The changes for review (the For review section of the Files tab, components/Review.tsx): a group is
// the files the agent wrote or edited in one turn. Your verdicts wait as drafts (store.ts VerdictDraft)
// until you send; then the sent message keeps them (a 'review' part), so the counts still know them.

import type { Event } from '../../shared/types.ts'
import type { Verdict } from '../../shared/review.ts'
import { addDraft, changed, draftsOf, removeDraft, state, uid, type LineDraft, type VerdictDraft } from './store.ts'

// key: the seq of the message that started the turn ('0' before the first one).
export type Group = { key: string; label: string; ts: number; files: string[]; live: boolean }

const EDIT = /^(Write|Edit|MultiEdit|NotebookEdit)$/
// The agent's own notes and memory are not changes to review.
const own = (p: string) => /[\\/]\.codinger[\\/]notes[\\/]/.test(p) || (!!state.home && p.startsWith(`${state.home}/.claude/`))

const firstWords = (e: Extract<Event, { t: 'user' }>) => {
  const p = e.parts.find((x) => x.kind === 'text' && x.text.trim()) ?? e.parts.find((x) => x.kind === 'mail')
  if (p?.kind === 'mail') return `Message from ${p.title}`
  const t = (p?.text ?? '').replace(/\s+/g, ' ').trim()
  return t ? (t.length > 60 ? t.slice(0, 60) + '…' : t) : 'Your replies'
}

// The groups, newest first. busy: the agent still works on the last turn.
export function groupsOf(sid: string, busy: boolean): Group[] {
  const out: Group[] = []
  let cur: Group = { key: '0', label: 'Start of the session', ts: 0, files: [], live: false }
  const close = () => { if (cur.files.length) out.push(cur) }
  for (const e of state.events[sid] ?? []) {
    if (e.t === 'user') { close(); cur = { key: String(e.seq), label: firstWords(e), ts: e.ts, files: [], live: false }; continue }
    if (e.t !== 'assistant') continue
    for (const b of e.blocks) {
      if (b.type !== 'tool_use' || !EDIT.test(b.name)) continue
      const p = b.input?.file_path ?? b.input?.notebook_path
      if (typeof p === 'string' && !own(p) && !cur.files.includes(p)) cur.files.push(p)
    }
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

// What each file of each group has: your draft, or else what you sent.
export function verdictsOf(sid: string): (group: string, path: string) => { verdict?: Verdict; sent: boolean } {
  const sent = sentOf(sid)
  const drafts = new Map(draftsOf(sid).flatMap((d) => d.kind === 'verdict' ? [[k(d.group, d.path), d.verdict] as const] : []))
  return (group, path) => {
    const d = drafts.get(k(group, path))
    if (d) return { verdict: d, sent: false }
    const s = sent.get(k(group, path))
    return { verdict: s, sent: !!s }
  }
}

// A click on the verdict a file has takes your draft back; a verdict equal to the sent one is no draft.
export function setVerdict(sid: string, group: string, path: string, rel: string, verdict: Verdict | null) {
  const sent = sentOf(sid).get(k(group, path))
  state.drafts[sid] = draftsOf(sid).filter((d) => !(d.kind === 'verdict' && d.group === group && d.path === path))
  if (verdict && verdict !== sent) state.drafts[sid].push({ id: uid(), kind: 'verdict', group, path, rel, verdict, createdAt: Date.now() } satisfies VerdictDraft)
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
