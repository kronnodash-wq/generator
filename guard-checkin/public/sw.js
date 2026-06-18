'use strict'

const CACHE = 'sg-v1'
const PRECACHE = [
  '/',
  '/index.html',
  '/guard.html',
  '/supervisor.html',
  '/logo.png',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'
]

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE).catch(() => {}))
  )
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)

  // API calls: network first, no cache
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'Sin conexión' }), { headers: { 'Content-Type': 'application/json' } })))
    return
  }

  // Everything else: cache first, fallback to network
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone()
        caches.open(CACHE).then(c => c.put(e.request, clone))
      }
      return res
    }))
  )
})
