// Boards data layer.
//
// Two backends behind one interface:
//   cloud — the module's own Supabase tables (venia_boards, venia_board_files)
//           and its private bucket (venia-boards). Used when the person is
//           signed in to VENIA OS and the module's migration is applied.
//   local — IndexedDB on this device. Used signed out, offline at boot, or
//           before the migration exists, so the board never dead-ends.
//
// The module reaches the rest of VENIA OS through exactly one door: the
// Supabase session that VENIA OS keeps in this origin's storage. It reads no
// other module's tables and calls no other module's code.
import { createClient } from '@supabase/supabase-js';
import { get, set, del, createStore } from 'idb-keyval';
import { countItems } from './elements.js';

const idb = createStore('venia-boards', 'kv');
const WS = 'main';
const BUCKET = 'venia-boards';
// Same public anon key VENIA OS pre-configures; the session decides access.
const DEFAULT_URL = 'https://unxfaeqjskzzmhyrekqx.supabase.co';
const DEFAULT_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueGZhZXFqc2t6em1oeXJla3F4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDgxMTQsImV4cCI6MjA5MzQyNDExNH0.tqKiJJZE9iz29g9hIscLeMir4PhBMeTU8fbI04eC6xY';
const FOUNDERS = ['keeter@veniacollection.com', 'christine@veniacollection.com'];

export const uid = (p = 'b') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const now = () => new Date().toISOString();

let sb = null;

const wait = (ms) => new Promise(r => setTimeout(r, ms));
// Is a sign-in kept on this device at all (renewed or not)?
function storedSignIn() {
  try { return Object.keys(localStorage).some(k => /^sb-.*-auth-token$/.test(k) && localStorage.getItem(k)); } catch (e) { return false; }
}
// VENIA OS around this frame lends its sign-in when Boards can't find one.
function askHostForSession() {
  if (!inHostFrame()) return Promise.resolve(null);
  return new Promise(resolve => {
    const done = (v) => { window.removeEventListener('message', on); clearTimeout(t); resolve(v); };
    const on = (e) => {
      if (e.origin !== location.origin || !e.data || e.data.source !== 'venia-host' || e.data.type !== 'boards:session') return;
      done(e.data.payload || null);
    };
    const t = setTimeout(() => done(null), 4000);
    window.addEventListener('message', on);
    try { window.parent.postMessage({ source: 'venia-module', module: 'brainstorm.boards', type: 'boards:session' }, location.origin); } catch (e) { done(null); }
  });
}
function inHostFrame() { try { return window.self !== window.top; } catch (e) { return true; } }
async function findUser() {
  // A sign-in that's mid-renewal can come back empty or with an error for a
  // moment; give it a few tries before believing it.
  const look = async () => {
    let res = null;
    try { res = await sb.auth.getSession(); } catch (e) { res = { error: e }; }
    return { user: res && res.data && res.data.session && res.data.session.user, error: res && res.error };
  };
  let r = await look();
  if (r.user) return r.user;
  // VENIA OS around us is the one that renews the sign-in; borrow its.
  const lent = await askHostForSession();
  if (lent && lent.access_token && lent.refresh_token) {
    try {
      const s = await sb.auth.setSession({ access_token: lent.access_token, refresh_token: lent.refresh_token });
      const user = s && s.data && s.data.session && s.data.session.user;
      if (user) return user;
    } catch (e) {}
  }
  for (let i = 1; i <= 3 && (r.error || storedSignIn()); i++) {
    await wait(700 * i);
    r = await look();
    if (r.user) return r.user;
  }
  return null;
}

