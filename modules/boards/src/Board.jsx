import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import {
  Excalidraw, MainMenu, WelcomeScreen, CaptureUpdateAction,
  convertToExcalidrawElements, restoreElements, reconcileElements, getSceneVersion,
  exportToBlob, viewportCoordsToSceneCoords, newElementWith, FONT_FAMILY,
} from '@excalidraw/excalidraw';
import { store, uid } from './store.js';
import { inHost, tellHost } from './host.js';
import { go, NewBoard, LEGACY_ID } from './App.jsx';
import { NOTE_COLOURS, note, boardCard, paletteRow, frameAround, legacyCardElements } from './elements.js';
import { arrange, selectionUnits } from './layout.js';
import { prepareImage, fetchImage, looksLikeImageUrl, extractPalette } from './images.js';
import { todoCard, linkCard, cardWords, isCardUrl, makeRenderCard, hostOf } from './cards.jsx';
import { newColumn, isColumn, restack } from './columns.js';
import { useLive } from './live.js';
import { CommentsLayer, CommentsPanel, threadsOf, spotOf, focusSpot } from './comments.jsx';
import { nameOf } from './store.js';

const BG = '#F7F6F2';
const DEFAULTS = {
  viewBackgroundColor: BG,
  currentItemRoughness: 0,
  currentItemStrokeColor: '#111111',
  currentItemBackgroundColor: 'transparent',
  currentItemFontFamily: FONT_FAMILY.Helvetica,
  currentItemRoundness: 'sharp',
  currentItemStrokeWidth: 1,
  currentItemEndArrowhead: 'arrow',
};
const IMG_SIDE = 320;   // how big a new photo lands on the canvas

// Pages that play in place (video, music, design files) stay embeds; every
// other link becomes a card with the page's picture and title.
const PLAYS_IN_PLACE = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|figma\.com|open\.spotify\.com|soundcloud\.com|loom\.com|giphy\.com)$/i;
const isWebUrl = (t) => /^https?:\/\/\S+$/i.test(t);

