/* VENIA OS — service worker
   Offline app-shell caching. API calls pass straight through; the one thing
   it reads on the way is whether a workspace save was refused (see THE WINDOW
   THAT CANNOT SAVE, below). It never caches, changes or holds back a write. */
const CACHE = 'venia-shell-v597';
// The last build that fixed SAVING. Bump this (to that build's number) only in
// a build that fixes how changes reach the cloud. An open page on an older
// build asks the waiting worker for it, and a page whose saves are failing
// loads a newer save fix by itself instead of waiting for someone to tap
// Update (see "SAVE FIXES LOAD THEMSELVES" in the app). Every other build
// leaves it alone and keeps waiting for the tap, as before.
const BUILD = '597';
const SAVES_FIXED_IN = '593';
// A window older than this cannot be trusted to save: before Build 593 a
// signed-out window kept sending every change and having every one refused,
// for days (one Mac tab did, from Nov 5). Such a window is reloaded by this
// worker, which is the only part of the app an old window still updates.
const RELOAD_BELOW = 593;
const SHELL = ['/', '/venia-control-panel-v1.html', '/manifest.webmanifest', '/brainstorm.html', '/brainstorm.webmanifest'];

self.addEventListener('install', (e) => {
  // NO skipWaiting() HERE, and that is the whole point.
  //
  // It used to activate every new worker the moment it installed. Activating
  // calls clients.claim(), claiming fires controllerchange in every open tab,
  // and the page answered that by arming itself to reload the next time it lost
  // focus. So after any deploy — and the app checks for one every sixty seconds
  // — every open tab reloaded itself as soon as the founder switched tabs or
  // away from the browser. That is the flickering: the screen being thrown away
  // and rebuilt behind their back, at a rate set by how often we ship.
  //
  // The page already has the right mechanism and never got to use it: a ribbon
  // that says a new version is ready, with an Update button. It needs a WAITING
  // worker to offer, and skipWaiting() meant there was never one.
  //
  // So the new worker waits. The ribbon appears. Tapping Update activates it and
  // reloads once, deliberately. And a device still cannot get stuck on an old
  // build: a waiting worker activates by itself as soon as every tab of the app
  // is closed, which is what happens at the end of any day.
  //
  // ONE EXCEPTION, ONCE (Build 597). A worker from before this build cannot
  // reload a window that is stuck, and while that window stays open it keeps
  // the old worker in charge for good, so a waiting worker would never run.
  // So this worker asks the one in charge whether it can already do that job.
  // Any worker from 597 on says yes, and the new one waits for the ribbon as
  // usual. An older one does not, and this one takes over straight away.
  // Taking over reloads nothing: pages since Build 568 reload only when
  // someone taps Update.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(takeOverIfOld));
});
function takeOverIfOld() {
  const act = self.registration && self.registration.active;
  if (!act) return;                       // first install: nothing to take over from
  return new Promise((res) => {
    try {
      const ch = new MessageChannel();
      const t = setTimeout(() => res(false), 2000);
      ch.port1.onmessage = (ev) => { clearTimeout(t); res(!!(ev.data && ev.data.rescue)); };
      act.postMessage({ type: 'BUILD_INFO' }, [ch.port2]);
    } catch (err) { res(false); }
  }).then((knows) => { if (!knows) return self.skipWaiting(); });
}

