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

export const store = {
  mode: 'local',          // 'cloud' | 'local'
  reason: '',             // why local: 'signed-out' | 'not-set-up' | 'offline'
  email: '',
  role: 'owner',          // owner | editor | viewer
  get canEdit() { return this.role !== 'viewer'; },

  async init() {
    try {
      const url = localStorage.getItem('venia-sb-url') || DEFAULT_URL;
      const key = localStorage.getItem('venia-sb-key') || DEFAULT_KEY;
      sb = createClient(url, key);
      const { data } = await sb.auth.getSession();
      const user = data && data.session && data.session.user;
      if (!user) { this.mode = 'local'; this.reason = 'signed-out'; return this; }
      this.email = String(user.email || '').toLowerCase();
      const probe = await sb.from('venia_boards').select('id').limit(1);
      if (probe.error) {
        const c = String(probe.error.code || '');
        this.mode = 'local';
        this.reason = (c === '42P01' || c === 'PGRST205' || /does not exist|schema cache/i.test(probe.error.message || '')) ? 'not-set-up' : 'offline';
        return this;
      }
      this.mode = 'cloud';
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

  // ── boards ───────────────────────────────────────────────────────────────
  async listBoards({ trash = false } = {}) {
    if (this.mode === 'cloud') {
      let q = sb.from('venia_boards')
        .select('id,parent_id,title,search_text,item_count,cover_file,updated_at,updated_by,trashed_at,sort')
        .eq('workspace_id', WS);
      q = trash ? q.not('trashed_at', 'is', null) : q.is('trashed_at', null);
      const { data, error } = await q.order('updated_at', { ascending: false });
      if (error) throw error;
      return data || [];
    }
    const all = (await get('boards', idb)) || [];
    return all.filter(b => trash ? !!b.trashed_at : !b.trashed_at)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  },

  async createBoard({ id = null, title = 'Untitled board', parent_id = null, scene = null } = {}) {
    const row = {
      id: id || uid('b'), workspace_id: WS, parent_id, title,
      scene: scene || { elements: [], appState: {} },
      search_text: title, item_count: (scene && scene.elements ? scene.elements.length : 0),
      created_by: this.email || null, created_at: now(), updated_by: this.email || null, updated_at: now(), rev: 0,
    };
    if (this.mode === 'cloud') {
      const { error } = await sb.from('venia_boards').insert(row);
      if (error) throw error;
      return row;
    }
    const all = (await get('boards', idb)) || [];
    const { scene: sc, ...meta } = row;
    all.push(meta);
    await set('boards', all, idb);
    await set('scene:' + row.id, sc, idb);
    return row;
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
    if (this.mode !== 'cloud') { await set('thumb:' + boardId, await blobToDataURL(blob), idb); return; }
    await sb.storage.from(BUCKET).upload(`${WS}/thumbs/${boardId}.png`, blob, { contentType: 'image/png', upsert: true });
    await set('thumb:' + boardId, await blobToDataURL(blob), idb);
  },
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
      const row = await this.createBoard({ title: b.title, parent_id: null, scene });
      idMap[b.id] = row.id;
      const ids = (await get('files:' + b.id, idb)) || [];
      for (const fid of ids) { const f = await get('file:' + fid, idb); if (f) await this.saveFile(row.id, { id: fid, ...f }); }
      b.uploaded = row.id;
      if (onStep) onStep(b.title);
    }
    for (const b of all) if (b.parent_id && idMap[b.parent_id] && idMap[b.id]) await this.move(idMap[b.id], idMap[b.parent_id]);
    await set('boards', all, idb);
  },
};

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
