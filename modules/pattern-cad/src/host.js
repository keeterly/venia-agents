// Dr4ft (VENIA's pattern CAD) — host loader (runs in the frame before the CAD itself).
//
// The CAD is built in its own private repository (keeterly/venia-pattern-cad).
// None of its code is in this public repository: this loader fetches it from
// the pattern-cad function, which hands it only to a signed-in Product member,
// at the commit pinned by scripts/sync.mjs. This file is the only VENIA OS
// code that touches the CAD, and besides loading it, it does two things:
//
// 1. KEEPS THE CAD'S STYLES OUT OF VENIA OS'S OWN STORAGE. On its own the CAD
//    saves every style, version and block in localStorage. Inside VENIA OS
//    that is creator.veniacollection.com's localStorage, about 5 MB shared
//    with the whole OS; a big pattern library could fill it and stop VENIA
//    OS saving on this device. So before the CAD starts, its localStorage is
//    swapped for a copy kept in IndexedDB ('venia-pattern-cad', which has
//    room for hundreds of MB). The CAD sees the same synchronous API and
//    behaves exactly as it does on its own. If IndexedDB is unavailable the
//    CAD falls back to plain localStorage, as on its own.
//    Nothing is ever deleted from either store by this file; the only removes
//    are the ones the CAD itself asks for (deleting a style in its library).
//
// 2. LETS THE CAD READ VENIA OS STYLES (never write). The CAD's "Link to a
//    VENIA OS style" asks window.claude.use('mcp') for the VENIA OS
//    connector's list_styles and get_style. Here those two calls are answered
//    by the shell over postMessage (same origin only), from the line it
//    already holds, with no costs or prices. Any other tool is refused.
(function () {
  'use strict';
  var PFX = 'venia-pattern-cad';
  var DB = 'venia-pattern-cad', OS = 'kv';
  var me = document.currentScript;
  var V = (me && me.getAttribute('data-v')) || '';
  var FN = '/.netlify/functions/pattern-cad';
  var REAL_LS = null; try { REAL_LS = window.localStorage; } catch (e) {}
  var embedded = false;
  try { embedded = window.parent !== window && window.parent.location.origin === location.origin; } catch (e) { embedded = false; }

  // The CAD's code is private: it comes from the pattern-cad function, which
  // hands it only to a signed-in Product member. The session is the shell's
  // (same origin), or, opened on its own, the one VENIA OS keeps on this device.
  function accessToken() {
    return new Promise(function (resolve) {
      var fromStore = function () {
        try {
          for (var i = 0; REAL_LS && i < REAL_LS.length; i++) {
            var k = REAL_LS.key(i);
            if (k && /^sb-.+-auth-token$/.test(k)) {
              var v = JSON.parse(REAL_LS.getItem(k) || 'null');
              var t = v && (v.access_token || (v.currentSession && v.currentSession.access_token));
              if (t) return t;
            }
          }
        } catch (e) {}
        return null;
      };
      try {
        var c = embedded && window.parent.__sbClient;
        if (c && c.auth) {
          c.auth.getSession().then(function (r) {
            var t = r && r.data && r.data.session && r.data.session.access_token;
            resolve(t || fromStore());
          }, function () { resolve(fromStore()); });
          return;
        }
      } catch (e) {}
      resolve(fromStore());
    });
  }
  function gate(text, linkText, href) {
    var root = document.getElementById('root');
    if (!root) return;
    root.innerHTML = '';
    var box = document.createElement('div'); box.id = 'vpc-gate';
    var p = document.createElement('p'); p.textContent = text; box.appendChild(p);
    if (linkText) {
      var a = document.createElement('a'); a.textContent = linkText; a.href = href || '#';
      if (!href) a.onclick = function (e) { e.preventDefault(); location.reload(); };
      else if (embedded) a.target = '_top';
      box.appendChild(a);
    }
    root.appendChild(box);
    post('pattern-cad:gate', { text: text });
  }
  function part(name, token) {
    return fetch(FN + '?part=' + name + '&v=' + encodeURIComponent(V), { headers: { Authorization: 'Bearer ' + token }, credentials: 'same-origin' })
      .then(function (r) {
        if (r.ok) return r.text();
        var e = new Error('HTTP ' + r.status); e.status = r.status; throw e;
      });
  }

  function start() {
    accessToken().then(function (token) {
      if (!token) { gate('Sign in to VENIA OS to open Dr4ft.', 'Open VENIA OS', '/'); return; }
      return Promise.all([part('app.css', token), part('app.js', token)]).then(function (got) {
        var st = document.createElement('style'); st.textContent = got[0]; document.head.appendChild(st);
        var url = URL.createObjectURL(new Blob([got[1]], { type: 'text/javascript' }));
        var s = document.createElement('script');
        s.src = url;
        s.onload = function () {
          URL.revokeObjectURL(url);
          libraryHost();
          // "Save a copy that runs offline" in the CAD saves the page as loaded.
          // Here the page is a loader, so hand it the CAD's own one-file page.
          part('page', token).then(function (t) { window.__vpcSource = t; }, function () {});
          post('pattern-cad:ready', { embedded: embedded });
        };
        s.onerror = function () { gate('Dr4ft didn\'t start. Try again.', 'Reload'); };
        document.body.appendChild(s);
      });
    }).catch(function (e) {
      var st = e && e.status;
      if (st === 401) gate('Sign in to VENIA OS again to open Dr4ft.', 'Open VENIA OS', '/');
      else if (st === 403) gate('Dr4ft isn\'t open to you here. Ask for access to Dr4ft or Product, and check it is switched on in Settings › Modules.');
      else if (st === 503) gate('Dr4ft isn\'t connected yet: its GitHub key still needs adding in Netlify.');
      else gate('Dr4ft didn\'t load. Check the connection and try again.', 'Reload');
    });
  }

  // 4. THE PATTERN LIBRARY (Build 683). VENIA OS keeps Dr4ft's library and
  //    where each person left off (venia_patterns). Once Dr4ft is running, and
  //    only if the shell's library answered, it is told VENIA OS is its library
  //    host: Dr4ft then hides its own library, and reports every open, save and
  //    view, which the shell writes to the library. The shell reaches Dr4ft's
  //    commands (open, newPattern, save, state, listLocal) through
  //    window.dr4ft.command directly; the page is the same origin. Send to a
  //    tech pack stays off (no sendPattern here). The contract is
  //    keeterly/venia-pattern-cad docs/venia-os-contract.md, version 2.
  //    Registered after Dr4ft starts (not via __DR4FT_HOST__) so Dr4ft's own
  //    listeners are in place to say what is open.
  function libraryHost() {
    if (!embedded) return;
    var ask = null;
    try { ask = window.parent.veniaDr4ftLibraryReady; } catch (e) { ask = null; }
    if (typeof ask !== 'function') return;
    Promise.resolve(ask()).then(function (on) {
      if (!on || !window.dr4ft || typeof window.dr4ft.registerHost !== 'function') return;
      window.dr4ft.registerHost({
        name: 'VENIA OS',
        library: true,
        onEvent: function (event, data) { post('pattern-cad:dr4ft-event', { event: event, data: data }); },
        listStyles: function (query) {
          return ask2('list_styles', { text: String(query || ''), limit: 50 }).then(function (r) {
            var list = (r && r.payload && r.payload.styles) || [];
            return list.map(function (s) { return { id: s.id, code: s.styleId || '', name: s.name || '', season: s.season || '' }; });
          });
        },
      });
    }, function () {});
  }
  var ask2 = function () { return Promise.resolve({ payload: { styles: [] } }); };

  function post(type, payload) {
    if (!embedded) return;
    try { window.parent.postMessage({ source: 'venia-module', type: type, payload: payload || {} }, location.origin); } catch (e) {}
  }

  // ── 2. the VENIA OS style link ──
  if (embedded) {
    var seq = 0, waiting = {};
    window.addEventListener('message', function (e) {
      if (e.origin !== location.origin || e.source !== window.parent || !e.data || e.data.source !== 'venia-os') return;
      if (e.data.type !== 'pattern-cad:answer') return;
      var w = waiting[e.data.id]; if (!w) return;
      delete waiting[e.data.id];
      if (e.data.error) { var err = new Error(e.data.error.message || 'VENIA OS did not answer'); err.code = e.data.error.code; w.reject(err); }
      else w.resolve({ payload: e.data.payload });
    });
    var ask = function (tool, args) {
      return new Promise(function (resolve, reject) {
        var id = 'q' + (++seq);
        waiting[id] = { resolve: resolve, reject: reject };
        setTimeout(function () { if (waiting[id]) { delete waiting[id]; var er = new Error('VENIA OS didn\'t answer. Try again shortly.'); er.code = 'timeout'; reject(er); } }, 8000);
        post('pattern-cad:ask', { id: id, tool: tool, args: args || {} });
      });
    };
    ask2 = ask;
    var mcp = {
      callTool: function (server, tool, args) {
        if (server !== 'VENIA OS' || (tool !== 'list_styles' && tool !== 'get_style')) {
          var er = new Error('Only reading styles is open to the pattern CAD.'); er.code = 'not_granted';
          return Promise.reject(er);
        }
        return ask(tool, args);
      },
    };
    // 3. SENDING A PATTERN TO VENIA OS (Build 658). The CAD calls
    //    window.veniaHandoff.targets('pattern') to see where a pattern can go
    //    (only modules that are on, e.g. [{module:'product', into:'techpack',
    //    label:'Tech pack'}]) and window.veniaHandoff.send({ pattern, into })
    //    to send one, where into is { styleId, part: 'techpack' } and pattern
    //    is { id, name, version, baseSize, sizes, gradeRule, pieces:[{ name,
    //    component, cut, material, grain, fused, notes }], picture (https),
    //    files:[names] }. The shell checks and records it; the tech pack shows
    //    it as waiting until someone brings it in. Nothing in VENIA OS changes
    //    from here without that tap.
    var hseq = 0, hwait = {};
    window.addEventListener('message', function (e) {
      if (e.origin !== location.origin || e.source !== window.parent || !e.data || e.data.source !== 'venia-os') return;
      if (e.data.type !== 'pattern-cad:targets' && e.data.type !== 'pattern-cad:handoff') return;
      var p = e.data.payload || {};
      var w = hwait[p.id]; if (!w) return;
      delete hwait[p.id];
      w(p);
    });
    var hask = function (type, payload, wait) {
      return new Promise(function (resolve) {
        var id = 'h' + (++hseq);
        hwait[id] = resolve;
        setTimeout(function () { if (hwait[id]) { delete hwait[id]; resolve({ ok: false, timeout: true, message: 'VENIA OS didn\'t answer. Try again shortly.' }); } }, wait || 15000);
        payload.id = id;
        post(type, payload);
      });
    };
    window.veniaHandoff = {
      targets: function (kind) { return hask('pattern-cad:targets', { kind: kind || 'pattern' }, 8000).then(function (r) { return (r && r.targets) || []; }); },
      send: function (o) {
        o = o || {};
        return hask('pattern-cad:handoff', { pattern: o.pattern || {}, into: o.into || {} }, 20000);
      },
    };
    // Only the style link is offered. 'sample' (Claude drafting a design plan)
    // is not answered here yet, so the CAD uses its on-device reader instead.
    var existing = window.claude;
    window.claude = {
      use: function (name) {
        if (name === 'mcp') return Promise.resolve(mcp);
        if (name === 'venia-handoff') return Promise.resolve(window.veniaHandoff);
        if (existing && typeof existing.use === 'function') return existing.use(name);
        return Promise.resolve(null);
      },
    };
  }

  if (!embedded) {
    var away = function () { return Promise.resolve({ ok: false, message: 'Open Dr4ft inside VENIA OS to send a pattern to a tech pack.' }); };
    window.veniaHandoff = { targets: function () { return Promise.resolve([]); }, send: away };
  }

  // ── 1. styles kept in IndexedDB ──
  if (!('indexedDB' in window)) { start(); return; }
  var opened;
  try { opened = indexedDB.open(DB, 1); } catch (e) { start(); return; }
  opened.onupgradeneeded = function () { opened.result.createObjectStore(OS); };
  opened.onerror = function () { start(); };
  opened.onblocked = function () { start(); };
  opened.onsuccess = function () {
    var db = opened.result;
    var map = new Map();
    var tx;
    try { tx = db.transaction(OS, 'readonly'); } catch (e) { start(); return; }
    var st = tx.objectStore(OS);
    var keysReq = st.getAllKeys(), valsReq = st.getAll();
    tx.oncomplete = function () {
      var keys = keysReq.result || [], vals = valsReq.result || [];
      for (var i = 0; i < keys.length; i++) map.set(String(keys[i]), String(vals[i]));
      // First open here: bring across anything the CAD saved in this site's
      // localStorage before it ran as a module. Copied, never moved.
      var real = null; try { real = window.localStorage; } catch (e) {}
      var carry = [];
      if (!map.size && real) {
        try {
          for (var j = 0; j < real.length; j++) {
            var k = real.key(j);
            if (k && (k.indexOf(PFX) === 0 || k === 'vpc-digitizer')) carry.push([k, real.getItem(k)]);
          }
        } catch (e) {}
      }
      var failed = false;
      var write = function (k, v) {
        try {
          var w = db.transaction(OS, 'readwrite');
          if (v === null) w.objectStore(OS).delete(k); else w.objectStore(OS).put(v, k);
          w.onerror = w.onabort = function () { if (!failed) { failed = true; post('pattern-cad:storage-error', {}); } };
        } catch (e) { failed = true; }
      };
      carry.forEach(function (kv) { if (kv[1] != null) { map.set(kv[0], kv[1]); write(kv[0], kv[1]); } });
      var shim = {
        getItem: function (k) { k = String(k); return map.has(k) ? map.get(k) : null; },
        setItem: function (k, v) { k = String(k); v = String(v); map.set(k, v); write(k, v); },
        removeItem: function (k) { k = String(k); if (map.has(k)) { map.delete(k); write(k, null); } },
        key: function (i) { var a = Array.from(map.keys()); return i >= 0 && i < a.length ? a[i] : null; },
        // Only ever reached by the CAD itself; it clears its own store, never VENIA OS's.
        clear: function () { Array.from(map.keys()).forEach(function (k) { shim.removeItem(k); }); },
      };
      Object.defineProperty(shim, 'length', { get: function () { return map.size; } });
      var ok = false;
      try {
        Object.defineProperty(window, 'localStorage', { configurable: true, enumerable: true, get: function () { return shim; } });
        ok = window.localStorage === shim;
      } catch (e) { ok = false; }
      window.__vpcHostStorage = ok ? 'indexeddb' : 'localstorage';
      start();
    };
    tx.onerror = function () { start(); };
  };
})();