// ── THE WINDOW THAT CANNOT SAVE (Build 597) ──────────────────────────────
// Every workspace save passes this worker on its way to Supabase. A window
// whose saves come back 401 (signed out) three times in half an hour, and
// that has not said it is Build 593 or newer, is an old window that will
// keep failing until someone reloads it, which nobody does to a tab they
// have forgotten. So the worker reloads it: when it is in the background, or
// in a window nobody is using. Its changes are already on that device; the
// fresh page asks to sign in and keeps them. A page from 593 on stops sending
// after the first 401 and asks to sign in, so it is never reloaded by this.
const RESCUE_KEY = '/__venia-window-rescue';
const RESCUE_WINDOW_MS = 30 * 60 * 1000;
async function rescueRead() {
  try {
    const c = await caches.open(CACHE);
    const r = await c.match(RESCUE_KEY);
    return r ? await r.json() : {};
  } catch (err) { return {}; }
}
async function rescueWrite(st) {
  try {
    const now = Date.now();
    Object.keys(st).forEach((k) => { if (!(now - (st[k].seen || 0) < 2 * 86400000)) delete st[k]; });
    const c = await caches.open(CACHE);
    await c.put(RESCUE_KEY, new Response(JSON.stringify(st), { headers: { 'Content-Type': 'application/json' } }));
  } catch (err) {}
}
async function rescueMaybeReload(id, st) {
  const w = st[id];
  if (!w || (w.build && w.build >= RELOAD_BELOW)) return;
  if (w.reloadedAt && Date.now() - w.reloadedAt < RESCUE_WINDOW_MS) return;
  let client = null;
  try { client = await self.clients.get(id); } catch (err) {}
  if (!client || client.type !== 'window' || typeof client.navigate !== 'function') return;
  // Someone is looking at it and using it: not now. The next refusal asks again.
  if (client.visibilityState === 'visible' && client.focused) return;
  w.reloadedAt = Date.now();
  await rescueWrite(st);
  try { await client.navigate(client.url); } catch (err) {}
}
async function rescueNoteSave(id, status) {
  if (!id) return;
  const st = await rescueRead();
  const now = Date.now();
  const w = st[id] || (st[id] = { hits: [] });
  w.seen = now;
  // One push can send two writes at once; refusals closer than ten seconds
  // count as one, so three means three separate attempts.
  if (status === 401) {
    const hits = (w.hits || []).filter((t) => now - t < RESCUE_WINDOW_MS);
    if (!hits.length || now - hits[hits.length - 1] > 10000) hits.push(now);
    w.hits = hits;
  }
  else if (status >= 200 && status < 300) w.hits = [];
  await rescueWrite(st);
  if ((w.hits || []).length >= 3) await rescueMaybeReload(id, st);
}
const isWorkspaceSave = (req, url) =>
  (req.method === 'POST' || req.method === 'PATCH')
  && /\.supabase\.co$/.test(url.hostname)
  && /^\/rest\/v1\/venia_(module_data|workspace)\b/.test(url.pathname);

// The page tells us to activate the waiting worker once the user taps "Update".
// It also answers "which build are you, and which build last fixed saving?"
// while it is still waiting, so the page can decide whether to load it.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data && e.data.type === 'BUILD_INFO' && e.ports && e.ports[0]) {
    // rescue: this worker reloads windows too old to save (see install).
    e.ports[0].postMessage({ build: BUILD, savesFixedIn: SAVES_FIXED_IN, rescue: true });
  }
  // A page saying which build it is, so a current window is never reloaded.
  if (e.data && e.data.type === 'HELLO' && e.source && e.source.id) {
    const b = parseInt(e.data.build, 10) || 0;
    e.waitUntil(rescueRead().then((st) => {
      const w = st[e.source.id] || (st[e.source.id] = { hits: [] });
      w.build = b; w.seen = Date.now();
      return rescueWrite(st).then(() => (b && b < RELOAD_BELOW ? rescueMaybeReload(e.source.id, st) : null));
    }));
  }
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
  const url = new URL(req.url);
  // Workspace saves go through untouched; only the answer's status is noted.
  if (isWorkspaceSave(req, url)) {
    const id = e.clientId;
    e.respondWith(fetch(req).then((r) => {
      try { e.waitUntil(rescueNoteSave(id, r.status)); } catch (err) {}
      return r;
    }));
    return;
  }
  if (req.method !== 'GET') return;                       // leave other API POST/PATCH alone
  if (url.pathname.startsWith('/.netlify/')) return;      // never touch serverless functions
  // The Claude connector's sign-in and endpoint. A navigation to /oauth/authorize
  // would otherwise be cached AS THE APP SHELL below, and an offline open would
  // then show the sign-in page instead of VENIA OS.
  if (url.pathname === '/mcp' || url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/')) return;
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
