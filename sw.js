/* VENIA OS — service worker
   Offline app-shell caching. Never touches API writes or cross-origin calls
   (Anthropic / Supabase / Shopify / fonts pass straight through). */
const CACHE = 'venia-shell-v85';
const SHELL = ['/', '/venia-control-panel-v1.html', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  // NOTE: no skipWaiting() here. We let the new worker WAIT so the page can
  // prompt the user ("New version available — Update") before it takes over,
  // rather than swapping code out from under a live session. The page posts
  // SKIP_WAITING when the user accepts. First install has no existing worker,
  // so the browser activates it immediately regardless.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

// The page tells us to activate the waiting worker once the user taps "Update".
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
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
  if (url.pathname.startsWith('/.netlify/')) return;      // never touch serverless functions
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
