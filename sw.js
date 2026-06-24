/* VENIA Control Center — service worker
   Offline app-shell caching. Never touches API writes or cross-origin calls
   (Anthropic / Supabase / Shopify / fonts pass straight through). */
const CACHE = 'venia-shell-v1';
const SHELL = ['/', '/venia-control-panel-v1.html', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // leave API POST/PATCH alone
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // don't cache APIs or fonts

  // App shell: network-first so updates land when online, cache when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put('/venia-control-panel-v1.html', copy));
          return r;
        })
        .catch(() => caches.match('/venia-control-panel-v1.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // Static assets (icons, frames, etc.): cache-first with runtime fill.
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return r;
    }).catch(() => cached))
  );
});