export default function Board({ boardId, commentId }) {
  const [initial, setInitial] = useState(null);
  const [meta, setMeta] = useState(null);
  const [trail, setTrail] = useState([]);
  const [status, setStatus] = useState('');
  const [api, setApi] = useState(null);
  const [sel, setSel] = useState({ count: 0, oneImage: null });
  const [panel, setPanel] = useState(null);       // 'note' | 'arrange' | 'board' | 'link'
  const [busy, setBusy] = useState('');
  const [missing, setMissing] = useState(false);
  const [rows, setRows] = useState([]);           // comments, flat
  const [adding, setAdding] = useState(false);    // placing a new comment
  const [openId, setOpenId] = useState(null);     // the open thread
  const [showResolved, setShowResolved] = useState(false);
  const [people, setPeople] = useState([]);
  const [view, setView] = useState(0);            // bumps when the canvas moves, to move the pins
  const R = useRef({ rev: 0, savedVersion: -1, timer: null, saving: false, again: false, uploaded: new Set(), uploading: new Set(), thumbAt: 0, thumbVersion: -1, bg: BG });
  const wrapRef = useRef(null);
  const fileInput = useRef(null);

  // ── load ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const row = await store.loadBoard(boardId);
        if (dead) return;
        if (!row) { setMissing(true); return; }
        const files = await store.loadFiles(boardId);
        R.current.rev = row.rev || 0;
        (await store.knownFileIds(boardId)).forEach(id => R.current.uploaded.add(id));
        const elements = restoreElements(row.scene && row.scene.elements || [], null);
        R.current.savedVersion = getSceneVersion(elements);
        R.current.thumbVersion = R.current.savedVersion;
        R.current.legacyPending = (row.scene && row.scene.legacyPending) || [];
        R.current.bg = (row.scene && row.scene.appState && row.scene.appState.viewBackgroundColor) || BG;
        setMeta(row);
        setInitial({
          elements,
          files,
          appState: { ...DEFAULTS, ...(row.scene && row.scene.appState || {}) },
          scrollToContent: true,
        });
        // breadcrumb
        const list = await store.listBoards();
        const by = Object.fromEntries(list.map(b => [b.id, b]));
        const t = []; let p = row.parent_id; let guard = 0;
        while (p && by[p] && guard++ < 12) { t.unshift(by[p]); p = by[p].parent_id; }
        setTrail(t);
        document.title = row.title + ' · Boards';
        tellHost('boards:title', { title: row.title });
      } catch (e) { setStatus('Couldn\'t open: ' + (e.message || e)); }
    })();
    return () => { dead = true; };
  }, [boardId]);

  // ── save ─────────────────────────────────────────────────────────────────
  const sceneFor = useCallback((a) => {
    const els = a.getSceneElementsIncludingDeleted();
    const st = a.getAppState();
    const live = els.filter(e => !e.isDeleted);
    const words = live.filter(e => e.type === 'text').map(e => e.text)
      .concat(live.filter(e => e.type === 'frame' && e.name).map(e => e.name))
      .concat(live.filter(e => e.type === 'embeddable').map(cardWords)).join(' ').replace(/\s+/g, ' ').slice(0, 20000);
    const firstImage = live.find(e => e.type === 'image' && e.fileId);
    return {
      // files and appState travel with the snapshot: on the way out the
      // canvas is torn down before a slow save would get to read them.
      files: a.getFiles(), appState: st,
      scene: { elements: els, appState: { viewBackgroundColor: st.viewBackgroundColor, gridModeEnabled: !!st.gridModeEnabled } },
      // Count what a person would call one thing: a palette, a group or a
      // labelled note is one item, not its parts.
      extra: { search_text: (meta ? meta.title + ' ' : '') + words, item_count: new Set(live.filter(e => !e.containerId).map(e => e.groupIds && e.groupIds.length ? 'g' + e.groupIds[e.groupIds.length - 1] : e.id)).size, cover_file: firstImage ? firstImage.fileId : null },
      version: getSceneVersion(els),
    };
  }, [meta]);

  const uploadFiles = useCallback(async (snap) => {
    const files = snap.files || {};
    const live = new Set(snap.scene.elements.filter(e => !e.isDeleted && e.type === 'image').map(e => e.fileId));
    for (const id of Object.keys(files)) {
      if (!live.has(id) || R.current.uploaded.has(id) || R.current.uploading.has(id)) continue;
      R.current.uploading.add(id);
      try { await store.saveFile(boardId, files[id]); R.current.uploaded.add(id); }
      catch (e) { setStatus('An image didn\'t upload; will retry'); }
      finally { R.current.uploading.delete(id); }
    }
  }, [boardId]);

  const mergeRemote = useCallback(async (a, remote) => {
    const remoteEls = restoreElements(remote.scene && remote.scene.elements || [], null);
    const merged = reconcileElements(a.getSceneElementsIncludingDeleted(), remoteEls, a.getAppState());
    const have = new Set(Object.keys(a.getFiles()));
    const need = merged.filter(e => e.type === 'image' && e.fileId && !have.has(e.fileId)).map(e => e.fileId);
    if (need.length) a.addFiles(await store.loadFiles(boardId, need));
    a.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    R.current.rev = remote.rev;
    return merged;
  }, [boardId]);

  // Save what's on the canvas. The scene is read FIRST, in one go, and
  // everything after works from that copy. Leaving a board tears the canvas
  // down; reading it afterwards would find it empty and save an empty board
  // over the real one. So once the board is closing (R.current.dead) only the
  // copy taken while it was still open may be saved.
  const save = useCallback(async (given) => {
    const a = api; if (!a || !store.canEdit) return;
    const snapIn = given && given.scene ? given : null;
    if (R.current.dead && !snapIn) return;
    if (R.current.saving) { if (snapIn) R.current.pendingSnap = snapIn; else R.current.again = true; return; }
    R.current.saving = true;
    try {
      let snap = snapIn || sceneFor(a);
      let { scene, extra, version } = snap;
      if (version === R.current.savedVersion && R.current.bg === scene.appState.viewBackgroundColor) return;
      await uploadFiles(snap);
      if (!R.current.dead) setStatus('Saving…');
      let res = await store.saveScene(boardId, scene, R.current.rev, extra);
      if (res.conflict && res.remote) {
        if (!R.current.dead) {
          await mergeRemote(a, res.remote);
          ({ scene, extra, version } = sceneFor(a));
        } else {
          const merged = reconcileElements(scene.elements, restoreElements(res.remote.scene && res.remote.scene.elements || [], null), snap.appState);
          scene = { ...scene, elements: merged }; version = getSceneVersion(merged);
          R.current.rev = res.remote.rev;
        }
        res = await store.saveScene(boardId, scene, R.current.rev, extra);
      }
      if (res.conflict) { setStatus('Someone else is editing; retrying'); R.current.again = true; return; }
      R.current.rev = res.rev; R.current.savedVersion = version; R.current.bg = scene.appState.viewBackgroundColor;
      setStatus(store.mode === 'cloud' ? 'Saved' : 'Saved on this device');
      if (Date.now() - R.current.thumbAt > 15000) R.current.wantThumb = true;
    } catch (e) {
      setStatus('Not saved yet: ' + (e.message || 'offline'));
      R.current.again = true;
    } finally {
      R.current.saving = false;
      if (R.current.pendingSnap) { const p = R.current.pendingSnap; R.current.pendingSnap = null; R.current.again = false; save(p); return; }
      if (R.current.again && !R.current.dead) { R.current.again = false; clearTimeout(R.current.timer); R.current.timer = setTimeout(save, 2500); }
      if (R.current.wantThumb && R.current.thumbFn) { R.current.wantThumb = false; R.current.thumbFn(); }
    }
  }, [api, boardId, sceneFor, uploadFiles, mergeRemote]);

  const thumb = useCallback(async (snap) => {
    const a = api; if (!a || !store.canEdit) return;
    if (R.current.dead && !(snap && snap.scene)) return;
    const all = snap && snap.scene ? snap.scene.elements : a.getSceneElementsIncludingDeleted();
    const els = all.filter(e => !e.isDeleted);
    const v = getSceneVersion(all);
    if (!els.length || v === R.current.thumbVersion) return;
    try {
      const blob = await exportToBlob({ elements: els, files: snap && snap.files ? snap.files : a.getFiles(), mimeType: 'image/png', maxWidthOrHeight: 720, exportPadding: 24,
        appState: { exportBackground: true, viewBackgroundColor: snap && snap.scene ? snap.scene.appState.viewBackgroundColor : a.getAppState().viewBackgroundColor } });
      await store.saveThumb(boardId, blob);
      R.current.thumbVersion = v; R.current.thumbAt = Date.now();
    } catch (e) {}
  }, [api, boardId]);

  R.current.thumbFn = thumb;

  // ── live together ────────────────────────────────────────────────────────
  const fetchMissing = useCallback(async (ids) => {
    // Their image may still be on its way up (a big photo from a phone can
    // take a while); keep trying for about a minute.
    for (let i = 0; i < 15 && api; i++) {
      const have = new Set(Object.keys(api.getFiles()));
      const need = ids.filter(id => !have.has(id)); if (!need.length) return;
      const got = await store.loadFiles(boardId, need).catch(() => []);
      if (got.length) { api.addFiles(got); got.forEach(f => R.current.uploaded.add(f.id)); }
      if (got.length === need.length) return;
      await new Promise(r => setTimeout(r, 4000));
    }
  }, [api, boardId]);

  // ── comments ─────────────────────────────────────────────────────────────
  const loadComments = useCallback(async () => {
    try { setRows(await store.listComments(boardId)); } catch (e) {}
  }, [boardId]);
  const live = useLive({ api, boardId, onFilesNeeded: fetchMissing, onCommentsChanged: loadComments });
  const threads = threadsOf(rows);
  const openCount = threads.filter(t => !t.root.resolved_at).length;

  useEffect(() => {
    if (!api) return;
    loadComments();
    store.people().then(setPeople).catch(() => {});
    store.markMentionsSeen(boardId).then(() => tellHost('boards:mentions-seen', { boardId })).catch(() => {});
  }, [api, boardId, loadComments]);
  // without a live channel, look for new comments now and then
  useEffect(() => {
    if (!api || live.on) return;
    const t = setInterval(() => { if (!document.hidden) loadComments(); }, 20000);
    return () => clearInterval(t);
  }, [api, live.on, loadComments]);
  // opened from a mention: go to that thread
  useEffect(() => {
    if (!api || !commentId || !rows.length) return;
    const c = rows.find(r => r.id === commentId); if (!c) return;
    const root = c.thread_id ? rows.find(r => r.id === c.thread_id) || c : c;
    const spot = spotOf(api, root);
    if (root.resolved_at) setShowResolved(true);
    if (spot) focusSpot(api, spot);
    setOpenId(root.id);
  }, [api, commentId, rows.length]);

  async function addComment({ body, mentions, element_id, x, y, thread_id }) {
    try {
      await store.addComment(boardId, { body, mentions, element_id, x, y, thread_id }, meta && meta.title);
      await loadComments(); live.commentsChanged();
      const names = (mentions || []).filter(m => m !== store.email).map(nameOf);
      setStatus(names.length ? 'Sent to ' + names.join(' and ') : 'Comment added');
    } catch (e) { setStatus('Couldn\'t add the comment: ' + (e.message || e)); }
  }
  async function resolveThread(root, yes) {
    try { await store.resolveComment(boardId, root.id, yes); await loadComments(); live.commentsChanged(); if (yes && !showResolved) setOpenId(null); }
    catch (e) { setStatus('Couldn\'t change it: ' + (e.message || e)); }
  }
  async function hideComment(c) {
    if (!window.confirm('Remove this comment?')) return;
    try { await store.hideComment(boardId, c.id); await loadComments(); live.commentsChanged(); if (!c.thread_id) setOpenId(null); }
    catch (e) { setStatus('Couldn\'t remove it: ' + (e.message || e)); }
  }

  // ── columns keep themselves stacked ──────────────────────────────────────
  const tidyColumns = useCallback(() => {
    const a = api; if (!a) return;
    const next = restack(a.getSceneElementsIncludingDeleted());
    if (next) a.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.EVENTUALLY });
  }, [api]);

  const onChange = useCallback((elements, appState) => {
    const ids = Object.keys(appState.selectedElementIds || {}).filter(k => appState.selectedElementIds[k]);
    const picked = elements.filter(e => ids.includes(e.id) && !e.isDeleted);
    const oneImage = picked.length === 1 && picked[0].type === 'image' ? picked[0] : null;
    setSel(s => (s.count === picked.length && s.oneImage === oneImage) ? s : { count: picked.length, oneImage });
    // pins follow the canvas and the items they're on
    const vk = [appState.scrollX, appState.scrollY, appState.zoom.value, appState.width, appState.height, getSceneVersion(elements)].join('|');
    if (vk !== R.current.viewKey) { R.current.viewKey = vk; if (!R.current.viewRaf) R.current.viewRaf = requestAnimationFrame(() => { R.current.viewRaf = 0; setView(x => x + 1); }); }
    if (!store.canEdit) return;
    live.sceneChanged(elements);
    // once nothing is moving, columns close up around what's in them
    const still = !appState.selectedElementsAreBeingDragged && !appState.resizingElement && !appState.newElement && !appState.editingTextElement;
    if (still && elements.some(isColumn)) { cancelAnimationFrame(R.current.colRaf); R.current.colRaf = requestAnimationFrame(tidyColumns); }
    const v = getSceneVersion(elements);
    if (v !== R.current.savedVersion || appState.viewBackgroundColor !== R.current.bg) {
      clearTimeout(R.current.timer);
      R.current.timer = setTimeout(save, 1200);
    }
  }, [save, live, tidyColumns]);

  // ── follow other people's edits (Christine on her phone, say) ───────────
  useEffect(() => {
    if (!api || store.mode !== 'cloud') return;
    const t = setInterval(async () => {
      if (document.hidden || R.current.saving) return;
      // live edits arrive by themselves; this only catches what the channel missed
      if (live.on && Date.now() - (R.current.lastPoll || 0) < 30000) return;
      R.current.lastPoll = Date.now();
      try {
        const r = await store.remoteRev(boardId);
        if (!r || r.rev <= R.current.rev) return;
        const remote = await store.loadBoard(boardId);
        const merged = await mergeRemote(api, remote);
        const mine = getSceneVersion(merged);
        // If nothing of ours is unsaved, we're now level with the cloud.
        if (getSceneVersion(restoreElements(remote.scene.elements || [], null)) === mine) R.current.savedVersion = mine;
        else { clearTimeout(R.current.timer); R.current.timer = setTimeout(save, 800); }
      } catch (e) {}
    }, 12000);
    return () => clearInterval(t);
  }, [api, boardId, mergeRemote, save, live.on]);

  // thumbnails: now and then while working, and on the way out
  useEffect(() => {
    if (!api) return;
    const t = setInterval(() => { if (Date.now() - R.current.thumbAt > 40000) thumb(); }, 20000);
    const out = () => { if (document.visibilityState === 'hidden') { save(); thumb(); } };
    document.addEventListener('visibilitychange', out);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', out); };
  }, [api, save, thumb]);

  // On the way out: a layout effect's cleanup runs before the canvas below it
  // is torn down, so this is the last moment the scene can be read. Take the
  // copy now, mark the board closed, then save the copy.
  const latest = useRef({ save, thumb, sceneFor, api });
  latest.current = { save, thumb, sceneFor, api };
  useLayoutEffect(() => () => {
    const { save: sv, thumb: th, sceneFor: sf, api: a } = latest.current;
    clearTimeout(R.current.timer);
    let snap = null;
    try { if (a && store.canEdit) snap = sf(a); } catch (e) {}
    R.current.dead = true;
    if (snap) { sv(snap); th(snap); }
  }, []);

  // open on the whole board, not just its top-left corner
  useEffect(() => {
    if (!api) return;
    const t = setTimeout(() => { try { if (api.getSceneElements().length) api.scrollToContent(undefined, { fitToContent: true }); } catch (e) {} }, 60);
    return () => clearTimeout(t);
  }, [api]);

  // ── the old Brainstorm Board: photos, and cards pinned since ────────────
  useEffect(() => {
    if (!api || boardId !== LEGACY_ID || !store.canEdit) return;
    (async () => {
      const cards = await store.legacyBoardCards().catch(() => []);
      const have = new Set(api.getSceneElements().map(e => e.customData && e.customData.legacyId).filter(Boolean));
      const fresh = cards.filter(c => !have.has(c.id));
      if (!fresh.length) return;
      const add = [];
      for (const c of fresh) {
        if (c.kind !== 'img') { add.push(...legacyCardElements(c)); continue; }
        const blob = c.url ? await fetchImage(c.url) : null;
        if (!blob) { add.push(...note(Number(c.x) || 0, Number(c.y) || 0, 'Photo from the old board couldn\'t be loaded', NOTE_COLOURS[1].hex, 200, 90).map(e => e.type === 'rectangle' ? { ...e, customData: { legacyId: c.id } } : e)); continue; }
        const img = await prepareImage(blob);
        const id = uid('f');
        api.addFiles([{ id, dataURL: img.dataURL, mimeType: img.mimeType, created: Date.now() }]);
        const w = Number(c.w) || 220;
        add.push(...convertToExcalidrawElements([{ type: 'image', fileId: id, x: Number(c.x) || 0, y: Number(c.y) || 0, width: w, height: w * img.height / img.width, customData: { legacyId: c.id } }]));
      }
      api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...add], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    })();
  }, [api, boardId]);

  // ── placing things ───────────────────────────────────────────────────────
  const center = () => {
    const s = api.getAppState(); const z = s.zoom.value;
    return { x: s.width / 2 / z - s.scrollX, y: s.height / 2 / z - s.scrollY };
  };
  // Somewhere near the middle that isn't already covered, so a new thing
  // never lands under (or over) something else. Cards in particular float
  // above the drawing, so they must not land on it.
  const spotFor = (w, h) => {
    const c = center();
    const live = api.getSceneElements().filter(e => !e.containerId);
    const hits = (x, y) => live.some(e => x < e.x + e.width + 16 && x + w + 16 > e.x && y < e.y + e.height + 16 && y + h + 16 > e.y);
    let x = c.x - w / 2, y = c.y - h / 2;
    for (let i = 0; i < 24 && hits(x, y); i++) {
      // walk right along the row, then start a row below
      x += w + 24;
      if (i % 6 === 5) { x = c.x - w / 2; y += h + 24; }
    }
    return { x, y };
  };
  const addEls = (els, select = true) => {
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), ...els],
      appState: select ? { selectedElementIds: Object.fromEntries(els.filter(e => !e.containerId).map(e => [e.id, true])), selectedGroupIds: {} } : undefined,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    // bring it into view if it landed off screen
    try { api.scrollToContent(els.filter(e => !e.containerId), { animate: true }); } catch (e) {}
  };

  function addNote(colour) {
    const p = spotFor(220, 160);
    addEls(note(p.x, p.y, 'New note', colour));
    setPanel(null);
  }

  // Photos: any number at once, laid out as a moodboard where they land.
  async function addImages(blobs, at, sources = []) {
    if (!blobs.length) return;
    setBusy(blobs.length > 1 ? `Adding ${blobs.length} images…` : 'Adding image…');
    try {
      const start = at || center();
      const placed = [];
      let x = start.x, y = start.y;
      for (let i = 0; i < blobs.length; i++) {
        const img = await prepareImage(blobs[i]);
        const id = uid('f');
        api.addFiles([{ id, dataURL: img.dataURL, mimeType: img.mimeType, created: Date.now() }]);
        const s = Math.min(1, IMG_SIDE / Math.max(img.width, img.height));
        const w = Math.round(img.width * s), h = Math.round(img.height * s);
        placed.push(...convertToExcalidrawElements([{ type: 'image', fileId: id, x, y, width: w, height: h, customData: sources[i] ? { source: sources[i] } : undefined }]));
        x += w + 24;
      }
      addEls(placed);
      if (placed.length > 1) {
        const ids = Object.fromEntries(placed.map(e => [e.id, true]));
        const next = arrange(api.getSceneElementsIncludingDeleted(), ids, 'masonry');
        if (next) api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      }
    } catch (e) { setStatus('Couldn\'t add that image: ' + (e.message || e)); }
    finally { setBusy(''); }
  }

  async function addFromLink(url) {
    url = String(url || '').trim(); if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    setPanel(null);
    // video, music and design files play right on the board
    if (PLAYS_IN_PLACE.test(hostOf(url))) {
      const p = spotFor(480, 270);
      const [r] = convertToExcalidrawElements([{ type: 'rectangle', x: p.x, y: p.y, width: 480, height: 270 }]);
      addEls(restoreElements([{ ...r, type: 'embeddable', link: url, strokeColor: 'transparent', backgroundColor: 'transparent' }], null));
      return;
    }
    if (looksLikeImageUrl(url)) {
      const blob = await fetchImage(url);
      if (blob) return addImages([blob], null, [url]);
    }
    setBusy('Reading the page…');
    try {
      const info = await store.linkPreview(url);
      if (info && info.kind === 'image' && !looksLikeImageUrl(url)) {
        const blob = await fetchImage(url); if (blob) return addImages([blob], null, [url]);
      }
      const p = spotFor(300, info && info.image ? 290 : 128);
      addEls(linkCard(p.x, p.y, { url, ...(info || {}), site: (info && info.site) || hostOf(url) }));
      if (!info) setStatus(store.mode === 'cloud' ? 'Couldn\'t read that page, so it\'s a plain link card' : 'Saved as a link card');
    } finally { setBusy(''); }
  }

  function addTodo() {
    const p = spotFor(280, 128);
    addEls(todoCard(p.x, p.y));
    setStatus('Click the list to tick things off or add to it');
  }

  // A column: wraps what's selected, or starts empty in the middle.
  function addColumn() {
    const st = api.getAppState();
    const units = selectionUnits(api.getSceneElementsIncludingDeleted(), st.selectedElementIds);
    const members = units.flatMap(u => u.members).filter(m => m.type !== 'frame');
    let col;
    if (members.length) {
      const name = window.prompt('Name this column', 'Column'); if (name === null) return;
      const [x1, y1] = [Math.min(...members.map(m => m.x)), Math.min(...members.map(m => m.y))];
      col = { ...newColumn(x1 - 16, y1 - 16, name || 'Column') };
      const ids = new Set(members.map(m => m.id));
      const rest = api.getSceneElementsIncludingDeleted().map(e => ids.has(e.id) ? newElementWith(e, { frameId: col.id }) : e);
      api.updateScene({ elements: [col, ...rest], appState: { selectedElementIds: { [col.id]: true } }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    } else {
      const p = spotFor(300, 120);
      col = newColumn(p.x, p.y, 'Column');
      api.updateScene({ elements: [col, ...api.getSceneElementsIncludingDeleted()], appState: { selectedElementIds: { [col.id]: true } }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      setStatus('Drag notes, photos and cards into the column');
    }
    requestAnimationFrame(tidyColumns);
  }

  function doArrange(mode) {
    const next = arrange(api.getSceneElementsIncludingDeleted(), api.getAppState().selectedElementIds, mode);
    if (next) { api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY }); setStatus(''); }
    else setStatus('Select two or more things to arrange');
    setPanel(null);
  }

  function doFrame() {
    const st = api.getAppState();
    const units = selectionUnits(api.getSceneElementsIncludingDeleted(), st.selectedElementIds);
    const members = units.flatMap(u => u.members);
    if (!members.length) return;
    const name = window.prompt('Name this group', 'Group');
    if (name === null) return;
    const [f] = frameAround(members, name || 'Group');
    const others = api.getSceneElementsIncludingDeleted().map(e => members.some(m => m.id === e.id) ? newElementWith(e, { frameId: f.id }) : e);
    // A frame sits beneath what it holds.
    api.updateScene({ elements: [f, ...others], appState: { selectedElementIds: { [f.id]: true } }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }

  async function doPalette() {
    const el = sel.oneImage; if (!el) return;
    const f = api.getFiles()[el.fileId]; if (!f) return;
    setBusy('Reading colours…');
    try {
      const cols = await extractPalette(f.dataURL, 6);
      addEls(paletteRow(el.x, el.y + el.height + 18, cols));
    } finally { setBusy(''); }
  }

  function placeBoardCard(b) {
    const p = spotFor(240, 150);
    addEls(boardCard(p.x, p.y, b));
    setPanel(null);
  }

  // drop several photos at once, where they're dropped
  useEffect(() => {
    const el = wrapRef.current; if (!el || !api || !store.canEdit) return;
    const onDrop = (e) => {
      const files = [...(e.dataTransfer && e.dataTransfer.files || [])].filter(f => /^image\//.test(f.type));
      if (!files.length) return;
      e.preventDefault(); e.stopPropagation();
      const at = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, api.getAppState());
      addImages(files, at);
    };
    const onOver = (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); };
    el.addEventListener('drop', onDrop, true);
    el.addEventListener('dragover', onOver, true);
    return () => { el.removeEventListener('drop', onDrop, true); el.removeEventListener('dragover', onOver, true); };
  }, [api]);

  // N drops a note, unless you're typing
  useEffect(() => {
    if (!api || !store.canEdit) return;
    const k = (e) => {
      const t = e.target; if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (api.getAppState().editingTextElement) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); addNote(NOTE_COLOURS[0].hex); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [api]);

  const onPaste = useCallback((data) => {
    const text = (data && data.text || '').trim();
    if (api && store.canEdit && (looksLikeImageUrl(text) || isWebUrl(text))) { addFromLink(text); return false; }
    return true;
  }, [api]);

  const onLinkOpen = useCallback((element, event) => {
    const cd = element.customData || {};
    const link = element.link || '';
    // To-do and link cards carry a marker link, never a page to open.
    if (isCardUrl(link)) {
      event.preventDefault();
      if (cd.kind === 'link' && cd.url) window.open(cd.url, '_blank', 'noopener,noreferrer');
      return;
    }
    const m = cd.boardId || (link.match(/\/boards#\/b\/([\w-]+)/) || [])[1];
    if (m) { event.preventDefault(); save(); go('/b/' + m); }
  }, [save]);

  async function rename(t) {
    t = t.trim(); if (!t || !meta || t === meta.title) return;
    setMeta(m => ({ ...m, title: t }));
    await store.rename(boardId, t);
    document.title = t + ' · Boards'; tellHost('boards:title', { title: t });
  }

  const renderCard = React.useMemo(() => makeRenderCard(() => api, store.canEdit), [api]);

  if (missing) return <div className="empty">This board isn't here any more. <button className="link" onClick={() => go('/')}>Back to Boards</button></div>;

  return (
    <div className="board" ref={wrapRef}>
      <header className="bar">
        <nav className="crumbs">
          {!inHost && <a className="back-os" href="/">VENIA <span>OS</span></a>}
          <button className="crumb" onClick={() => { save(); go('/'); }}>Boards</button>
          {trail.map(b => <React.Fragment key={b.id}><span className="sep">/</span><button className="crumb" onClick={() => { save(); go('/b/' + b.id); }}>{b.title}</button></React.Fragment>)}
          <span className="sep">/</span>
          {meta && <input className="title" defaultValue={meta.title} readOnly={!store.canEdit} key={meta.id} onBlur={e => rename(e.target.value)} onKeyDown={e => e.key === 'Enter' && e.target.blur()} />}
        </nav>
        {store.canEdit && api && (
          <div className="actions">
            <div className="pop-wrap">
              <button className="act" onClick={() => setPanel(panel === 'note' ? null : 'note')} title="Add a note (N)"><Ico d="M5 4h14v11l-5 5H5z M14 20v-5h5" />Note</button>
              {panel === 'note' && <div className="pop swatches">{NOTE_COLOURS.map(c => <button key={c.hex} title={c.name} style={{ background: c.hex }} onClick={() => addNote(c.hex)} />)}</div>}
            </div>
            <button className="act" onClick={() => fileInput.current.click()} title="Add photos"><Ico d="M4 6h16v12H4z M4 15l4-4 4 4 3-3 5 5" />Photos</button>
            <div className="pop-wrap">
              <button className="act" onClick={() => setPanel(panel === 'link' ? null : 'link')} title="Add an image or page from a link"><Ico d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />Link</button>
              {panel === 'link' && <LinkPop onAdd={addFromLink} />}
            </div>
            <div className="pop-wrap">
              <button className="act" onClick={() => setPanel(panel === 'board' ? null : 'board')} title="A board inside this board"><Ico d="M4 4h16v16H4z M8 8h8v8H8z" />Board</button>
              {panel === 'board' && <BoardPop currentId={boardId} onPick={placeBoardCard} onNew={() => setPanel('newboard')} />}
            </div>
            <button className="act" onClick={addTodo} title="A checklist"><Ico d="M4 6l2 2 3-3 M4 13l2 2 3-3 M12 7h8 M12 14h8 M12 20h8 M4 20h2" />To-do</button>
            <button className="act" onClick={addColumn} title="A column that keeps what you drop in it stacked (wraps the selection)"><Ico d="M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h6" />Column</button>
            <span className="divider" />
            <div className="pop-wrap">
              <button className="act" disabled={sel.count < 2} onClick={() => setPanel(panel === 'arrange' ? null : 'arrange')} title="Tidy the selection"><Ico d="M4 4h7v7H4z M13 4h7v4h-7z M13 10h7v10h-7z M4 13h7v7H4z" />Arrange</button>
              {panel === 'arrange' && (
                <div className="pop list">
                  <button onClick={() => doArrange('masonry')}>Moodboard<small>pictures in even columns</small></button>
                  <button onClick={() => doArrange('grid')}>Grid</button>
                  <button onClick={() => doArrange('column')}>Column</button>
                  <button onClick={() => doArrange('row')}>Row</button>
                </div>
              )}
            </div>
            <button className="act" disabled={sel.count < 1} onClick={doFrame} title="Group the selection in a named frame"><Ico d="M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4" />Group</button>
            <button className="act" disabled={!sel.oneImage} onClick={doPalette} title="Pull a colour palette from the selected image"><Ico d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.6 0-1.3-1-1.4-1-2.6 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z M7.5 11.5h.01 M10 7.5h.01 M14.5 7.5h.01" />Palette</button>
          </div>
        )}
        {api && (
          <div className="actions">
            <span className="divider" />
            <button className={'act' + (adding ? ' on' : '')} onClick={() => { setAdding(a => !a); setOpenId(null); }} title="Click, then click a spot on the board to comment there"><Ico d="M4 5h16v11H9l-5 4z" />Comment</button>
            <button className={'act' + (panel === 'comments' ? ' on' : '')} onClick={() => setPanel(panel === 'comments' ? null : 'comments')} title="All comments on this board">
              <Ico d="M4 6h16 M4 12h16 M4 18h10" />{openCount ? <span className="count">{openCount}</span> : null}
            </button>
          </div>
        )}
        {live.on && live.people.length > 0 && (
          <div className="here" title={'Here now: ' + live.people.map(p => p.name).join(', ')}>
            {live.people.slice(0, 4).map(p => <span key={p.key} className="face" style={{ background: p.color }}>{(p.name || '?').slice(0, 1)}</span>)}
          </div>
        )}
        <div className="status">{busy || status || (live.on ? 'Live' : '')}</div>
      </header>
      <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={e => { addImages([...e.target.files]); e.target.value = ''; }} />
      <div className="canvas">
        {initial && (
          <Excalidraw
            excalidrawAPI={setApi}
            initialData={initial}
            onChange={onChange}
            onPaste={onPaste}
            onLinkOpen={onLinkOpen}
            onPointerUpdate={live.pointerMoved}
            isCollaborating={live.on}
            renderEmbeddable={renderCard}
            viewModeEnabled={!store.canEdit}
            langCode="en"
            name={meta ? meta.title : 'Board'}
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, export: { saveFileToDisk: true } }, tools: { image: true } }}
            validateEmbeddable={url => (isCardUrl(url) ? true : undefined)}
          >
            <MainMenu>
              <MainMenu.Item onSelect={() => { save(); go('/'); }}>All boards</MainMenu.Item>
              <MainMenu.Separator />
              <MainMenu.DefaultItems.SaveAsImage />
              <MainMenu.DefaultItems.Export />
              <MainMenu.DefaultItems.SearchMenu />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
              <MainMenu.Separator />
              <MainMenu.DefaultItems.ClearCanvas />
              <MainMenu.DefaultItems.Help />
            </MainMenu>
            <WelcomeScreen>
              <WelcomeScreen.Center>
                <WelcomeScreen.Center.Heading>{meta ? meta.title : 'Board'}</WelcomeScreen.Center.Heading>
                <div className="welcome-hints">
                  <p>Drop photos anywhere, or paste an image or a link.</p>
                  <p>Press N for a note. Draw, write and connect with the tools above.</p>
                  <p>Select a few things, then Arrange, Group or put them in a Column.</p>
                  <p>Click Comment to leave a note for someone. Type @ to mention them.</p>
                </div>
              </WelcomeScreen.Center>
            </WelcomeScreen>
          </Excalidraw>
        )}
        <CommentsLayer api={api} threads={threads} adding={adding} setAdding={setAdding} openId={openId} setOpenId={setOpenId}
          people={people} showResolved={showResolved} view={view}
          onAdd={addComment} onReply={(root, body, mentions) => addComment({ body, mentions, thread_id: root.id, element_id: root.element_id, x: root.x, y: root.y })}
          onResolve={resolveThread} onHide={hideComment} />
        {panel === 'comments' && api && (
          <CommentsPanel api={api} threads={threads} people={people} showResolved={showResolved} setShowResolved={setShowResolved}
            onClose={() => setPanel(null)}
            onPick={t => { const s = spotOf(api, t.root); if (s) focusSpot(api, s); if (t.root.resolved_at) setShowResolved(true); setOpenId(t.root.id); }} />
        )}
      </div>
      {panel === 'newboard' && <NewBoard parentId={boardId} onClose={() => setPanel(null)} onCreated={placeBoardCard} />}
    </div>
  );
}

function Ico({ d }) {
  return <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;
}

function LinkPop({ onAdd }) {
  const [v, setV] = useState('');
  return (
    <div className="pop form">
      <input autoFocus className="field" placeholder="Paste a link to an image or a page" value={v} onChange={e => setV(e.target.value)} onKeyDown={e => e.key === 'Enter' && onAdd(v)} />
      <button className="solid" onClick={() => onAdd(v)}>Add</button>
    </div>
  );
}

function BoardPop({ currentId, onPick, onNew }) {
  const [list, setList] = useState(null);
  useEffect(() => { store.listBoards().then(l => setList(l.filter(b => b.id !== currentId))); }, [currentId]);
  return (
    <div className="pop list">
      <button onClick={onNew}><b>New board inside this one</b></button>
      {list && list.length > 0 && <div className="pop-label">Or link an existing board</div>}
      <div className="pop-scroll">{(list || []).map(b => <button key={b.id} onClick={() => onPick(b)}>{b.title}</button>)}</div>
    </div>
  );
}