export const store = {
  mode: 'local',          // 'cloud' | 'local'
  reason: '',             // why local: 'signed-out' | 'not-set-up' | 'offline'
  email: '',
  role: 'owner',          // owner | editor | viewer   (Boards as a whole)
  // What I can do on the board that's open: 'owner' | 'edit' | 'view', or
  // null on the boards list (Build 660). The database decides; this only
  // keeps the screen in step with it.
  boardRole: null,
  get canEdit() { return this.role !== 'viewer' && this.boardRole !== 'view'; },

  // Which account Boards saves to. VENIA OS and Boards share one sign-in on
  // this site, but Boards used to look only once, as it opened: if that look
  // came while the phone was waking up (the sign-in still being renewed, or
  // the network not back yet), Boards decided "signed out" and kept saying so
  // even though VENIA OS was signed in (Build 652). Now it waits for the
  // renewal, asks VENIA OS for its sign-in when it can't find one, and looks
  // again whenever the sign-in changes or the app comes back to the front.
  async init() {
    try {
      if (!sb) {
        const url = localStorage.getItem('venia-sb-url') || DEFAULT_URL;
        const key = localStorage.getItem('venia-sb-key') || DEFAULT_KEY;
        sb = createClient(url, key);
      }
      const user = await findUser();
      if (!user) { this.mode = 'local'; this.reason = navigator.onLine === false ? 'offline' : 'signed-out'; return this; }
      this.email = String(user.email || '').toLowerCase();
      const probe = await sb.from('venia_boards').select('id').limit(1);
      if (probe.error) {
        const c = String(probe.error.code || '');
        this.mode = 'local';
        this.reason = (c === '42P01' || c === 'PGRST205' || /does not exist|schema cache/i.test(probe.error.message || '')) ? 'not-set-up' : 'offline';
        return this;
      }
      this.mode = 'cloud'; this.reason = '';
      if (FOUNDERS.includes(this.email)) this.role = 'owner';
      else {
        const r = await sb.from('venia_members').select('role').eq('email', this.email).eq('module', 'brainstorm').maybeSingle();
        this.role = (r.data && r.data.role) || 'viewer';
      }
    } catch (e) {
      this.mode = 'local'; this.reason = 'offline';
    }
    return this;
  },

  // Call back when Boards should look at the sign-in again: VENIA OS signed
  // in or renewed it, or the app came back to the front.
  onSignInChange(cb) {
    const subs = [];
    try {
      if (sb) { const r = sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_IN' || ev === 'TOKEN_REFRESHED' || ev === 'SIGNED_OUT') setTimeout(() => cb(ev), 0); });
        subs.push(() => r.data.subscription.unsubscribe()); }
    } catch (e) {}
    const vis = () => { if (!document.hidden) cb('visible'); };
    const on = (e) => { if (e.origin === location.origin && e.data && e.data.source === 'venia-host' && e.data.type === 'boards:signed-in') cb('host'); };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('online', vis);
    window.addEventListener('message', on);
    subs.push(() => { document.removeEventListener('visibilitychange', vis); window.removeEventListener('online', vis); window.removeEventListener('message', on); });
    return () => subs.forEach(f => f());
  },

  // ── boards ───────────────────────────────────────────────────────────────
  async listBoards({ trash = false } = {}) {
    if (this.mode === 'cloud') {
      let q = sb.from('venia_boards')
        .select('id,parent_id,title,search_text,item_count,cover_file,updated_at,updated_by,trashed_at,sort,owner,everyone,created_by')
        .eq('workspace_id', WS);
      q = trash ? q.not('trashed_at', 'is', null) : q.is('trashed_at', null);
      const { data, error } = await q.order('updated_at', { ascending: false });
      if (error) throw error;
      // how many named people each board is shared with (Build 660)
      const sh = await sb.from('venia_board_shares').select('board_id');
      const n = {}; (sh.data || []).forEach(r => { n[r.board_id] = (n[r.board_id] || 0) + 1; });
      return (data || []).map(b => ({ ...b, shared_with: n[b.id] || 0 }));
    }
    const all = (await get('boards', idb)) || [];
    return all.filter(b => trash ? !!b.trashed_at : !b.trashed_at)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  },

  async createBoard({ id = null, title = 'Untitled board', parent_id = null, scene = null, everyone = null } = {}) {
    const row = {
      id: id || uid('b'), workspace_id: WS, parent_id, title,
      scene: scene || { elements: [], appState: {} },
      search_text: title, item_count: (scene && scene.elements ? countItems(scene.elements) : 0),
      created_by: this.email || null, created_at: now(), updated_by: this.email || null, updated_at: now(), rev: 0,
    };
    if (this.mode === 'cloud') {
      // Sharing (Build 660): a new board starts private to whoever makes it.
      // One made inside another board starts shared the way that board is,
      // so the people working on the outer board see what's made in it.
      let shares = [];
      let who = everyone;
      if (!who && parent_id) {
        const { data: p } = await sb.from('venia_boards').select('everyone').eq('id', parent_id).maybeSingle();
        if (p && p.everyone) {
          who = p.everyone;
          const { data: sh } = await sb.from('venia_board_shares').select('email,role').eq('board_id', parent_id);
          shares = (sh || []).filter(x => x.email !== this.email);
        }
      }
      const { error } = await sb.from('venia_boards').insert({ ...row, owner: this.email || '', everyone: who || 'none' });
      if (error) throw error;
      if (shares.length) await sb.from('venia_board_shares').insert(shares.map(x => ({ board_id: row.id, email: x.email, role: x.role })));
      return { ...row, owner: this.email || '', everyone: who || 'none' };
    }
    const all = (await get('boards', idb)) || [];
    const { scene: sc, ...meta } = row;
    all.push(meta);
    await set('boards', all, idb);
    await set('scene:' + row.id, sc, idb);
    return row;
  },

  // ── sharing (Build 660) ──────────────────────────────────────────────────
  // What I can do on this board. Asked as a board opens; the answer also
  // decides whether the board opens in view-only mode.
  async roleOn(id) {
    if (this.mode !== 'cloud') { this.boardRole = 'owner'; return 'owner'; }
    const { data, error } = await sb.rpc('venia_board_role', { bid: id });
    this.boardRole = error ? null : (data || null);
    return this.boardRole;
  },
  // Who sees a board: everyone's setting, the named people, and (for the
  // owner) its view links.
  async sharing(id) {
    if (this.mode !== 'cloud') return null;
    const [b, sh, ln] = await Promise.all([
      sb.from('venia_boards').select('owner,created_by,everyone').eq('id', id).maybeSingle(),
      sb.from('venia_board_shares').select('email,role,created_at').eq('board_id', id).order('created_at'),
      sb.from('venia_board_links').select('token,created_at,expires_at,revoked_at').eq('board_id', id).is('revoked_at', null).order('created_at', { ascending: false }),
    ]);
    if (b.error) throw b.error;
    const row = b.data || {};
    return {
      owner: String(row.owner || row.created_by || '').toLowerCase(),
      everyone: row.everyone || 'edit',
      people: sh.data || [],
      links: (ln.data || []).filter(l => !l.expires_at || Date.parse(l.expires_at) > Date.now()),
    };
  },
  async setEveryone(id, everyone) {
    const { error } = await sb.from('venia_boards').update({ everyone }).eq('id', id);
    if (error) throw error;
  },
  async sharePerson(id, email, role) {
    email = String(email || '').trim().toLowerCase();
    const { error } = await sb.from('venia_board_shares').upsert({ board_id: id, email, role }, { onConflict: 'board_id,email' });
    if (error) throw error;
  },
  async unsharePerson(id, email) {
    const { error } = await sb.from('venia_board_shares').delete().eq('board_id', id).eq('email', email);
    if (error) throw error;
  },
  async makeViewLink(id, days) {
    const expires_at = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
    const { data, error } = await sb.from('venia_board_links').insert({ board_id: id, expires_at }).select('token,created_at,expires_at').single();
    if (error) throw error;
    return data;
  },
  async turnOffViewLink(token) {
    const { error } = await sb.from('venia_board_links').update({ revoked_at: now() }).eq('token', token);
    if (error) throw error;
  },
  viewLinkUrl(token) {
    return location.origin + '/boards#/v/' + token;
  },
  // A view link opened by anyone, signed in or not: read through the
  // board-view function, never from the tables.
  async openViewLink(token) {
    const url = (localStorage.getItem('venia-sb-url') || DEFAULT_URL) + '/functions/v1/board-view';
    const key = localStorage.getItem('venia-sb-key') || DEFAULT_KEY;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + key }, body: JSON.stringify({ token }) });
    if (r.status === 404) return { gone: true };
    if (!r.ok) throw new Error('unavailable');
    return r.json();
  },

  async patchBoard(id, patch) {
    if (this.mode === 'cloud') {
      const { error } = await sb.from('venia_boards').update(patch).eq('id', id);
      if (error) throw error;
      return;
    }
    const all = (await get('boards', idb)) || [];
    const b = all.find(x => x.id === id); if (b) Object.assign(b, patch);
    await set('boards', all, idb);
  },
  rename(id, title) { return this.patchBoard(id, { title, updated_at: now(), updated_by: this.email || null }); },
  trash(id)   { return this.patchBoard(id, { trashed_at: now() }); },
  restore(id) { return this.patchBoard(id, { trashed_at: null }); },
  move(id, parent_id) { return this.patchBoard(id, { parent_id }); },

  async purge(id) {
    if (this.mode === 'cloud') {
      // The database keeps no delete rights for browsers: one function,
      // boards-purge, removes a trashed board, its images and its thumbnail,
      // and records what went (venia_boards_purged).
      const { data, error } = await sb.functions.invoke('boards-purge', { body: { boardId: id } });
      if (error) {
        let msg = '';
        try { msg = (await error.context.json()).error || ''; } catch (e) { /* no body */ }
        throw new Error(msg ? msg.charAt(0).toUpperCase() + msg.slice(1) + '.' : 'Couldn\'t delete the board just now. It stays in Trash.');
      }
      if (!data || !data.ok) throw new Error('Couldn\'t delete the board just now. It stays in Trash.');
      return;
    }
    const all = ((await get('boards', idb)) || []).filter(b => b.id !== id);
    await set('boards', all, idb);
    await del('scene:' + id, idb); await del('thumb:' + id, idb);
  },

  // Was this board deleted for good? (Keeps the old Brainstorm board from
  // being imported a second time after someone purged it.)
  async wasPurged(id) {
    if (this.mode !== 'cloud') return false;
    const { data, error } = await sb.from('venia_boards_purged').select('id').eq('id', id).maybeSingle();
    return !error && !!data;
  },

  async loadBoard(id) {
    if (this.mode === 'cloud') {
      const { data, error } = await sb.from('venia_boards').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data;
    }
    const all = (await get('boards', idb)) || [];
    const meta = all.find(b => b.id === id);
    if (!meta) return null;
    return { ...meta, scene: (await get('scene:' + id, idb)) || { elements: [], appState: {} } };
  },

  async remoteRev(id) {
    if (this.mode !== 'cloud') return null;
    const { data } = await sb.from('venia_boards').select('rev,updated_by').eq('id', id).maybeSingle();
    return data || null;
  },

  // Save the canvas. In the cloud the write only lands if nobody else saved
  // since we last read (rev). Otherwise we hand back their version to merge.
  async saveScene(id, scene, rev, extra = {}) {
    const patch = { scene, updated_at: now(), updated_by: this.email || null, ...extra };
    if (this.mode === 'cloud') {
      const { data, error } = await sb.from('venia_boards')
        .update({ ...patch, rev: rev + 1 }).eq('id', id).eq('rev', rev).select('rev');
      if (error) throw error;
      if (!data || !data.length) {
        const remote = await this.loadBoard(id);
        return { conflict: true, remote };
      }
      return { rev: data[0].rev };
    }
    await set('scene:' + id, scene, idb);
    const { scene: _s, ...meta } = patch;
    await this.patchBoard(id, meta);
    return { rev: rev + 1 };
  },

  // ── images ───────────────────────────────────────────────────────────────
  async saveFile(boardId, file) {
    // Always cache the bytes on this device: re-opening a board is instant and
    // works offline.
    await set('file:' + file.id, { dataURL: file.dataURL, mimeType: file.mimeType, created: file.created || Date.now() }, idb);
    if (this.mode !== 'cloud') {
      const ids = (await get('files:' + boardId, idb)) || [];
      if (!ids.includes(file.id)) { ids.push(file.id); await set('files:' + boardId, ids, idb); }
      return true;
    }
    const blob = dataURLToBlob(file.dataURL);
    const ext = (file.mimeType || 'image/png').split('/')[1].replace('svg+xml', 'svg').replace('jpeg', 'jpg');
    const path = `${WS}/${boardId}/${file.id}.${ext}`;
    const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: file.mimeType, upsert: false });
    if (up.error && !/exists|duplicate/i.test(up.error.message || '')) throw up.error;
    const ins = await sb.from('venia_board_files').upsert(
      { id: file.id, board_id: boardId, path, mime: file.mimeType, bytes: blob.size, source_url: file.sourceUrl || null, created_by: this.email || null },
      { onConflict: 'board_id,id', ignoreDuplicates: true });
    if (ins.error) throw ins.error;
    return true;
  },

  async knownFileIds(boardId) {
    if (this.mode !== 'cloud') return new Set((await get('files:' + boardId, idb)) || []);
    const { data } = await sb.from('venia_board_files').select('id').eq('board_id', boardId);
    return new Set((data || []).map(r => r.id));
  },

  // Pictures already on this device, read from its own store: no network.
  async cachedFiles(ids) {
    const out = [];
    for (const id of ids) { const f = await get('file:' + id, idb); if (f) out.push({ id, ...f }); }
    return out;
  },

  async loadFiles(boardId, onlyIds = null) {
    const out = [];
    if (this.mode !== 'cloud') {
      const ids = onlyIds || (await get('files:' + boardId, idb)) || [];
      for (const id of ids) { const f = await get('file:' + id, idb); if (f) out.push({ id, ...f }); }
      return out;
    }
    let q = sb.from('venia_board_files').select('id,path,mime,created_at').eq('board_id', boardId);
    if (onlyIds) q = q.in('id', onlyIds);
    const { data } = await q;
    const rows = data || [];
    const missing = [];
    for (const r of rows) {
      const c = await get('file:' + r.id, idb);
      if (c) out.push({ id: r.id, ...c }); else missing.push(r);
    }
    if (missing.length) {
      const signed = await sb.storage.from(BUCKET).createSignedUrls(missing.map(r => r.path), 3600);
      const byPath = {}; (signed.data || []).forEach(s => { byPath[s.path] = s.signedUrl; });
      await Promise.all(missing.map(async r => {
        try {
          const u = byPath[r.path]; if (!u) return;
          const blob = await (await fetch(u)).blob();
          const dataURL = await blobToDataURL(blob);
          const f = { dataURL, mimeType: r.mime || blob.type, created: Date.parse(r.created_at) || Date.now() };
          await set('file:' + r.id, f, idb);
          out.push({ id: r.id, ...f });
        } catch (e) { /* one missing image never blocks the board */ }
      }));
    }
    return out;
  },

  // ── thumbnails for the boards grid ───────────────────────────────────────
  async saveThumb(boardId, blob) {
    await set('thumbAt:' + boardId, Date.now(), idb);
    if (this.mode !== 'cloud') { await set('thumb:' + boardId, await blobToDataURL(blob), idb); return; }
    await sb.storage.from(BUCKET).upload(`${WS}/thumbs/${boardId}.png`, blob, { contentType: 'image/png', upsert: true });
    await set('thumb:' + boardId, await blobToDataURL(blob), idb);
  },
  // When this device last drew a board's preview (0 if never).
  async thumbAt(boardId) { return (await get('thumbAt:' + boardId, idb)) || 0; },
  async thumbs(ids) {
    const out = {};
    for (const id of ids) { const t = await get('thumb:' + id, idb); if (t) out[id] = t; }
    if (this.mode === 'cloud') {
      const need = ids.filter(id => !out[id]);
      if (need.length) {
        const s = await sb.storage.from(BUCKET).createSignedUrls(need.map(id => `${WS}/thumbs/${id}.png`), 3600);
        (s.data || []).forEach(x => { if (x.signedUrl && !x.error) out[x.path.split('/').pop().replace('.png', '')] = x.signedUrl; });
      }
    }
    return out;
  },

  // ── the old Brainstorm Board ─────────────────────────────────────────────
  // Boards replaces the small Board that lived inside Brainstorm. Its cards
  // sit in the Brainstorm row (key 'board'); we read them, never write them,
  // so nothing is lost and Enigma's "pin to Board" keeps arriving here.
  async legacyBoardCards() {
    if (this.mode !== 'cloud') return [];
    const { data } = await sb.from('venia_module_data').select('board:data->board, dump:data->dump')
      .eq('workspace_id', WS).eq('module', 'brainstorm').maybeSingle();
    const b = data && data.board;
    const cards = (b && Array.isArray(b.cards)) ? b.cards : [];
    // Goal cards only hold a goal id; the title lives with the goal itself.
    const goals = {};
    (Array.isArray(data && data.dump) ? data.dump : []).forEach(g => { if (g && g.id) goals[g.id] = g.t || ''; });
    return cards.map(c => c.kind === 'goal' ? { ...c, goalTitle: goals[c.goalId] || '' } : c);
  },

  // ── comments and @ mentions ──────────────────────────────────────────────
  // A comment sits on a spot on the board, or on one item (then x, y is its
  // offset from that item). Replies carry thread_id. Nothing is ever removed
  // here: a comment is hidden (hidden_at) or resolved (resolved_at).
  async listComments(boardId) {
    if (this.mode === 'cloud') {
      const { data, error } = await sb.from('venia_board_comments').select('*')
        .eq('board_id', boardId).is('hidden_at', null).order('created_at');
      if (error) throw error;
      return data || [];
    }
    return ((await get('comments:' + boardId, idb)) || []).filter(c => !c.hidden_at);
  },
  async addComment(boardId, c, boardTitle) {
    const row = { id: uid('c'), workspace_id: WS, board_id: boardId, thread_id: c.thread_id || null, element_id: c.element_id || null,
      x: c.x || 0, y: c.y || 0, body: c.body, mentions: c.mentions || [], author: this.email || 'you', created_at: now() };
    if (this.mode === 'cloud') {
      const { error } = await sb.from('venia_board_comments').insert(row);
      if (error) throw error;
      const tell = (row.mentions || []).filter(e => e && e !== this.email);
      if (tell.length) {
        const m = await sb.from('venia_board_mentions').insert(tell.map(email => ({
          comment_id: row.id, email, board_id: boardId, board_title: boardTitle || null,
          author: this.email, excerpt: row.body.slice(0, 200) })));
        if (m.error) console.warn('[boards] mention not sent', m.error);
      }
      return row;
    }
    const all = (await get('comments:' + boardId, idb)) || [];
    all.push(row); await set('comments:' + boardId, all, idb);
    return row;
  },
  async patchComment(boardId, id, patch) {
    if (this.mode === 'cloud') {
      const { error } = await sb.from('venia_board_comments').update(patch).eq('id', id);
      if (error) throw error;
      return;
    }
    const all = (await get('comments:' + boardId, idb)) || [];
    const i = all.findIndex(c => c.id === id); if (i >= 0) all[i] = { ...all[i], ...patch };
    await set('comments:' + boardId, all, idb);
  },
  resolveComment(boardId, id, yes = true) { return this.patchComment(boardId, id, yes ? { resolved_at: now(), resolved_by: this.email || null } : { resolved_at: null, resolved_by: null }); },
  hideComment(boardId, id) { return this.patchComment(boardId, id, { hidden_at: now() }); },
  async markMentionsSeen(boardId) {
    if (this.mode !== 'cloud' || !this.email) return;
    await sb.from('venia_board_mentions').update({ seen_at: now() }).eq('email', this.email).eq('board_id', boardId).is('seen_at', null);
  },
  // Who can be @ mentioned: the founders and everyone holding Brainstorm.
  async people() {
    if (this.mode !== 'cloud') return [];
    if (this._people) return this._people;
    const { data } = await sb.rpc('venia_boards_people');
    this._people = (data || []).map(r => r.email || r).filter(Boolean).map(email => ({ email, name: nameOf(email) }));
    return this._people;
  },

  // ── pinned boards (each person's own) ────────────────────────────────────
  async pins() {
    if (this.mode === 'cloud') {
      const { data } = await sb.from('venia_board_pins').select('board_id,pinned').eq('email', this.email);
      return new Set((data || []).filter(r => r.pinned).map(r => r.board_id));
    }
    return new Set((await get('pins', idb)) || []);
  },
  async setPin(boardId, pinned) {
    if (this.mode === 'cloud') {
      const { error } = await sb.from('venia_board_pins').upsert({ email: this.email, board_id: boardId, pinned, updated_at: now() }, { onConflict: 'email,board_id' });
      if (error) throw error;
      return;
    }
    const s = new Set((await get('pins', idb)) || []);
    pinned ? s.add(boardId) : s.delete(boardId);
    await set('pins', [...s], idb);
  },

  // ── folders: put a board inside another ──────────────────────────────────
  // The board's parent changes, and its card moves with it: a card appears on
  // the new parent (to the right of what's there) and leaves the old one, so
  // you always reach a board by opening the board that holds it.
  async moveInto(id, parentId, makeCard, { addCard = true } = {}) {
    const all = await this.listBoards();
    const me = all.find(b => b.id === id); if (!me) return;
    if (parentId) {
      // never inside itself or inside something it holds
      let p = parentId, guard = 0;
      while (p && guard++ < 50) { if (p === id) throw new Error('A board can\'t go inside itself.'); p = (all.find(b => b.id === p) || {}).parent_id; }
    }
    const was = me.parent_id;
    await this.move(id, parentId || null);
    const edit = async (boardId, fn) => {
      for (let i = 0; i < 3; i++) {
        const row = await this.loadBoard(boardId); if (!row) return;
        const scene = row.scene || { elements: [], appState: {} };
        const next = fn(scene.elements || []); if (!next) return;
        const res = await this.saveScene(boardId, { ...scene, elements: next }, row.rev || 0, {});
        if (!res.conflict) return;
      }
    };
    if (was && was !== parentId) await edit(was, els => {
      const hit = els.filter(e => !e.isDeleted && e.customData && e.customData.kind === 'board' && e.customData.boardId === id);
      if (!hit.length) return null;
      const ids = new Set(hit.map(e => e.id));
      hit.forEach(e => (e.boundElements || []).forEach(b => ids.add(b.id)));
      return els.map(e => ids.has(e.id) || (e.containerId && ids.has(e.containerId)) ? { ...e, isDeleted: true, version: (e.version || 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() } : e);
    });
    // addCard false: the caller already has the card on that board (an Undo).
    if (parentId && addCard) await edit(parentId, els => {
      const live = els.filter(e => !e.isDeleted);
      if (live.some(e => e.customData && e.customData.kind === 'board' && e.customData.boardId === id)) return null;
      let x = 0, y = 0;
      if (live.length) { x = Math.max(...live.map(e => e.x + (e.width || 0))) + 60; y = Math.min(...live.map(e => e.y)); }
      return [...els, ...makeCard(x, y, me)];
    });
  },

  // A real, separate copy of a board: its own row, its own pictures (so
  // deleting either one never takes the other's), and every board made inside
  // it copied too. Cards that only link to a board elsewhere stay links.
  // Nothing about the original is changed.
  async copyBoard(srcId, { parent_id = null, title = null, seen = new Set() } = {}) {
    if (seen.has(srcId) || seen.size > 200) return null;
    seen.add(srcId);
    const src = await this.loadBoard(srcId);
    if (!src || src.trashed_at) return null;
    const newId = uid('b');
    // A copy pasted inside the board it copies (or inside one of its boards)
    // must not be copied again as one of the originals' boards.
    seen.add(newId);
    const name = title || src.title || 'Untitled board';
    const srcScene = src.scene || { elements: [], appState: {} };
    const live = (srcScene.elements || []).filter(e => e && !e.isDeleted);
    await this.createBoard({ id: newId, title: name, parent_id, scene: { elements: [], appState: srcScene.appState || {} } });
    // boards made inside the original
    const kids = (await this.listBoards()).filter(b => b.parent_id === srcId);
    const map = new Map();
    for (const k of kids) {
      const c = await this.copyBoard(k.id, { parent_id: newId, seen });
      if (c) map.set(k.id, c);
    }
    const elements = live.map(e => (e.customData && e.customData.kind === 'board' && map.has(e.customData.boardId))
      ? { ...e, customData: { ...e.customData, boardId: map.get(e.customData.boardId) } } : e);
    // pictures, copied under the new board
    const used = [...new Set(live.filter(e => e.type === 'image' && e.fileId).map(e => e.fileId))];
    if (used.length) {
      const files = await this.loadFiles(srcId, used);
      for (const f of files) await this.saveFile(newId, { id: f.id, dataURL: f.dataURL, mimeType: f.mimeType, created: f.created });
    }
    await this.saveScene(newId, { ...srcScene, elements }, 0, { item_count: src.item_count || 0, search_text: src.search_text || name });
    try {
      const t = (await this.thumbs([srcId]))[srcId];
      if (t) await this.saveThumb(newId, await (await fetch(t)).blob());
    } catch (e) { /* the card draws its own picture once opened */ }
    return newId;
  },

  // ── link cards ───────────────────────────────────────────────────────────
  // The page's title, picture and site, read on the server (a browser can't
  // read another site's page).
  async linkPreview(url) {
    if (this.mode !== 'cloud') return null;
    const { data, error } = await sb.functions.invoke('boards-link', { body: { url } });
    if (error || !data || data.error) return null;
    return data;
  },

  // ── live: a private channel per board ────────────────────────────────────
  async channel(boardId, presenceKey) {
    if (this.mode !== 'cloud') return null;
    try { await sb.realtime.setAuth(); } catch (e) {}
    return sb.channel('board:' + boardId, { config: { private: true, broadcast: { self: false }, presence: { key: presenceKey } } });
  },
  dropChannel(ch) { try { if (ch) sb.removeChannel(ch); } catch (e) {} },

  // ── carry boards made on this device up to the cloud ─────────────────────
  async localBoardsWaiting() {
    if (this.mode !== 'cloud') return [];
    return ((await get('boards', idb)) || []).filter(b => !b.trashed_at && !b.uploaded);
  },
  async uploadLocalBoards(onStep) {
    const all = (await get('boards', idb)) || [];
    const idMap = {};
    for (const b of all.filter(x => !x.trashed_at && !x.uploaded)) {
      const scene = (await get('scene:' + b.id, idb)) || { elements: [], appState: {} };
      // Same id in the cloud, so cards for boards inside it still open them,
      // and a second run can't make a second copy.
      let row;
      try { row = await this.createBoard({ id: b.id, title: b.title, parent_id: null, scene }); }
      catch (e) { if (!/duplicate|conflict|23505/i.test(String((e.code || '') + ' ' + (e.message || e)))) throw e; row = { id: b.id }; }
      idMap[b.id] = row.id;
      const ids = (await get('files:' + b.id, idb)) || [];
      for (const fid of ids) { const f = await get('file:' + fid, idb); if (f) await this.saveFile(row.id, { id: fid, ...f }); }
      b.uploaded = row.id;
      await set('boards', all, idb);   // remembered board by board
      if (onStep) onStep(b.title);
    }
    for (const b of all) if (b.parent_id && idMap[b.parent_id] && idMap[b.id]) await this.move(idMap[b.id], idMap[b.parent_id]);
    await set('boards', all, idb);
  },
};

// "keeter@veniacollection.com" -> "Keeter"
export function nameOf(email) {
  const n = String(email || '').split('@')[0].split(/[._-]/)[0];
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'Someone';
}

export function dataURLToBlob(dataURL) {
  const [head, body] = dataURL.split(',');
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const bin = atob(body); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
export function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}
