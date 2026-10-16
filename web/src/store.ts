// The browser's whole state, in one mutable object with a version counter.
// Components re-render on any change; at this scale that's plenty.

import { useSyncExternalStore } from 'react'
import type { AgentInfo, Anchor, AuthState, Event, ImageRef, InboxItem, Live, Part, Person, ServerMsg, SessionMeta, Settings, Task, Usage } from '../../shared/types.ts'
import { inboxParts } from '../../shared/inbox.ts'
import { itemsOf } from '../../shared/blocks.ts'
import { applyAppearance, holdingAppearance } from './appearance.ts'

// reaction: an emoji alone, shown at the left of its passage, not as a card;
// whole: on a whole paragraph or list item (the reaction button), so not highlighted.
export type NoteDraft = { id: string; kind: 'note'; anchor: Anchor; quote: string; text: string; images: ImageRef[]; createdAt: number; itemKey?: string; reaction?: boolean; whole?: boolean }
// original: for a <draft>, the text as Claude wrote it; approved: it goes back as it is (edits go back anyway).
export type AnswerDraft = { id: string; kind: 'answer'; askKey: string; question: string; choices: string[]; text: string; images: ImageRef[]; createdAt: number; original?: string; approved?: boolean }
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
  commentButton: boolean      // selecting text offers a Comment button instead of opening one (Transcript)
  money: 'usd' | 'pct' | 'week'   // costs in dollars, or as a share of the 5-hour or weekly limit (web/src/cache.ts)
  runs: Record<string, Run>
  tasks: Task[]   // long-running commands agents started (server/tasks.ts)
  fileTick: Record<string, number>   // bumped when a tracked file gets a new version
  stale: boolean                     // the server's code on disk is newer than the server
  restarting: boolean
  loaded: boolean                    // the server's hello came: sessions and settings are real
  agent: AgentInfo | null            // Codiner is this agent's desk (server/agent.ts)
  me: Person | null                  // who this browser is, as the proxy says
  people: Person[]                   // who has the page open now (server: 'people')
  askName: boolean                   // nobody says: ask this browser's person for a name (CODINER_ASK_NAME)
  billing: 'api' | 'plan'            // 'api': billed per token, so no plan limits to show
  seenAt: number | null              // offline: when the session list shown was last current
}

const saved = <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? '') ?? d } catch { return d } }

export const state: State = {
  connected: false,
  loaded: false,
  sessions: [],
  settings: { leadAutoSend: false },
  usage: {},
  events: {},
  streaming: {},
  selected: saved('codiner.selected', 'lead'),
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
  commentButton: saved('codiner.commentButton', false),
  // 'both' was a choice until October 2026.
  money: (['usd', 'pct', 'week'] as const).find((x) => x === saved('codiner.money', 'pct')) ?? 'pct',
  runs: {},
  tasks: [],
  fileTick: {},
  stale: false,
  restarting: false,
  agent: null,
  me: null,
  askName: false,
  people: [],
  billing: 'plan',
  seenAt: null,
}

// Offline, the page shows the sessions as they were last seen (public/sw.js caches
// the page and each conversation). The real hello replaces it.
type Seen = { at: number; sessions: SessionMeta[]; settings: Settings; agent: AgentInfo | null; me: Person | null; billing: 'api' | 'plan' }
{
  const seen = saved<Seen | null>('codiner.seen', null)
  if (seen) Object.assign(state, { sessions: seen.sessions, settings: seen.settings, agent: seen.agent, me: seen.me, billing: seen.billing, seenAt: seen.at })
  if (seen?.billing === 'api') state.money = 'usd'
}
let seenTimer = 0
function keepSeen() {
  clearTimeout(seenTimer)
  seenTimer = window.setTimeout(() => {
    const seen: Seen = { at: Date.now(), sessions: state.sessions, settings: state.settings, agent: state.agent, me: state.me, billing: state.billing }
    try { localStorage.setItem('codiner.seen', JSON.stringify(seen)) } catch { /* full: offline shows less */ }
  }, 2000)
}

