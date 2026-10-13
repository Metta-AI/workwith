// The browser's whole state, in one mutable object with a version counter.
// Components re-render on any change; at this scale that's plenty.

import { useSyncExternalStore } from 'react'
import type { Anchor, AuthState, Event, ImageRef, Part, ServerMsg, SessionMeta, Settings, Usage } from '../../shared/types.ts'

// reaction: an emoji alone, shown at the left of its passage, not as a card;
// whole: on a whole paragraph or list item (the reaction button), so not highlighted.
export type NoteDraft = { id: string; kind: 'note'; anchor: Anchor; quote: string; text: string; images: ImageRef[]; createdAt: number; itemKey?: string; reaction?: boolean; whole?: boolean }
export type AnswerDraft = { id: string; kind: 'answer'; askKey: string; question: string; choices: string[]; text: string; images: ImageRef[]; createdAt: number }
// A question or item set aside without a reply ("<msg>:<id>").
export type DismissDraft = { id: string; kind: 'dismiss'; key: string; label: string; createdAt: number }
// An item you did ("<msg>:<id>"); text: a problem you hit doing it.
export type DoneDraft = { id: string; kind: 'done'; key: string; label: string; text: string; result?: string; createdAt: number }
// A command opened in Terminal from a <run> block (by token), and how it ended.
export type Run = { sid: string; card: string; command: string; item?: { key: string; label: string }; code?: number; tail?: string }
export type Draft = NoteDraft | AnswerDraft | DismissDraft | DoneDraft
export type Composer = { text: string; images: ImageRef[] }

type State = {
  connected: boolean
  sessions: SessionMeta[]
  settings: Settings
  usage: Usage
  events: Record<string, Event[]>
  streaming: Record<string, string>
  selected: string
  drafts: Record<string, Draft[]>
  composer: Record<string, Composer>
  focus: string | null       // a draft id whose textarea should take focus
  showArchived: boolean
  error: string | null
  platform: string
  home: string
  auth: AuthState
  lightbox: string | null     // an image shown full size
  showSteps: boolean          // keep Claude's in-between messages out of the activity rows
  runs: Record<string, Run>
}

const saved = <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? '') ?? d } catch { return d } }

export const state: State = {
  connected: false,
  sessions: [],
  settings: { masterAutoSend: false },
  usage: {},
  events: {},
  streaming: {},
  selected: saved('codiner.selected', 'master'),
  drafts: saved('codiner.drafts', {}),
  composer: saved('codiner.composer', {}),
  focus: null,
  showArchived: false,
  error: null,
  platform: '',
  home: '',
  auth: { state: 'ok' },
  lightbox: null,
  showSteps: saved('codiner.showSteps', false),
  runs: {},
}

let version = 0
const listeners = new Set<() => void>()
let persistTimer = 0
export function changed() {
  version++
  for (const l of listeners) l()
  clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    localStorage.setItem('codiner.drafts', JSON.stringify(state.drafts))
    localStorage.setItem('codiner.composer', JSON.stringify(state.composer))
    localStorage.setItem('codiner.selected', JSON.stringify(state.selected))
    localStorage.setItem('codiner.showSteps', JSON.stringify(state.showSteps))
  }, 300)
}
export function useStore(): State {
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => version)
  return state
}

// ---- server ---------------------------------------------------------------------

export async function api<T = any>(path: string, method = 'POST', body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    state.error = j.error ?? `${r.status} ${r.statusText}`
    changed()
    throw new Error(state.error!)
  }
  return j
}

export function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.onmessage = (m) => onServer(JSON.parse(m.data))
  ws.onopen = () => {
    state.connected = true
    // Anything that happened while we were away: reload what we had open.
    for (const id of Object.keys(state.events)) void loadEvents(id, true)
    changed()
  }
  ws.onclose = () => { state.connected = false; changed(); setTimeout(connect, 1000) }
}

