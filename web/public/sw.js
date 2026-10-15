// Codiner's service worker: makes the page installable and keeps it useful offline.
// Offline, the page loads from cache and shows the sessions and conversations as they
// were last seen (store.ts keeps the session list); replies you write wait in the
// browser until the server is back. Nothing is sent from here.
//
//   /assets/*                      built files, named by hash: cache first
//   navigations, /agent/*, manifest  network first, the cached copy offline
//   GET /api/sessions/<id>/events  network first, the cached copy offline
//   everything else                straight to the network

const CACHE = 'codiner-v2'

// The page and everything it loads, so the first offline visit works even when the
// page that installed this worker loaded its files before the worker could see them.
async function precache() {
  const cache = await caches.open(CACHE)
  const res = await fetch('/')
  if (!res.ok) return
  const html = await res.clone().text()
  await cache.put('/', res)
  const urls = [...html.matchAll(/(?:src|href)="(\/(?:assets|agent)\/[^"]+|\/manifest\.webmanifest)"/g)].map((m) => m[1])
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
  if (req.method !== 'GET' || url.origin !== location.origin) return
  if (req.mode === 'navigate') return e.respondWith(networkFirst(req, '/'))
  if (url.pathname.startsWith('/assets/')) return e.respondWith(cacheFirst(req))
  if (url.pathname.startsWith('/agent/') || url.pathname === '/manifest.webmanifest') return e.respondWith(networkFirst(req))
  if (/^\/api\/sessions\/[^/]+\/events$/.test(url.pathname)) return e.respondWith(networkFirst(req))
})
