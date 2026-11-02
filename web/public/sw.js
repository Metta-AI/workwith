// Codinger's service worker: makes the page installable, keeps it useful offline, and shows
// the push notifications that web.codinger.app sends (remote/src/push.ts); a click on one
// opens its session (web/src/push.ts).
// Offline, the page loads from cache and shows the sessions and conversations as they
// were last seen (store.ts keeps the session list); replies you write wait in the
// browser until the server is back. Nothing is sent from here.
//
//   /assets/*                      built files, named by hash: cache first
//   navigations, /agent/*, manifest  network first, the cached copy offline
//   GET /api/sessions/<id>/events  network first, the cached copy offline
//   everything else                straight to the network

const CACHE = 'codinger-v3'
// Where the page is: the root, or the path a proxy serves Codinger under (CODINGER_BASE), e.g.
// /desk/ada/. The paths below are under it.
const ROOT = new URL(self.registration.scope).pathname
const under = (p) => p.startsWith(ROOT) ? '/' + p.slice(ROOT.length) : null

// The page and everything it loads, so the first offline visit works even when the
// page that installed this worker loaded its files before the worker could see them.
async function precache() {
  const cache = await caches.open(CACHE)
  const res = await fetch(ROOT)
  if (!res.ok) return
  const html = await res.clone().text()
  await cache.put(ROOT, res)
  const urls = [...html.matchAll(/(?:src|href)="([^"]*\/(?:assets|agent)\/[^"]+|[^"]*\/manifest\.webmanifest)"/g)].map((m) => m[1]).filter((u) => u.startsWith(ROOT))
  await Promise.all(urls.map((u) => cache.add(u).catch(() => {})))
}

self.addEventListener('install', (e) => {
  e.waitUntil(precache().catch(() => {}).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()))
})

async function networkFirst(req, key = req) {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(req)
    if (res.ok) await cache.put(key, res.clone())
    return res
  } catch (err) {
    const hit = await cache.match(key)
    if (hit) return hit
    throw err
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) await cache.put(req, res.clone())
  return res
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  const p = under(url.pathname)
  if (req.method !== 'GET' || url.origin !== location.origin || p == null) return
  if (req.mode === 'navigate') return e.respondWith(networkFirst(req, ROOT))
  if (p.startsWith('/assets/')) return e.respondWith(cacheFirst(req))
  if (p.startsWith('/agent/') || p === '/manifest.webmanifest') return e.respondWith(networkFirst(req))
  if (/^\/api\/sessions\/[^/]+\/events$/.test(p)) return e.respondWith(networkFirst(req))
})

self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { /* not JSON */ }
  // One notification for each session: a new one takes the place of the old.
  e.waitUntil(self.registration.showNotification(d.title || 'Codinger', {
    body: d.body || '',
    tag: `${d.machine}~${d.session}`,
    renotify: true,
    data: { machine: d.machine || '', session: d.session || '' },
  }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const { machine, session } = e.notification.data || {}
  e.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const page = pages.find((c) => new URL(c.url).origin === self.location.origin)
    if (page) {
      page.postMessage({ type: 'codinger-push', machine, session })
      return page.focus()
    }
    return self.clients.openWindow(`${ROOT}?push=${encodeURIComponent(`${machine}~${session}`)}`)
  })())
})