function onServer(m: ServerMsg) {
  switch (m.type) {
    case 'hello':
      state.sessions = m.sessions; state.settings = m.settings; state.usage = m.usage
      state.platform = m.platform; state.home = m.home; state.auth = m.auth ?? { state: 'ok' }
      if (!m.sessions.some((s) => s.id === state.selected)) state.selected = 'master'
      break
    case 'sessions': state.sessions = m.sessions; break
    case 'settings': state.settings = m.settings; break
    case 'usage': state.usage = m.usage; break
    case 'auth': state.auth = m.auth; break
    case 'run': {
      const run = state.runs[m.token]
      if (!run) break
      Object.assign(run, { code: m.code, tail: m.tail })
      // The command an item asked for ended: the item is done, with how it went.
      if (run.item && !draftsOf(run.sid).some((d) => d.kind === 'dismiss' && d.key === run.item!.key)) {
        markDone(run.sid, run.item.key, run.item.label)
        const result = `$ ${run.command}\nexit code ${m.code}${m.tail ? `\n${m.tail}` : ''}`
        state.drafts[run.sid] = draftsOf(run.sid).map((d) => d.kind === 'done' && d.key === run.item!.key ? { ...d, result } : d)
      }
      break
    }
    case 'event': {
      const list = state.events[m.sessionId]
      if (list && (!list.length || list[list.length - 1].seq < m.event.seq)) state.events[m.sessionId] = [...list, m.event]
      if (m.sessionId === state.selected && document.visibilityState === 'visible' && m.event.t === 'result') void api(`/api/sessions/${m.sessionId}/seen`).catch(() => {})
      break
    }
    case 'delta':
      state.streaming[m.sessionId] = m.reset ? '' : (state.streaming[m.sessionId] ?? '') + m.text
      break
    case 'truncate': {
      const list = state.events[m.sessionId]
      if (list) state.events[m.sessionId] = list.filter((e) => e.seq < m.seq)
      state.streaming[m.sessionId] = ''
      // Comments and answers on messages that are gone go with them.
      const gone = (msg: string) => Number(msg.split(/[.:]/)[0]) >= m.seq
      state.drafts[m.sessionId] = draftsOf(m.sessionId).filter((d) => !gone(d.kind === 'note' ? d.anchor.msg : d.kind === 'answer' ? d.askKey : d.key))
      break
    }
  }
  changed()
}

const loading = new Set<string>()
export async function loadEvents(id: string, force = false) {
  if ((!force && state.events[id]) || loading.has(id)) return
  loading.add(id)
  try {
    const ev = await api<Event[]>(`/api/sessions/${id}/events`, 'GET')
    // Merge with anything the socket delivered while we were fetching.
    const live = (state.events[id] ?? []).filter((e) => e.seq > (ev.at(-1)?.seq ?? 0))
    state.events[id] = [...ev, ...live]
    changed()
  } finally { loading.delete(id) }
}

export function select(id: string) {
  state.selected = id
  changed()
  void loadEvents(id)
  const s = state.sessions.find((x) => x.id === id)
  if (s?.unread) void api(`/api/sessions/${id}/seen`).catch(() => {})
}

// Closing archives the session (its process ends; Reopen brings it back).
export async function closeSession(id: string) {
  await api(`/api/sessions/${id}`, 'PATCH', { archived: true })
  if (state.selected === id) select('master')
}

// ---- drafts -------------------------------------------------------------------------

export const draftsOf = (sid: string) => state.drafts[sid] ?? []
export const composerOf = (sid: string): Composer => state.composer[sid] ?? { text: '', images: [] }

export function addDraft(sid: string, d: Draft) {
  state.drafts[sid] = [...draftsOf(sid), d]
  state.focus = d.id
  changed()
}
export function updateDraft(sid: string, id: string, patch: Partial<NoteDraft> | Partial<AnswerDraft>) {
  state.drafts[sid] = draftsOf(sid).map((d) => d.id === id ? { ...d, ...patch } as Draft : d)
  changed()
}
export function removeDraft(sid: string, id: string) {
  state.drafts[sid] = draftsOf(sid).filter((d) => d.id !== id)
  changed()
}
export function setComposer(sid: string, c: Partial<Composer>) {
  state.composer[sid] = { ...composerOf(sid), ...c }
  changed()
}

const order = (msg: string) => msg.split(/[.:]/).map(Number)
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); return 0 }