let version = 0
const listeners = new Set<() => void>()
let persistTimer = 0
export function changed() {
  version++
  for (const l of listeners) l()
  reportDrafting()
  reportLive()
  clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    localStorage.setItem('codiner.drafts', JSON.stringify(state.drafts))
    localStorage.setItem('codiner.composer', JSON.stringify(state.composer))
    localStorage.setItem('codiner.selected', JSON.stringify(state.selected))
    localStorage.setItem('codiner.showSteps', JSON.stringify(state.showSteps))
    localStorage.setItem('codiner.commentButton', JSON.stringify(state.commentButton))
  }, 300)
}
// Tell the server which sessions you are writing a reply in, so the lead's
// drafts wait for yours instead of going ahead of them.
const drafting = new Map<string, boolean>()
let draftingTimer: number | undefined
function reportDrafting() {
  if (draftingTimer) return
  draftingTimer = window.setTimeout(() => {
    draftingTimer = undefined
    if (!state.loaded) return
    for (const m of state.sessions) {
      if (m.kind !== 'worker') continue
      const c = composerOf(m.id)
      const on = draftsOf(m.id).some(hasContent) || !!c.text.trim() || c.images.length > 0
      if (on === (drafting.get(m.id) ?? !!m.drafting)) continue
      drafting.set(m.id, on)
      void api(`/api/sessions/${m.id}/drafting`, 'POST', { on }).catch(() => drafting.delete(m.id))
    }
  }, 600)
}

// When Codiner knows who you are, what you write goes up as you write it (server 'live'),
// so the others at the desk see it, and the next send from anyone takes it along.
// What went up last, by session: the parts, and the drafts and message they came from,
// so a send that took them clears just those (onServer 'taken').
type Pushed = { rev: number; json: string; drafts: Map<string, string>; text: string; images: string }
const pushed = new Map<string, Pushed[]>()
let liveTimer: number | undefined
function reportLive() {
  if (liveTimer || !state.me || !state.connected) return
  liveTimer = window.setTimeout(() => {
    liveTimer = undefined
    if (!state.me || !state.connected) return
    for (const m of state.sessions) {
      const c = composerOf(m.id)
      // A slash command is for its writer alone: it shows no one and goes by itself.
      const command = /^\/[\w:.-]+/.test(c.text.trim()) && !c.images.length
      const parts = queuedParts(m.id, [], { lead: false, text: !command })
      const json = JSON.stringify(parts)
      const list = pushed.get(m.id) ?? []
      if (json === (list.at(-1)?.json ?? '[]')) continue
      const rev = Math.max(Date.now(), (list.at(-1)?.rev ?? 0) + 1)
      pushed.set(m.id, [...list.slice(-9), { rev, json, drafts: new Map(draftsOf(m.id).map((d) => [d.id, JSON.stringify(d)])), text: command ? '' : c.text, images: command ? '[]' : JSON.stringify(c.images) }])
      void api(`/api/sessions/${m.id}/live`, 'POST', { rev, parts }).catch(() => pushed.delete(m.id))
    }
  }, 250)
}
// A send took what you wrote, up to rev: what is still as it was then goes.
function takenLive(sid: string, rev: number) {
  const snap = pushed.get(sid)?.find((p) => p.rev === rev)
  if (!snap) return
  state.drafts[sid] = draftsOf(sid).filter((d) => snap.drafts.get(d.id) !== JSON.stringify(d))
  const c = composerOf(sid)
  if (c.text === snap.text && JSON.stringify(c.images) === snap.images) state.composer[sid] = { text: '', images: [] }
  pushed.set(sid, (pushed.get(sid) ?? []).filter((p) => p.rev > rev))
}
// What the others at the desk are writing in a session now.
export const othersLive = (m: SessionMeta | undefined): Live[] => (m?.live ?? []).filter((l) => l.id !== state.me?.login)

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
    // An error shows for a while, then goes (a click closes it sooner).
    const shown = state.error
    setTimeout(() => { if (state.error === shown) { state.error = null; changed() } }, 8000)
    changed()
    throw new Error(state.error!)
  }
  return j
}

// The name this browser's person gave (CODINER_ASK_NAME). The server reads the cookie;
// localStorage keeps it if the cookie goes.
export function setGuestName(name: string) {
  localStorage.setItem('codiner.name', name)
  document.cookie = `codiner.name=${encodeURIComponent(name)}; path=/; max-age=31536000; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`
}
{
  const kept = localStorage.getItem('codiner.name')
  if (kept && !document.cookie.split(/;\s*/).some((c) => c.startsWith('codiner.name='))) setGuestName(kept)
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
  ws.onclose = () => { state.connected = false; state.people = []; changed(); setTimeout(connect, 1000) }
}

