// The page's address says what shows: the session (s), the Artifacts page (page) with the
// artifact (a) and version (v) on it, Settings and its page (settings), and the artifact in the
// session's preview pane (a, v) and whether it takes the full width (wide). A change to one of
// these makes a history entry, so the browser's back and forward buttons go between them, and
// a reload or a copied link comes back to the same place.
// The preview pane and the sidebar (pane, side, rows, tab) are in it too, but a change to them
// changes the address in place, with no entry, and back and forward leave them as they are.
// So does any change the server makes (a session that is gone, an artifact an agent shows),
// and on a phone every change does: there the back swipe opens the sessions (main.tsx).

import { changed, onChanged, opened, quiet, state } from './store.ts'

// A link can open the New session dialog with its fields filled in, for another app to hand work
// over (Prolifica's Ask): ?new&cwd=…&title=…&prompt=…. It never starts a session by itself, since
// any page could link here: you look at it and press Create. The address drops these at once.
export type LinkedNew = { cwd: string; title: string; prompt: string }
export let linkedNew: LinkedNew | null = null
export function closeLinkedNew() { linkedNew = null; changed() }
const NEW_KEYS = ['new', 'cwd', 'title', 'prompt']

const phone = matchMedia('(max-width: 720px)')
const num = (x: string | null) => x != null && /^\d+$/.test(x) ? Number(x) : undefined

// What shows, as the address's two parts: where you are (nav), and how the panes are (look).
function encode(): { nav: URLSearchParams; look: URLSearchParams } {
  const nav = new URLSearchParams(), look = new URLSearchParams()
  if (state.selected) nav.set('s', state.selected)
  if (state.page === 'artifacts') {
    nav.set('page', 'artifacts')
    if (state.artifact) nav.set('a', state.artifact)
    if (state.artifactV != null) nav.set('v', String(state.artifactV))
  } else {
    const t = state.preview[state.selected]?.target
    if (state.previewPane && t && 'artifact' in t) {
      nav.set('a', t.artifact)
      if (t.v != null) nav.set('v', String(t.v))
    }
  }
  if (state.previewWide) nav.set('wide', '1')
  if (state.settingsPage) nav.set('settings', state.settingsPage)
  if (!state.previewPane) look.set('pane', 'off')
  if (state.sideHidden) look.set('side', 'hidden')
  if (state.sideAll) look.set('rows', 'all')
  if (state.sideTab === 'remote') look.set('tab', 'remote')
  return { nav, look }
}

// Show what an address says. look: the panes and the sidebar too (on a load, not on back or forward).
function apply(q: URLSearchParams, look: boolean) {
  // On back or forward, an address with no session is the blank view.
  const s = q.get('s') ?? (look ? state.selected : '')
  state.selected = s
  state.page = q.get('page') === 'artifacts' ? 'artifacts' : null
  const a = q.get('a'), v = num(q.get('v'))
  if (state.page) { state.artifact = a; state.artifactV = v }
  else if (a && s) {
    const t = state.preview[s]?.target
    if (!t || !('artifact' in t) || t.artifact !== a || t.v !== v) state.preview = { ...state.preview, [s]: { target: { artifact: a, v }, at: 0 } }
  }
  state.previewWide = q.get('wide') === '1'
  state.settingsPage = q.get('settings')
  if (!look) return
  if (!phone.matches) state.previewPane = q.get('pane') !== 'off'
  state.sideHidden = q.get('side') === 'hidden'
  state.sideAll = q.get('rows') === 'all'
  state.sideTab = q.get('tab') === 'remote' ? 'remote' : 'local'
}

let lastNav = ''
function sync() {
  const { nav, look } = encode()
  const key = nav.toString()
  const all = [key, look.toString()].filter(Boolean).join('&')
  const url = `${location.pathname}${all ? `?${all}` : ''}${location.hash}`
  const push = key !== lastNav && !quiet && !phone.matches && state.loaded
  lastNav = key
  if (url === `${location.pathname}${location.search}${location.hash}`) return
  if (push) history.pushState(null, '', url)
  else history.replaceState(history.state, '', url)
}

export function initUrl() {
  const q = new URLSearchParams(location.search)
  if (q.has('new') || q.has('prompt')) linkedNew = { cwd: q.get('cwd') ?? '', title: q.get('title') ?? '', prompt: q.get('prompt') ?? '' }
  for (const k of NEW_KEYS) q.delete(k)
  // A bare address keeps what you had open last time (saved in the browser).
  if (q.size) apply(q, true)
  onChanged(sync)
  sync()
  addEventListener('popstate', (e) => {
    if (phone.matches || (e.state && e.state.side)) return
    const was = state.selected
    apply(new URLSearchParams(location.search), false)
    if (state.selected !== was) opened(state.selected)
    // The panes and the sidebar stay as they are: write them back into this entry.
    lastNav = encode().nav.toString()
    changed()
  })
}
