// Push notifications in this browser: when a session finishes a turn you did not see, asks you
// something, or needs a permission (server/index.ts, notifyOnChange). web.codinger.app keeps the
// subscriptions and sends the pushes (remote/src/push.ts), so a machine's own page subscribes
// through its machine, which must be connected there. The service worker (public/sw.js) shows
// them, and a click on one opens its session here.

import { globalId, ROOT, select, state } from './store.ts'

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && isSecureContext

// The hub's push routes: on web.codinger.app itself, or through this machine.
const base = () => state.web ? '/_remote/push' : `${ROOT}/api/remote/push`
const post = (path: string, body: unknown) =>
  fetch(base() + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`)
  })

async function registration() {
  await navigator.serviceWorker.register(`${ROOT}/sw.js`, { scope: `${ROOT}/` })
  return navigator.serviceWorker.ready
}

export async function pushSubscribed(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false
  const reg = await navigator.serviceWorker.getRegistration(`${ROOT}/`)
  return !!await reg?.pushManager.getSubscription()
}

// Ask for permission, then subscribe with the hub's key. A subscription with another key (a hub
// that made a new one) goes first: a browser takes one key for each site.
export async function enablePush() {
  if (await Notification.requestPermission() !== 'granted') throw new Error('The browser blocks notifications for this site. Allow them in the site settings, then try again.')
  const reg = await registration()
  const r = await fetch(base() + '/key')
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`)
  const { key } = await r.json() as { key: string }
  const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  let sub = await reg.pushManager.getSubscription()
  const had = sub?.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey)
  if (sub && (!had || had.length !== raw.length || had.some((b, i) => b !== raw[i]))) { await sub.unsubscribe(); sub = null }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw })
  await post('/subscribe', { sub: sub.toJSON() })
}

export async function disablePush() {
  const sub = await (await navigator.serviceWorker.getRegistration(`${ROOT}/`))?.pushManager.getSubscription()
  if (!sub) return
  await post('/unsubscribe', { endpoint: sub.endpoint }).catch(() => {})
  await sub.unsubscribe()
}

// Open the session of a notification once this page has it: on web.codinger.app every session
// is "<machine>~<id>"; on a machine's own page, its own sessions have no machine.
function open(machine: string, session: string) {
  const ids = [globalId(machine, session), ...(machine === state.self ? [session] : [])]
  const until = Date.now() + 15_000
  const go = () => {
    const id = ids.find((i) => state.sessions.some((s) => s.id === i))
    if (id) select(id)
    else if (Date.now() < until) setTimeout(go, 200)
  }
  go()
}

if (pushSupported()) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'codinger-push') open(String(e.data.machine ?? ''), String(e.data.session ?? ''))
  })
  // A click on a notification with no Codinger page open opens one at /?push=<machine>~<id>.
  const q = new URLSearchParams(location.search)
  const p = q.get('push')
  if (p?.includes('~')) {
    q.delete('push')
    history.replaceState(history.state, '', location.pathname + (q.size ? `?${q}` : '') + location.hash)
    open(p.slice(0, p.indexOf('~')), p.slice(p.indexOf('~') + 1))
  }
}