export function hasContent(d: Draft): boolean {
  if (d.kind === 'dismiss' || d.kind === 'done') return true
  return !!(d.text.trim() || d.images.length || (d.kind === 'answer' && d.choices.length))
}

export function dismissItem(sid: string, key: string, label: string) {
  if (draftsOf(sid).some((d) => d.kind === 'dismiss' && d.key === key)) return
  // An untouched reply card for it goes too.
  const keep = draftsOf(sid).filter((d) => !(d.kind === 'note' && d.itemKey === key && !hasContent(d)) && !(d.kind === 'answer' && d.askKey === key && !hasContent(d)))
  state.drafts[sid] = [...keep, { id: uid(), kind: 'dismiss', key, label, createdAt: Date.now() }]
  changed()
}
export function undismissItem(sid: string, key: string) {
  state.drafts[sid] = draftsOf(sid).filter((d) => !((d.kind === 'dismiss' || d.kind === 'done') && d.key === key))
  changed()
}

export function markDone(sid: string, key: string, label: string) {
  if (draftsOf(sid).some((d) => d.kind === 'done' && d.key === key)) return
  const keep = draftsOf(sid).filter((d) => !(d.kind === 'dismiss' && d.key === key) && !(d.kind === 'note' && d.itemKey === key && !hasContent(d)))
  state.drafts[sid] = [...keep, { id: uid(), kind: 'done', key, label, text: '', createdAt: Date.now() }]
  changed()
}
export function setDoneText(sid: string, key: string, text: string) {
  state.drafts[sid] = draftsOf(sid).map((d) => d.kind === 'done' && d.key === key ? { ...d, text } : d)
  changed()
}

// Everything queued for a session, in reading order: notes and answers in the
// order their passages appear, then whatever is in the composer.
export function queuedParts(sid: string, alsoDismiss: { key: string; label: string }[] = []): Part[] {
  const dismissed = [...draftsOf(sid).flatMap((d) => d.kind === 'dismiss' ? [{ key: d.key, label: d.label }] : []), ...alsoDismiss]
  const done = draftsOf(sid).flatMap((d) => d.kind === 'done' ? [{ key: d.key, label: d.label, ...(d.text.trim() ? { text: d.text.trim() } : {}), ...(d.result ? { result: d.result } : {}) }] : [])
  const keyed = draftsOf(sid).filter((d): d is NoteDraft | AnswerDraft => (d.kind === 'note' || d.kind === 'answer') && hasContent(d)).map((d) => {
    const k = d.kind === 'note' ? [...order(d.anchor.msg), d.anchor.pieces.at(-1)?.block ?? 0] : [...order(d.askKey.split(':')[0]), 9999]
    return { d, k }
  }).sort((a, b) => cmp(a.k, b.k) || a.d.createdAt - b.d.createdAt)
  const parts: Part[] = keyed.map(({ d }) => d.kind === 'note'
    ? { kind: 'note', text: d.text, quote: d.quote, anchor: d.anchor, images: d.images, ...(d.itemKey ? { itemKey: d.itemKey } : {}), ...(d.whole ? { whole: true } : {}) }
    : { kind: 'answer', text: d.text, askKey: d.askKey, question: d.question, choices: d.choices, images: d.images })
  if (done.length) parts.push({ kind: 'done', text: '', items: done })
  if (dismissed.length) parts.push({ kind: 'dismiss', text: '', items: dismissed })
  const c = composerOf(sid)
  if (c.text.trim() || c.images.length) parts.push({ kind: 'text', text: c.text, images: c.images })
  return parts
}

export async function sendQueued(sid: string, alsoDismiss: { key: string; label: string }[] = []) {
  const parts = queuedParts(sid, alsoDismiss)
  if (!parts.length) return
  await api(`/api/sessions/${sid}/send`, 'POST', { parts })
  state.drafts[sid] = []
  state.composer[sid] = { text: '', images: [] }
  changed()
}

// Delete one of your messages and everything after it; with parts, send them
// in its place (an edit).
export async function rewind(sid: string, seq: number, parts?: Part[]) {
  await api(`/api/sessions/${sid}/rewind`, 'POST', { seq, ...(parts ? { parts } : {}) })
}

export const uid = () => Math.random().toString(36).slice(2, 10)