function onServer(m: ServerMsg) {
  switch (m.type) {
    case 'hello':
      state.sessions = m.sessions; state.settings = m.settings; state.usage = m.usage; state.loaded = true
      applyAppearance(m.settings.appearance)
      state.platform = m.platform; state.home = m.home; state.auth = m.auth ?? { state: 'ok' }; state.stale = !!m.stale; state.restarting = false
      state.agent = m.agent ?? null; state.me = m.me ?? null; state.askName = !!m.askName; state.billing = m.billing ?? 'plan'
      if (state.billing === 'api') state.money = 'usd'
      state.seenAt = null; keepSeen()
      // The server may have restarted and lost what was live: send it all again.
      pushed.clear()
      if (!m.sessions.some((s) => s.id === state.selected)) state.selected = 'lead'
      break
    case 'sessions': state.sessions = m.sessions; keepSeen(); break
    case 'settings':
      if (holdingAppearance()) { state.settings = { ...m.settings, appearance: state.settings.appearance }; break }
      state.settings = m.settings; applyAppearance(m.settings.appearance); break
    case 'usage': state.usage = m.usage; break
    case 'tasks': state.tasks = m.tasks; break
    case 'people': state.people = m.people; break
    case 'taken': if (m.login === state.me?.login) takenLive(m.sessionId, m.rev); break
    case 'auth': state.auth = m.auth; break
    case 'stale': state.stale = m.stale; break
    case 'file': state.fileTick = { ...state.fileTick, [m.path]: (state.fileTick[m.path] ?? 0) + 1 }; break
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

// Open a session at one of its events (a message, or the tool call in an activity row).
export function revealEvent(sid: string, seq: number) {
  select(sid)
  const find = (n: number) => {
    const el = document.querySelector<HTMLElement>(`[data-sid="${sid}"][data-msg^="${seq}."]`)
      ?? [...document.querySelectorAll<HTMLElement>('.activity[data-seqs]')].find((a) => a.dataset.seqs!.split(',').includes(String(seq)))
    if (!el) { if (n < 30) setTimeout(() => find(n + 1), 150); return }
    if (el.classList.contains('activity') && !el.classList.contains('open')) el.querySelector<HTMLElement>('.activity-line')?.click()
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash')
  }
  setTimeout(() => find(0), 50)
}

// Closing archives the session (its process ends; Reopen brings it back).
export async function closeSession(id: string) {
  await api(`/api/sessions/${id}`, 'PATCH', { archived: true })
  if (state.selected === id) select('lead')
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
  // A draft goes back when edited, or approved as it is.
  if (d.kind === 'answer' && d.original != null) return !!d.text.trim() && (d.text.trim() !== d.original.trim() || !!d.approved)
  return !!(d.text.trim() || d.images.length || (d.kind === 'answer' && d.choices.length))
}

// The questions and items directly inside an item to consider.
function nestedIn(sid: string, key: string): { key: string; label: string }[] {
  const at = key.indexOf(':'), msg = key.slice(0, at), id = key.slice(at + 1)
  const [seq, i] = msg.split('.').map(Number)
  const e = state.events[sid]?.find((x) => x.t === 'assistant' && x.seq === seq)
  const b = e?.t === 'assistant' ? e.blocks[i] : undefined
  return b?.type === 'text' ? itemsOf(b.text).filter((it) => it.parent === id).map((it) => ({ key: `${msg}:${it.id}`, label: it.label })) : []
}

export function dismissItem(sid: string, key: string, label: string) {
  if (draftsOf(sid).some((d) => d.kind === 'dismiss' && d.key === key)) return
  // An untouched reply card for it goes too.
  const keep = draftsOf(sid).filter((d) => !(d.kind === 'note' && d.itemKey === key && !hasContent(d)) && !(d.kind === 'answer' && d.askKey === key && !hasContent(d)))
  state.drafts[sid] = [...keep, { id: uid(), kind: 'dismiss', key, label, createdAt: Date.now() }]
  // So do the questions inside it, which it hides.
  for (const n of nestedIn(sid, key)) dismissItem(sid, n.key, n.label)
  changed()
}
export function undismissItem(sid: string, key: string) {
  const nested = new Set(nestedIn(sid, key).map((n) => n.key))
  state.drafts[sid] = draftsOf(sid).filter((d) => !((d.kind === 'dismiss' || d.kind === 'done') && d.key === key))
  for (const n of nested) undismissItem(sid, n)
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
// The lead's drafts (shared/inbox.ts) go with yours: its replies in reading
// order among your own, its message after yours.
export const inboxOf = (sid: string): InboxItem[] => state.sessions.find((s) => s.id === sid)?.inbox ?? []

// opts.lead false: only your own (no lead's drafts); opts.text false: not the composer.
export function queuedParts(sid: string, alsoDismiss: { key: string; label: string }[] = [], opts: { lead?: boolean; text?: boolean } = {}): Part[] {
  const mine = draftsOf(sid)
  // Your own reply to an item wins over the lead's.
  const yours = new Set(mine.flatMap((d) => d.kind === 'note' && d.itemKey && hasContent(d) ? [d.itemKey] : d.kind === 'answer' && hasContent(d) ? [d.askKey] : d.kind === 'dismiss' || d.kind === 'done' ? [d.key] : []))
  const lead = opts.lead === false ? [] : inboxOf(sid).filter((i) => !i.key || !yours.has(i.key))
  const leadKeys = new Set(lead.flatMap((i) => i.key ? [i.key] : []))
  const dismissed = [
    ...mine.flatMap((d) => d.kind === 'dismiss' ? [{ key: d.key, label: d.label }] : []),
    ...lead.flatMap((i) => i.kind === 'dismiss' && i.key ? [{ key: i.key, label: i.label ?? '' }] : []),
    ...alsoDismiss.filter((i) => !leadKeys.has(i.key)),
  ]
  const done = [
    ...mine.flatMap((d) => d.kind === 'done' ? [{ key: d.key, label: d.label, ...(d.text.trim() ? { text: d.text.trim() } : {}), ...(d.result ? { result: d.result } : {}) }] : []),
    ...lead.flatMap((i) => i.kind === 'done' && i.key ? [{ key: i.key, label: i.label ?? '', ...(i.text.trim() ? { text: i.text.trim() } : {}) }] : []),
  ]
  const keyed: { p: Part; k: number[]; t: number }[] = mine.filter((d): d is NoteDraft | AnswerDraft => (d.kind === 'note' || d.kind === 'answer') && hasContent(d)).map((d) => d.kind === 'note'
    ? { p: { kind: 'note', text: d.text, quote: d.quote, anchor: d.anchor, images: d.images, ...(d.itemKey ? { itemKey: d.itemKey } : {}), ...(d.whole ? { whole: true } : {}) }, k: [...order(d.anchor.msg), d.anchor.pieces.at(-1)?.block ?? 0], t: d.createdAt }
    : { p: { kind: 'answer', text: d.text, askKey: d.askKey, question: d.question, choices: d.choices, images: d.images, ...(d.original != null ? { draft: d.text.trim() === d.original.trim() ? 'same' as const : 'edited' as const } : {}) }, k: [...order(d.askKey.split(':')[0]), 9999], t: d.createdAt })
  for (const i of lead) if ((i.kind === 'answer' || i.kind === 'reply') && i.key) keyed.push({ p: inboxParts([i])[0], k: [...order(i.key.split(':')[0]), 9999], t: i.ts })
  keyed.sort((a, b) => cmp(a.k, b.k) || a.t - b.t)
  const parts: Part[] = keyed.map((x) => x.p)
  if (done.length) parts.push({ kind: 'done', text: '', items: done })
  if (dismissed.length) parts.push({ kind: 'dismiss', text: '', items: dismissed })
  const c = composerOf(sid)
  if (opts.text !== false && (c.text.trim() || c.images.length)) parts.push({ kind: 'text', text: c.text, images: c.images })
  parts.push(...inboxParts(lead.filter((i) => !i.kind || i.kind === 'text')))
  return parts
}

export async function sendQueued(sid: string, alsoDismiss: { key: string; label: string }[] = []) {
  const parts = queuedParts(sid, alsoDismiss)
  // Held replies and the others' live ones alone make a message too: the server adds them (server/index.ts 'send').
  const m = state.sessions.find((s) => s.id === sid)
  if (!parts.length && !m?.held?.length && !othersLive(m).length) return
  await api(`/api/sessions/${sid}/send`, 'POST', { parts, inbox: inboxOf(sid).map((i) => i.id) })
  state.drafts[sid] = []
  state.composer[sid] = { text: '', images: [] }
  changed()
}

// The agent's name where the UI would say "Claude".
export const agentName = () => state.agent?.name ?? 'Claude'

// Delete one of your messages and everything after it; with parts, send them
// in its place (an edit).
export async function rewind(sid: string, seq: number, parts?: Part[]) {
  await api(`/api/sessions/${sid}/rewind`, 'POST', { seq, ...(parts ? { parts } : {}) })
}

export const uid = () => Math.random().toString(36).slice(2, 10)
