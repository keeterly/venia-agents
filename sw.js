/* VENIA OS — service worker
   Offline app-shell caching. Never touches API writes or cross-origin calls
   (Anthropic / Supabase / Shopify / fonts pass straight through). */
const CACHE = 'venia-shell-v266';
const SHELL = ['/', '/venia-control-panel-v1.html', '/manifest.webmanifest', '/brainstorm.html', '/brainstorm.webmanifest'];

self.addEventListener('install', (e) => {
  // Auto-update: activate the new worker as soon as it's installed instead of
  // waiting for the user to tap an "Update" ribbon. On iOS the app resumes the
  // old page for days and that ribbon often never showed, leaving devices stuck
  // on an old build. The page reloads once on controllerchange (see the HTML
  // registration), so a fresh deploy lands on the next open with no tapping.
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

// The page tells us to activate the waiting worker once the user taps "Update".
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Web Push from the agent worker — shows even when the app is closed.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'VENIA', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.tag || 'venia-push',
  }));
});

// Tapping an "Eni finished" notification focuses the app (or opens it fresh).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('/');
    })
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
  if (url.pathname.startsWith('/.netlify/')) return;      // never touch serverless functions
  if (url.origin !== self.location.origin) return;        // don't cache APIs or fonts

  // App shell: network-first so updates land when online, cache when offline.
  if (req.mode === 'navigate') {
    const isBrainstorm = url.pathname === '/brainstorm.html' || url.pathname === '/brainstorm';
    // Fetch with redirect:'follow' (fresh Request) so a Netlify .html pretty-URL
    // 301 can't surface as an unusable opaqueredirect for the navigation.
    e.respondWith(
      fetch(new Request(req.url, { redirect: 'follow', credentials: 'same-origin' }))
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(isBrainstorm ? '/brainstorm.html' : '/venia-control-panel-v1.html', copy));
          return r;
        })
        // Offline: serve the matching shell — the Brainstorm entry keeps its own
        // identity, everything else falls back to the OS shell.
        .catch(() => caches.match(isBrainstorm ? '/brainstorm.html' : '/venia-control-panel-v1.html')
          .then((r) => r || caches.match('/venia-control-panel-v1.html')).then((r) => r || caches.match('/')))
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
