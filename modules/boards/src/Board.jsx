import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import {
  Excalidraw, MainMenu, WelcomeScreen, CaptureUpdateAction,
  convertToExcalidrawElements, restoreElements, reconcileElements, getSceneVersion,
  exportToBlob, viewportCoordsToSceneCoords, sceneCoordsToViewportCoords, newElementWith, FONT_FAMILY,
} from '@excalidraw/excalidraw';
import { store, uid, dataURLToBlob } from './store.js';
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
  const [kids, setKids] = useState([]);   // boards whose parent is this one
  const [status, setStatus] = useState('');
  const [api, setApi] = useState(null);
  const [sel, setSel] = useState({ count: 0, oneImage: null });
  const [panel, setPanel] = useState(null);       // 'note' | 'arrange' | 'board' | 'link'
  const [tools, setTools] = useState(false);       // phone: the Add sheet is open
  const [dropping, setDropping] = useState(false); // something is being dragged over the board
  const [stackOn, setStackOn] = useState(null);    // { id, armed }: what a picture is held over
  const [undoStack, setUndoStack] = useState(null);// { text, undo } after a stack
  const [ghosts, setGhosts] = useState(null);      // pictures flying into a new board card
  const [cardInfo, setCardInfo] = useState({});    // board id -> { title, count, thumb }
  const [naming, setNaming] = useState(null);      // a board just made: name it, or undo
  const [drawing, setDrawing] = useState(false);   // phone: the drawing tools are showing
  const [backHot, setBackHot] = useState(false);   // something is held over the back arrow
  const [moving, setMoving] = useState(false);     // the Move to… list is open
  const backRef = useRef(null);
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
        // Open at once with the pictures this device already has; the rest
        // arrive one by one. Only pictures still on the board are fetched,
        // never ones that were deleted or moved away.
        const liveIds = [...new Set((row.scene && row.scene.elements || []).filter(e => e && !e.isDeleted && e.type === 'image' && e.fileId).map(e => e.fileId))];
        const files = await store.cachedFiles(liveIds);
        const have = new Set(files.map(f => f.id));
        const later = liveIds.filter(id => !have.has(id));
        R.current.lateFiles = later.length ? later : null;
        R.current.rev = row.rev || 0;
        (await store.knownFileIds(boardId)).forEach(id => R.current.uploaded.add(id));
        // Board cards open with a double tap, not a link: a link made the
        // browser's link editor pop up on every tap.
        const raw = (row.scene && row.scene.elements || []).map(e => (e && e.customData && e.customData.kind === 'board' && e.link) ? { ...e, link: null } : e);
        const elements = restoreElements(raw, null);
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
        if (!dead) setKids(list.filter(b => b.parent_id === boardId && !b.trashed_at));
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

  // ── one picture onto another makes a board (like apps into a folder) ────
  // Hold a picture over another picture for a moment and let go: both move
  // into a new board, and a board card takes their place. Hold it over a
  // board card instead and it goes into that board. Inside a column, moving
  // pictures only reorders them, so columns never stack.
  function inColumn(el, elements) {
    if (!el.frameId) return false;
    const f = elements.find(e => e.id === el.frameId);
    return !!(f && isColumn(f));
  }
  function stackTargetFor(me, elements) {
    if (!me || me.type !== 'image' || me.locked || inColumn(me, elements)) return null;
    const cx = me.x + me.width / 2, cy = me.y + me.height / 2;
    const hits = elements.filter(e => !e.isDeleted && e.id !== me.id && !e.locked
      && (e.type === 'image' || (e.customData && e.customData.kind === 'board'))
      && cx >= e.x && cx <= e.x + e.width && cy >= e.y && cy <= e.y + e.height
      && !inColumn(e, elements));
    return hits.length ? hits[hits.length - 1] : null;   // the one on top
  }
  function overBack() {
    const b = backRef.current, p = R.current.ptr;
    if (!b || !p || !trail.length) return false;
    const r = b.getBoundingClientRect();
    return p.x >= r.left - 8 && p.x <= r.right + 8 && p.y >= r.top - 8 && p.y <= r.bottom + 8;
  }
  function watchStack(elements, appState, picked) {
    const st = R.current.stack || (R.current.stack = { target: null, armed: false, me: null, t: null });
    const dragging = appState.selectedElementsAreBeingDragged;
    // Held over the back arrow: it lights up, and letting go moves the
    // selection up to the board above.
    if (dragging) {
      const hot = overBack();
      if (hot !== !!R.current.backHot) { R.current.backHot = hot; setBackHot(hot); if (hot) { try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} } }
      if (hot) { R.current.backPicked = picked.map(e => e.id); if (st.target) { clearTimeout(st.t); st.target = null; st.armed = false; setStackOn(null); } return; }
    } else if (R.current.backHot) {
      R.current.backHot = false; setBackHot(false);
      const parent = trail[trail.length - 1];
      const ids = R.current.backPicked || [];
      const sel = elements.filter(e => ids.includes(e.id) && !e.isDeleted);
      if (parent && sel.length) moveTo(parent.id, sel, { title: parent.title, flyTo: backRect() });
      return;
    }
    if (dragging) {
      const me = picked.length === 1 ? picked[0] : null;
      const t = stackTargetFor(me, elements);
      if (!t || t.id !== st.target) {
        clearTimeout(st.t);
        st.target = t ? t.id : null; st.armed = false; st.me = me ? me.id : null;
        // A soft outline straight away, so you can see what you're over;
        // it firms up (and grows a touch) once you've held there a moment.
        setStackOn(t ? { id: t.id, armed: false } : null);
        if (t) st.t = setTimeout(() => {
          if (R.current.stack.target !== t.id) return;
          R.current.stack.armed = true; setStackOn({ id: t.id, armed: true });
          try { navigator.vibrate && navigator.vibrate(12); } catch (e) {}
        }, 300);
      }
      return;
    }
    if (st.target || st.armed) {
      const armed = st.armed, target = st.target, meId = st.me;
      clearTimeout(st.t); st.target = null; st.armed = false; st.me = null;
      setStackOn(null);
      if (!armed) return;
      const me = elements.find(e => e.id === meId && !e.isDeleted);
      const t = me && stackTargetFor(me, elements);
      if (t && t.id === target) stackInto(me, t);
    }
  }

  // The back arrow's spot, inside the canvas's own coordinates.
  function backRect() {
    const b = backRef.current, c = wrapRef.current && wrapRef.current.querySelector('.canvas');
    if (!b || !c) return null;
    const r = b.getBoundingClientRect(), cr = c.getBoundingClientRect();
    return { left: r.left - cr.left, top: r.top - cr.top, width: r.width, height: r.height };
  }
  // Where a scene rectangle sits on screen, inside the canvas.
  function rectOf(el, a = api) {
    const st = a.getAppState();
    const p = sceneCoordsToViewportCoords({ sceneX: el.x, sceneY: el.y }, st);
    const z = st.zoom.value;
    return { left: p.x - st.offsetLeft, top: p.y - st.offsetTop, width: el.width * z, height: el.height * z };
  }
  // The pictures fly into the card, so it's clear where they went.
  function flyInto(pics, card) { flyTo(pics, rectOf(card)); }
  function flyTo(pics, to) {
    const gs = pics.map((p, i) => ({ key: p.el.id + i, src: p.src, from: rectOf(p.el), to }));
    setGhosts({ items: gs, go: false });
    requestAnimationFrame(() => requestAnimationFrame(() => setGhosts(g => g && { ...g, go: true })));
    setTimeout(() => setGhosts(null), 520);
  }

  async function stackInto(me, target) {
    const a = api; if (!a) return;
    const files = a.getFiles();
    const fileOf = (el) => files[el.fileId] && { id: el.fileId, dataURL: files[el.fileId].dataURL, mimeType: files[el.fileId].mimeType, created: files[el.fileId].created };
    const picCopy = (el, x, y) => convertToExcalidrawElements([{ type: 'image', fileId: el.fileId, x, y, width: el.width, height: el.height, customData: el.customData }])[0];
    const setDeleted = (ids, deleted) => a.updateScene({
      elements: a.getSceneElementsIncludingDeleted().map(e => ids.includes(e.id) ? newElementWith(e, { isDeleted: deleted }) : e),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    if (target.type === 'image') {
      const f1 = fileOf(target), f2 = fileOf(me);
      if (!f1 || !f2) { setStatus('A picture is still loading; try again in a moment'); return; }
      // Everything you see happens at once; the saving follows behind it.
      const b = { id: uid('b'), title: 'Untitled board' };
      const card = boardCard(target.x, target.y, b);
      const thumbUrl = await collage([f1, f2]);
      setCardInfo(ci => ({ ...ci, [b.id]: { title: b.title, count: 2, thumb: thumbUrl } }));
      flyInto([{ el: target, src: f1.dataURL }, { el: me, src: f2.dataURL }], card[0]);
      setDeleted([me.id, target.id], true);
      addEls(card);
      const job = { cancelled: false, made: false };
      setNaming({ id: b.id, cardId: card[0].id, title: b.title, undo: () => {
        job.cancelled = true;
        setDeleted([me.id, target.id], false);
        setDeleted(card.map(c => c.id), true);
        if (job.made) store.trash(b.id).catch(() => {});
        save();
      } });
      try {
        const pics = [picCopy(target, 0, 0), picCopy(me, target.width + 24, 0)];
        await store.createBoard({ id: b.id, title: b.title, parent_id: boardId,
          scene: { elements: pics, appState: { viewBackgroundColor: a.getAppState().viewBackgroundColor } } });
        try {
          await store.saveFile(b.id, f1); if (f2.id !== f1.id) await store.saveFile(b.id, f2);
          if (thumbUrl) await store.saveThumb(b.id, dataURLToBlob(thumbUrl));
        } catch (e) { try { await store.trash(b.id); } catch (_) {} throw e; }
        job.made = true;
        // Undone while it was still saving: put the new board straight in Trash.
        if (job.cancelled) { await store.trash(b.id).catch(() => {}); return; }
        save();
      } catch (e) {
        setNaming(null);
        if (job.cancelled) return;
        setDeleted([me.id, target.id], false);
        setDeleted(card.map(c => c.id), true);
        setStatus('Couldn\'t make the board: ' + (e.message || e));
      }
      return;
    }
    // into a board that's already here
    moveTo(target.customData.boardId, [me], { flyTo: rectOf(target) });
  }

  // ── move things to another board ─────────────────────────────────────────
  // The selection (with any text inside shapes) is copied into the other
  // board with fresh ids, its pictures go with it, and it leaves this board.
  // Board cards move as boards (the board itself changes parent). Undo puts
  // everything back.
  function selectionNow() {
    const a = api; if (!a) return [];
    const ids = a.getAppState().selectedElementIds || {};
    return a.getSceneElements().filter(e => ids[e.id]);
  }
  async function moveTo(targetId, picked, opts = {}) {
    const a = api; if (!a || !targetId || targetId === boardId) return;
    // a board's own card can't go inside that board
    picked = picked.filter(e => !(e.customData && e.customData.kind === 'board' && e.customData.boardId === targetId));
    if (!picked.length) return;
    const all = a.getSceneElements();
    const set = new Set(picked.map(e => e.id));
    all.forEach(e => { if (e.containerId && set.has(e.containerId)) set.add(e.id); });
    const els = all.filter(e => set.has(e.id));
    const cards = els.filter(e => e.customData && e.customData.kind === 'board' && e.customData.boardId);
    const cardIds = new Set(cards.map(c => c.id));
    const items = els.filter(e => !cardIds.has(e.id) && !(e.containerId && cardIds.has(e.containerId)));
    const files = a.getFiles();
    const need = [...new Set(items.filter(e => e.type === 'image' && e.fileId).map(e => e.fileId))];
    if (need.some(id => !files[id])) { setStatus('A picture is still loading; try again in a moment'); return; }
    const title = opts.title || (cardInfo[targetId] && cardInfo[targetId].title) || (trail.find(t => t.id === targetId) || {}).title || 'the board';
    // what you see happens at once
    const pics = items.filter(e => e.type === 'image' && files[e.fileId]).slice(0, 6).map(e => ({ el: e, src: files[e.fileId].dataURL }));
    if (pics.length && opts.flyTo) flyTo(pics, opts.flyTo);
    const goneIds = els.map(e => e.id);
    const setDeleted = (ids, deleted) => a.updateScene({
      elements: a.getSceneElementsIncludingDeleted().map(e => ids.includes(e.id) ? newElementWith(e, { isDeleted: deleted }) : e),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setDeleted(goneIds, true);
    const n = picked.length;
    const job = { cloneIds: [], movedBoards: [] };
    setUndoStack({ text: 'Moved ' + (n === 1 ? '1 item' : n + ' items') + ' to ' + title, undo: async () => {
      setDeleted(goneIds, false); R.current.wantThumb = true; save();
      try {
        if (job.cloneIds.length) await editScene(targetId, list => list.map(e => job.cloneIds.includes(e.id) ? { ...e, isDeleted: true, version: (e.version || 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() } : e));
        for (const id of job.movedBoards) await store.moveInto(id, boardId, boardCard).catch(() => {});
      } catch (e) { setStatus('Couldn\'t undo it all: ' + (e.message || e)); }
    } });
    try {
      if (items.length) {
        for (const id of need) await store.saveFile(targetId, { id, dataURL: files[id].dataURL, mimeType: files[id].mimeType, created: files[id].created });
        const map = new Map(), gmap = new Map();
        const nid = (id) => { if (!map.has(id)) map.set(id, uid('e')); return map.get(id); };
        items.forEach(e => nid(e.id));
        const minX = Math.min(...items.map(e => e.x)), minY = Math.min(...items.map(e => e.y));
        await editScene(targetId, list => {
          const live = list.filter(e => !e.isDeleted);
          const x0 = live.length ? Math.max(...live.map(e => e.x + (e.width || 0))) + 48 : 0;
          const y0 = live.length ? Math.min(...live.map(e => e.y)) : 0;
          const copies = items.map(e => ({
            ...e, id: map.get(e.id), x: e.x - minX + x0, y: e.y - minY + y0,
            groupIds: (e.groupIds || []).map(g => { if (!gmap.has(g)) gmap.set(g, uid('g')); return gmap.get(g); }),
            containerId: e.containerId && map.has(e.containerId) ? map.get(e.containerId) : null,
            boundElements: e.boundElements ? e.boundElements.filter(b => map.has(b.id)).map(b => ({ ...b, id: map.get(b.id) })) : null,
            frameId: e.frameId && map.has(e.frameId) ? map.get(e.frameId) : null,
            startBinding: e.startBinding && map.has(e.startBinding.elementId) ? { ...e.startBinding, elementId: map.get(e.startBinding.elementId) } : null,
            endBinding: e.endBinding && map.has(e.endBinding.elementId) ? { ...e.endBinding, elementId: map.get(e.endBinding.elementId) } : null,
            version: 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now(), isDeleted: false,
          }));
          job.cloneIds = copies.map(c => c.id);
          return [...list, ...copies];
        });
      }
      for (const c of cards) {
        const id = c.customData.boardId;
        if (id === targetId) continue;
        await store.moveInto(id, targetId, boardCard);
        job.movedBoards.push(id);
        setKids(k => k.filter(b => b.id !== id));
      }
      setCardInfo(ci => ({ ...ci, [targetId]: { ...(ci[targetId] || {}), count: ((ci[targetId] && ci[targetId].count) || 0) + items.filter(e => !e.containerId).length + job.movedBoards.length } }));
      R.current.wantThumb = true; // this board's preview should show what's left
      save();
    } catch (e) {
      setDeleted(goneIds, false);
      setUndoStack(null);
      setStatus('Couldn\'t move it: ' + (e.message || e));
    }
  }
  // Change another board's scene safely (it may be open somewhere else).
  async function editScene(id, fn) {
    for (let i = 0; i < 3; i++) {
      const row = await store.loadBoard(id);
      if (!row || row.trashed_at) throw new Error('that board isn\'t here any more');
      const scene = row.scene || { elements: [], appState: {} };
      const next = fn(scene.elements || []);
      const count = next.filter(e => !e.isDeleted && !e.containerId).length;
      const res = await store.saveScene(id, { ...scene, elements: next }, row.rev || 0, { item_count: count });
      if (!res.conflict) return;
    }
    throw new Error('someone else is editing that board; try again');
  }
  useEffect(() => { if (!undoStack) return; const t = setTimeout(() => setUndoStack(null), 6000); return () => clearTimeout(t); }, [undoStack]);

  // A small square collage of up to four pictures, for a board card.
  async function collage(fs) {
    try {
      const S = 360, imgs = await Promise.all(fs.slice(0, 4).map(f => new Promise((res) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = f.dataURL; })));
      const ok = imgs.filter(Boolean); if (!ok.length) return null;
      const c = document.createElement('canvas'); c.width = S; c.height = Math.round(S * 0.625);
      const g = c.getContext('2d'); g.fillStyle = '#efede8'; g.fillRect(0, 0, c.width, c.height);
      const cells = ok.length === 1 ? [[0, 0, c.width, c.height]]
        : ok.length === 2 ? [[0, 0, c.width / 2 - 1, c.height], [c.width / 2 + 1, 0, c.width / 2 - 1, c.height]]
        : ok.length === 3 ? [[0, 0, c.width / 2 - 1, c.height], [c.width / 2 + 1, 0, c.width / 2 - 1, c.height / 2 - 1], [c.width / 2 + 1, c.height / 2 + 1, c.width / 2 - 1, c.height / 2 - 1]]
        : [[0, 0, c.width / 2 - 1, c.height / 2 - 1], [c.width / 2 + 1, 0, c.width / 2 - 1, c.height / 2 - 1], [0, c.height / 2 + 1, c.width / 2 - 1, c.height / 2 - 1], [c.width / 2 + 1, c.height / 2 + 1, c.width / 2 - 1, c.height / 2 - 1]];
      ok.forEach((im, k) => {
        const [x, y, w, h] = cells[k];
        const r = Math.max(w / im.width, h / im.height);
        const sw = w / r, sh = h / r;
        g.drawImage(im, (im.width - sw) / 2, (im.height - sh) / 2, sw, sh, x, y, w, h);
      });
      return c.toDataURL('image/jpeg', 0.85);
    } catch (e) { return null; }
  }

  async function nameBoard(n, title) {
    title = String(title || '').trim() || 'Untitled board';
    setNaming(null);
    setCardInfo(ci => ({ ...ci, [n.id]: { ...(ci[n.id] || {}), title } }));
    // the card's own label, for anyone without the picture preview
    const a = api;
    if (a) a.updateScene({
      elements: a.getSceneElementsIncludingDeleted().map(e => e.containerId === n.cardId && e.type === 'text'
        ? newElementWith(e, { text: '▦  ' + title, originalText: '▦  ' + title }) : e),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    try { await store.rename(n.id, title); } catch (e) { setStatus('Couldn\'t rename it: ' + (e.message || e)); }
    save();
  }

  // ── board cards: a picture of what's inside, a name and a count ─────────
  const loadCardInfo = useCallback(async (ids) => {
    if (!ids.length) return;
    try {
      const [list, thumbs] = await Promise.all([store.listBoards(), store.thumbs(ids)]);
      const by = Object.fromEntries(list.map(b => [b.id, b]));
      setCardInfo(ci => {
        const next = { ...ci };
        ids.forEach(id => {
          const b = by[id];
          next[id] = { ...(ci[id] || {}), title: b ? b.title : (ci[id] && ci[id].title), count: b ? b.item_count : (ci[id] && ci[id].count),
            // an emptied board keeps its last picture on file; show the plain card instead
            thumb: (b && b.item_count === 0) ? null : (thumbs[id] || (ci[id] && ci[id].thumb) || null), gone: !b && !(ci[id] && ci[id].title) };
        });
        return next;
      });
      setTimeout(() => freshenPreviews(ids.filter(id => by[id] && by[id].item_count > 0), by), 2500);
    } catch (e) {}
  }, []);

  // A board card shows a picture of what's on that board, scaled to fill the
  // card. The picture is redrawn here whenever that board has changed since
  // this device last drew it, so it never lags behind what's inside.
  async function freshenPreviews(ids, by) {
    for (const id of ids.slice(0, 16)) {
      try {
        const at = await store.thumbAt(id);
        const changed = Date.parse(by[id].updated_at) || 0;
        if (at && at >= changed) continue;
        const row = await store.loadBoard(id);
        const all = (row && row.scene && row.scene.elements) || [];
        const live = all.filter(e => e && !e.isDeleted);
        if (!live.length) continue;
        // boards inside it show as light cards, the way they look in the app
        const cardIds = new Set(live.filter(e => e.customData && e.customData.kind === 'board').map(e => e.id));
        const els = live.map(e => cardIds.has(e.id) ? { ...e, backgroundColor: '#efede8', fillStyle: 'solid', strokeColor: '#161616' }
          : (e.containerId && cardIds.has(e.containerId)) ? { ...e, strokeColor: '#161616' } : e);
        const need = [...new Set(els.filter(e => e.type === 'image' && e.fileId).map(e => e.fileId))];
        const files = need.length ? Object.fromEntries((await store.loadFiles(id, need)).map(f => [f.id, f])) : {};
        const blob = await exportToBlob({ elements: els, files, mimeType: 'image/png', maxWidthOrHeight: 720, exportPadding: 16,
          appState: { exportBackground: true, viewBackgroundColor: (row.scene.appState && row.scene.appState.viewBackgroundColor) || '#f7f5f1' } });
        const url = URL.createObjectURL(blob);
        setCardInfo(ci => ({ ...ci, [id]: { ...(ci[id] || {}), thumb: url } }));
        if (store.canEdit) await store.saveThumb(id, blob);
      } catch (e) { /* one board's picture never blocks the others */ }
    }
  }
  function openCard(id) { if (!id) return; save(); go('/b/' + id); }

  // ── columns keep themselves stacked ──────────────────────────────────────
  const tidyColumns = useCallback(() => {
    const a = api; if (!a) return;
    const next = restack(a.getSceneElementsIncludingDeleted());
    if (next) a.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.EVENTUALLY });
  }, [api]);

  const onChange = useCallback((elements, appState) => {
    const ids = Object.keys(appState.selectedElementIds || {}).filter(k => appState.selectedElementIds[k]);
    const picked = elements.filter(e => ids.includes(e.id) && !e.isDeleted);
    if (store.canEdit) watchStack(elements, appState, picked);
    const cardIds = elements.filter(e => !e.isDeleted && e.customData && e.customData.kind === 'board' && e.customData.boardId).map(e => e.customData.boardId);
    const ck = cardIds.join(',');
    if (ck !== R.current.cardKey) { R.current.cardKey = ck; const fresh = cardIds.filter(id => !R.current.cardSeen || !R.current.cardSeen.has(id));
      R.current.cardSeen = new Set(cardIds); if (fresh.length) loadCardInfo(fresh); }
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

  // ── pictures not on this device yet: fetch, then show each as it lands ──
  useEffect(() => {
    if (!api || !R.current.lateFiles) return;
    const ids = R.current.lateFiles; R.current.lateFiles = null;
    let dead = false;
    ids.forEach(id => {
      store.loadFiles(boardId, [id]).then(fs => {
        if (dead || !fs.length) return;
        fs.forEach(f => R.current.uploaded.add(f.id));
        api.addFiles(fs);
      }).catch(() => {});
    });
    return () => { dead = true; };
  }, [api, boardId]);

  // ── the old Brainstorm Board: photos, and cards pinned since ────────────
  useEffect(() => {
    if (!api || boardId !== LEGACY_ID || !store.canEdit) return;
    (async () => {
      const cards = await store.legacyBoardCards().catch(() => []);
      // Count ones you've since deleted or moved away too: they were brought
      // across once already, and must not come back each time the board opens.
      const have = new Set(api.getSceneElementsIncludingDeleted().map(e => e.customData && e.customData.legacyId).filter(Boolean));
      // an old note with nothing written on it carries nothing worth bringing
      const fresh = cards.filter(c => !have.has(c.id) && !(c.kind !== 'img' && c.kind !== 'goal' && !String(c.text || '').trim()));
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
    setTools(false);   // on a phone, the Add sheet steps aside once something lands
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

  // A board inside this one whose card was removed from the canvas still
  // exists (removing a card never trashes the board). Offer it back.
  const shownKids = new Set((api ? api.getSceneElements() : []).filter(e => e.customData && e.customData.kind === 'board').map(e => e.customData.boardId));
  const hiddenKids = kids.filter(b => !shownKids.has(b.id));
  function showKids() {
    const els = [];
    hiddenKids.forEach((b, i) => { const p = spotFor(240, 150); els.push(...boardCard(p.x + i * 264, p.y, b)); });
    if (els.length) addEls(els);
  }

  function placeBoardCard(b) {
    const p = spotFor(240, 150);
    addEls(boardCard(p.x, p.y, b));
    setPanel(null);
  }

  // drop several photos at once, where they're dropped
  useEffect(() => {
    const el = wrapRef.current; if (!el || !api || !store.canEdit) return;
    const carries = (dt) => !!dt && [...(dt.types || [])].some(t => t === 'Files' || t === 'text/uri-list' || t === 'text/html');
    const onDrop = (e) => {
      setDropping(false);
      const dt = e.dataTransfer; if (!dt) return;
      let files = [...(dt.files || [])].filter(f => /^image\//.test(f.type));
      // some phones hand pictures over as items rather than files
      if (!files.length && dt.items) files = [...dt.items].filter(i => i.kind === 'file' && /^image\//.test(i.type)).map(i => i.getAsFile()).filter(Boolean);
      const at = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, api.getAppState());
      if (files.length) { e.preventDefault(); e.stopPropagation(); addImages(files, at); return; }
      // a picture or page dragged from another tab or app
      const html = dt.getData('text/html') || '';
      const src = (html.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1];
      const url = src && /^https?:/i.test(src) ? src : (dt.getData('text/uri-list') || '').split(/\r?\n/).find(l => /^https?:/i.test(l)) || '';
      if (url) { e.preventDefault(); e.stopPropagation(); addFromLink(url); }
    };
    const onOver = (e) => { if (carries(e.dataTransfer)) { e.preventDefault(); if (!R.current.dropOn) { R.current.dropOn = true; setDropping(true); } } };
    const onLeave = (e) => { if (!e.relatedTarget || !el.contains(e.relatedTarget)) { R.current.dropOn = false; setDropping(false); } };
    const onEnd = () => { R.current.dropOn = false; setDropping(false); };
    el.addEventListener('drop', onDrop, true);
    el.addEventListener('dragover', onOver, true);
    el.addEventListener('dragleave', onLeave, true);
    window.addEventListener('dragend', onEnd);
    window.addEventListener('drop', onEnd);
    return () => {
      el.removeEventListener('drop', onDrop, true); el.removeEventListener('dragover', onOver, true);
      el.removeEventListener('dragleave', onLeave, true); window.removeEventListener('dragend', onEnd); window.removeEventListener('drop', onEnd);
    };
  }, [api]);

  // Paste a copied picture straight onto the board, like Milanote. Pictures go
  // through the same path as Photos (shrunk, saved, uploaded); text and links
  // are left to the usual paste handling below.
  useEffect(() => {
    if (!api || !store.canEdit) return;
    const onPasteEvt = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (api.getAppState().editingTextElement) return;
      const cd = e.clipboardData; if (!cd) return;
      let files = [...(cd.files || [])].filter(f => /^image\//.test(f.type));
      if (!files.length && cd.items) files = [...cd.items].filter(i => i.kind === 'file' && /^image\//.test(i.type)).map(i => i.getAsFile()).filter(Boolean);
      if (!files.length) return;
      e.preventDefault(); e.stopImmediatePropagation();
      addImages(files);
    };
    window.addEventListener('paste', onPasteEvt, true);
    return () => window.removeEventListener('paste', onPasteEvt, true);
  }, [api]);

  // The Paste button (phones have no keyboard shortcut; the browser asks
  // once, with its own Paste bubble, before it hands the clipboard over).
  async function pasteButton() {
    setTools(false);
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        const blobs = [];
        let text = '';
        for (const it of items) {
          const img = it.types.find(t => /^image\//.test(t));
          if (img) blobs.push(await it.getType(img));
          else if (!text && it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
        }
        if (blobs.length) return addImages(blobs);
        if (text) return pasteText(text);
      } else if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) return pasteText(text);
      }
      setStatus('Nothing to paste: copy a picture or a link first');
    } catch (e) {
      setStatus(/denied|allow|permission/i.test(String(e && e.message)) ? 'Allow pasting when your browser asks, then try again' : 'Nothing to paste: copy a picture or a link first');
    }
  }
  function pasteText(text) {
    text = String(text).trim(); if (!text) return;
    if (isWebUrl(text) || looksLikeImageUrl(text)) return addFromLink(text);
    const p = spotFor(260, 160);
    addEls(note(p.x, p.y, text.slice(0, 2000), NOTE_COLOURS[0].hex));
  }

  useEffect(() => {
    const mv = (e) => { R.current.ptr = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('pointermove', mv, true);
    return () => window.removeEventListener('pointermove', mv, true);
  }, []);

  // Double tap (or double click) a board card to open it.
  useEffect(() => {
    const el = wrapRef.current; if (!el || !api) return;
    const cardAt = (e) => {
      const p = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, api.getAppState());
      const hits = api.getSceneElements().filter(x => x.customData && x.customData.kind === 'board'
        && p.x >= x.x && p.x <= x.x + x.width && p.y >= x.y && p.y <= x.y + x.height);
      return hits.length ? hits[hits.length - 1] : null;
    };
    const down = (e) => {
      if (e.button > 0 || !e.target || !e.target.closest('.excalidraw canvas, .bcard')) return;
      const c = cardAt(e);
      const last = R.current.lastTap;
      const now = Date.now();
      if (c && last && last.id === c.id && now - last.t < 380 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) {
        R.current.lastTap = null;
        e.preventDefault(); e.stopPropagation();
        openCard(c.customData.boardId);
        return;
      }
      R.current.lastTap = c ? { id: c.id, t: now, x: e.clientX, y: e.clientY } : null;
    };
    const dbl = (e) => { const c = cardAt(e); if (c) { e.preventDefault(); e.stopPropagation(); } };
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('dblclick', dbl, true);
    return () => { el.removeEventListener('pointerdown', down, true); el.removeEventListener('dblclick', dbl, true); };
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
      // a to-do list opens out: zoom in until it fills the screen
      else if (api) { try { api.scrollToContent([element], { fitToViewport: true, viewportZoomFactor: 0.8, animate: true }); } catch (e) {} }
      return;
    }
    const m = cd.boardId || (link.match(/\/boards#\/b\/([\w-]+)/) || [])[1];
    if (m) { event.preventDefault(); save(); go('/b/' + m); }
  }, [save, api]);

  async function rename(t) {
    t = t.trim(); if (!t || !meta || t === meta.title) return;
    setMeta(m => ({ ...m, title: t }));
    await store.rename(boardId, t);
    document.title = t + ' · Boards'; tellHost('boards:title', { title: t });
  }

  const renderCard = React.useMemo(() => makeRenderCard(() => api, store.canEdit), [api]);

  if (missing) return <div className="empty">This board isn't here any more. <button className="link" onClick={() => go('/')}>Back to Boards</button></div>;

  return (
    <div className={'board' + (drawing ? ' drawing' : '')} ref={wrapRef}>
      <header className={'bar' + (tools ? ' tools-open' : '')}>
        <nav className="crumbs">
          <button ref={backRef} className={'back' + (backHot ? ' hot' : '')} onClick={() => { save(); go(trail.length ? '/b/' + trail[trail.length - 1].id : '/'); }}
            aria-label={'Back to ' + (trail.length ? trail[trail.length - 1].title : 'all boards')}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
            <span>{trail.length ? trail[trail.length - 1].title : 'Boards'}</span>
          </button>
          {!inHost && <a className="back-os" href="/">VENIA <span>OS</span></a>}
          <button className="crumb" onClick={() => { save(); go('/'); }}>Boards</button>
          {trail.map(b => <React.Fragment key={b.id}><span className="sep">/</span><button className="crumb" onClick={() => { save(); go('/b/' + b.id); }}>{b.title}</button></React.Fragment>)}
          <span className="sep">/</span>
          {meta && <input className="title" defaultValue={meta.title} readOnly={!store.canEdit} key={meta.id} onBlur={e => rename(e.target.value)} onKeyDown={e => e.key === 'Enter' && e.target.blur()} />}
        </nav>
        {store.canEdit && api && (
          <div className="actions edit-actions" onClick={e => { if (e.target.closest('.act.closes')) setTools(false); }}>
            <div className="pop-wrap">
              <button className="act" onClick={() => setPanel(panel === 'note' ? null : 'note')} title="Add a note (N)"><Ico d="M5 4h14v11l-5 5H5z M14 20v-5h5" />Note</button>
              {panel === 'note' && <div className="pop swatches">{NOTE_COLOURS.map(c => <button key={c.hex} title={c.name} style={{ background: c.hex }} onClick={() => addNote(c.hex)} />)}</div>}
            </div>
            <button className="act closes" onClick={() => fileInput.current.click()} title="Add photos"><Ico d="M4 6h16v12H4z M4 15l4-4 4 4 3-3 5 5" />Photos</button>
            <button className="act" onClick={pasteButton} title="Paste a copied picture or link (or press Ctrl/⌘ V)"><Ico d="M9 4h6v3H9z M7 5H5v16h14V5h-2 M9 12h6 M9 16h4" />Paste</button>
            <div className="pop-wrap">
              <button className="act" onClick={() => setPanel(panel === 'link' ? null : 'link')} title="Add an image or page from a link"><Ico d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />Link</button>
              {panel === 'link' && <LinkPop onAdd={addFromLink} />}
            </div>
            <div className="pop-wrap">
              <button className="act" onClick={() => setPanel(panel === 'board' ? null : 'board')} title="A board inside this board"><Ico d="M4 4h16v16H4z M8 8h8v8H8z" />Board</button>
              {panel === 'board' && <BoardPop currentId={boardId} onPick={placeBoardCard} onNew={() => setPanel('newboard')} />}
            </div>
            <button className="act closes" onClick={addTodo} title="A checklist"><Ico d="M4 6l2 2 3-3 M4 13l2 2 3-3 M12 7h8 M12 14h8 M12 20h8 M4 20h2" />To-do</button>
            <button className="act closes" onClick={addColumn} title="A column that keeps what you drop in it stacked (wraps the selection)"><Ico d="M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h6" />Column</button>
            <span className="divider" />
            <button className="act closes" disabled={sel.count < 1} onClick={() => setMoving(true)} title="Move what's selected to another board"><Ico d="M4 7h7l2 2h7v10H4z M12 14h6 M15 11l3 3-3 3" />Move</button>
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
            <button className="act closes" disabled={sel.count < 1} onClick={doFrame} title="Group the selection in a named frame"><Ico d="M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4" />Group</button>
            <button className={'act closes phone-draw' + (drawing ? ' on' : '')} onClick={() => setDrawing(d => !d)} title="Show the drawing tools"><Ico d="M4.6 19.4v-3.5L15.5 5a2 2 0 0 1 2.83 2.83L7.4 19.4H4.6Z M13.9 6.6l3.5 3.5" />{drawing ? 'Hide tools' : 'Draw'}</button>
            <button className="act closes" disabled={!sel.oneImage} onClick={doPalette} title="Pull a colour palette from the selected image"><Ico d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.6 0-1.3-1-1.4-1-2.6 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z M7.5 11.5h.01 M10 7.5h.01 M14.5 7.5h.01" />Palette</button>
          </div>
        )}
        {store.canEdit && api && (
          <div className="actions phone-only">
            {sel.count > 0 && <button className="act" onClick={() => { setTools(false); setMoving(true); }} aria-label="Move to another board"><Ico d="M4 7h7l2 2h7v10H4z M12 14h6 M15 11l3 3-3 3" /></button>}
            <button className="act" onClick={() => { setTools(false); fileInput.current.click(); }} aria-label="Add photos"><Ico d="M4 6h16v12H4z M4 15l4-4 4 4 3-3 5 5" /></button>
            <button className={'act' + (tools ? ' on' : '')} onClick={() => { setTools(t => !t); setPanel(null); }} aria-label={tools ? 'Close' : 'Add to the board'} aria-expanded={tools}>
              <Ico d={tools ? 'M6 6l12 12 M18 6L6 18' : 'M12 5v14 M5 12h14'} />
            </button>
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
        {!initial && !missing && <div className="board-loading">Opening…</div>}
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
                  <p>Drop photos anywhere, or paste an image or a link. Hold one picture over another to make a board.</p>
                  <p>Press N for a note. Draw, write and connect with the tools above.</p>
                  <p>Select a few things, then Arrange, Group or put them in a Column.</p>
                  <p>Click Comment to leave a note for someone. Type @ to mention them.</p>
                </div>
              </WelcomeScreen.Center>
            </WelcomeScreen>
          </Excalidraw>
        )}
        {dropping && <div className="drop-hint"><span>Drop to add to this board</span></div>}
        {api && <div className="bcards">{api.getSceneElements().filter(e => e.customData && e.customData.kind === 'board' && e.customData.boardId).map(e => {
          const r = rectOf(e); const info = cardInfo[e.customData.boardId] || {};
          if (r.width < 24 || r.height < 16) return null;
          const held = stackOn && stackOn.id === e.id;
          return <div key={e.id} className={'bcard' + (held ? (stackOn.armed ? ' armed' : ' near') : '')} style={{ left: r.left, top: r.top, width: r.width, height: r.height }}>
            <div className="bcard-img" style={info.thumb ? { backgroundImage: 'url("' + info.thumb.replace(/"/g, '%22') + '")' } : null}>{!info.thumb && <span>▦</span>}</div>
            <div className="bcard-foot"><b>{info.title || (e.customData && e.customData.title) || 'Board'}</b>{info.count != null && <small>{info.count} {info.count === 1 ? 'item' : 'items'}</small>}</div>
            {held && <div className="bcard-drop">{stackOn.armed ? 'Let go to put it in' : ''}</div>}
          </div>;
        })}</div>}
        {stackOn && api && (() => {
          const t = api.getSceneElements().find(e => e.id === stackOn.id);
          if (!t || (t.customData && t.customData.kind === 'board')) return null;
          const r = rectOf(t);
          return <div className={'stack-hint' + (stackOn.armed ? ' armed' : '')} style={{ left: r.left, top: r.top, width: r.width, height: r.height }}>
            {stackOn.armed && <span>Let go to make a board</span>}</div>;
        })()}
        {backHot && trail.length > 0 && <div className="back-hint"><span>Let go to move up to {trail[trail.length - 1].title}</span></div>}
        {ghosts && <div className="ghosts">{ghosts.items.map(g => {
          const r = ghosts.go ? { left: g.to.left + g.to.width * 0.2, top: g.to.top + g.to.height * 0.15, width: g.to.width * 0.6, height: g.to.height * 0.6 } : g.from;
          return <img key={g.key} alt="" src={g.src} style={{ left: r.left, top: r.top, width: r.width, height: r.height, opacity: ghosts.go ? 0 : 1 }} />;
        })}</div>}
        {naming && (
          <div className="name-bar">
            <span className="name-bar-k">New board</span>
            <input autoFocus defaultValue="" placeholder="Name it" maxLength={120}
              onKeyDown={e => { if (e.key === 'Enter') nameBoard(naming, e.target.value); if (e.key === 'Escape') setNaming(null); }} id="name-bar-input" />
            <button className="solid sm" onClick={() => nameBoard(naming, document.getElementById('name-bar-input').value)}>Done</button>
            <button className="link quiet" onClick={() => { const u = naming.undo; setNaming(null); u(); }}>Undo</button>
          </div>
        )}
        {hiddenKids.length > 0 && !undoStack && <div className="toast kids-toast">
          {hiddenKids.length === 1 ? '“' + (hiddenKids[0].title || 'Untitled board') + '” is inside this board but its card isn’t showing' : hiddenKids.length + ' boards inside this one aren’t showing'}
          <button onClick={showKids}>Show {hiddenKids.length === 1 ? 'it' : 'them'}</button></div>}
        {undoStack && <div className="toast">{undoStack.text}{undoStack.undo && <button onClick={() => { const u = undoStack.undo; setUndoStack(null); u(); }}>Undo</button>}</div>}
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
      {moving && <MovePicker currentId={boardId} parent={trail[trail.length - 1] || null}
        children={(api ? api.getSceneElements() : []).filter(e => e.customData && e.customData.kind === 'board' && e.customData.boardId).map(e => ({ id: e.customData.boardId, title: (cardInfo[e.customData.boardId] || {}).title || e.customData.title || 'Board' }))}
        count={sel.count} onClose={() => setMoving(false)}
        onPick={(b) => { setMoving(false); moveTo(b.id, selectionNow(), { title: b.title, flyTo: trail.length && b.id === trail[trail.length - 1].id ? backRect() : null }); }} />}
      {panel === 'newboard' && <NewBoard parentId={boardId} onClose={() => setPanel(null)} onCreated={placeBoardCard} />}
    </div>
  );
}

function MovePicker({ currentId, parent, children, count, onClose, onPick }) {
  const [all, setAll] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => { store.listBoards().then(setAll).catch(() => setAll([])); }, []);
  const kids = children.filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i);
  const skip = new Set([currentId, ...(parent ? [parent.id] : []), ...kids.map(k => k.id)]);
  const rest = (all || []).filter(b => !skip.has(b.id) && (!q || String(b.title || '').toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal move-modal" onClick={e => e.stopPropagation()}>
        <h2>Move {count === 1 ? '1 item' : count + ' items'} to…</h2>
        <div className="pick-list">
          {parent && <button className="up" onClick={() => onPick(parent)}><span>↑ {parent.title}</span><small>the board above this one</small></button>}
          {kids.map(k => <button key={k.id} onClick={() => onPick(k)}><span>{k.title}</span><small>on this board</small></button>)}
          {(all || []).length > 8 && <input className="move-search" placeholder="Find a board" value={q} onChange={e => setQ(e.target.value)} />}
          {all === null ? <div className="side-empty">Loading boards…</div>
            : rest.map(b => <button key={b.id} onClick={() => onPick(b)}><span>{b.title}</span><small>{b.item_count != null ? b.item_count + ' items' : ''}</small></button>)}
        </div>
        <div className="modal-foot"><button className="link" onClick={onClose}>Cancel</button></div>
      </div>
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
