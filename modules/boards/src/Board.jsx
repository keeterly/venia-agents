import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import {
  Excalidraw, MainMenu, WelcomeScreen, CaptureUpdateAction,
  convertToExcalidrawElements, restoreElements, reconcileElements, getSceneVersion,
  exportToBlob, viewportCoordsToSceneCoords, sceneCoordsToViewportCoords, newElementWith, FONT_FAMILY,
} from '@excalidraw/excalidraw';
import { store, uid, dataURLToBlob } from './store.js';
import { inHost, tellHost } from './host.js';
import { go, NewBoard, LEGACY_ID } from './App.jsx';
import { NOTE_COLOURS, note, boardCard, paletteRow, frameAround, legacyCardElements, countItems, loadLibrary, saveLibrary } from './elements.js';
import { arrange, selectionUnits } from './layout.js';
import { prepareImage, fetchImage, looksLikeImageUrl, extractPalette, readableOn } from './images.js';
import { todoCard, linkCard, cardWords, isCardUrl, makeRenderCard, hostOf, isRich, richFrom, RICH_EDIT, RICH_EDITING } from './cards.jsx';
import { parasFromText, allHave, setAll } from './rich.js';
import { flattenCards } from './export.js';
import { newColumn, isColumn, restack } from './columns.js';
import { useLive } from './live.js';
import { CommentsLayer, CommentsPanel, threadsOf, spotOf, focusSpot } from './comments.jsx';
import { nameOf } from './store.js';
import { FindPanel } from './find.jsx';
import { NameBox } from './namebox.jsx';
import { pendingKey, styleCaption, groupName } from './importer.jsx';

const BG = '#F7F6F2';

// A board card's picture. Boards inside it show as light cards, the way they
// look in the app. Used for every card picture so they all look the same.
async function previewBlob(all, files, bg) {
  const live = all.filter(e => e && !e.isDeleted);
  if (!live.length) return null;
  const cardIds = new Set(live.filter(e => e.customData && e.customData.kind === 'board').map(e => e.id));
  const els = live.map(e => cardIds.has(e.id) ? { ...e, backgroundColor: '#efede8', fillStyle: 'solid', strokeColor: '#161616' }
    : (e.containerId && cardIds.has(e.containerId)) ? { ...e, strokeColor: '#161616' } : e);
  const flat = flattenCards(els, files, 1.5);
  return exportToBlob({ elements: flat.elements, files: flat.files, mimeType: 'image/png', maxWidthOrHeight: 720, exportPadding: 16,
    appState: { exportBackground: true, viewBackgroundColor: bg || BG } });
}
// The whole board as one page, through the browser's print dialog, where
// "Save as PDF" makes a file to send. No new service or library: it prints a
// picture of the board in a hidden frame, sized to fit the page.
async function printBoard(api, title) {
  const live = api.getSceneElements().filter(e => e && !e.isDeleted);
  if (!live.length) return;
  const flat = flattenCards(live, api.getFiles(), 3);
  const blob = await exportToBlob({ elements: flat.elements, files: flat.files, mimeType: 'image/png', exportPadding: 48,
    getDimensions: (w, h) => { const k = Math.min(3, 3200 / Math.max(w, h)); return { width: w * k, height: h * k, scale: k }; },
    appState: { exportBackground: true, viewBackgroundColor: api.getAppState().viewBackgroundColor || BG } });
  const url = URL.createObjectURL(blob);
  const f = document.createElement('iframe');
  f.setAttribute('aria-hidden', 'true');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(f);
  const d = f.contentDocument;
  const safe = String(title || 'Board').replace(/[<>&]/g, '');
  d.open();
  d.write('<!doctype html><html><head><title>' + safe + '</title><style>@page{margin:12mm}html,body{margin:0;height:100%}body{display:flex;flex-direction:column;align-items:center;justify-content:center;font:12px Helvetica,Arial,sans-serif}h1{font-size:14px;font-weight:500;letter-spacing:2px;text-transform:uppercase;margin:0 0 10px;align-self:flex-start}img{max-width:100%;max-height:calc(100vh - 40px);object-fit:contain}</style></head><body><h1>' + safe + '</h1><img></body></html>');
  d.close();
  const img = d.querySelector('img');
  img.onload = () => { setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) {} setTimeout(() => { f.remove(); URL.revokeObjectURL(url); }, 60000); }, 50); };
  img.src = url;
}
// Save as image: a PNG of the whole board, styled notes and lists included.
async function saveImage(api, title) {
  const live = api.getSceneElements().filter(e => e && !e.isDeleted);
  if (!live.length) return;
  const flat = flattenCards(live, api.getFiles(), 2);
  const blob = await exportToBlob({ elements: flat.elements, files: flat.files, mimeType: 'image/png', exportPadding: 32,
    getDimensions: (w, h) => { const k = Math.min(2, 6000 / Math.max(w, h)); return { width: w * k, height: h * k, scale: k }; },
    appState: { exportBackground: true, viewBackgroundColor: api.getAppState().viewBackgroundColor || BG } });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = (String(title || 'Board').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Board') + '.png';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// The board you leave draws its own new card picture from what was on screen,
// so the card you go back to can show it the moment it is ready instead of
// waiting for the save to land and drawing it again.
const leaving = new Map();
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

export default function Board({ boardId, commentId, find }) {
  const [initial, setInitial] = useState(null);
  const [meta, setMeta] = useState(null);
  const [trail, setTrail] = useState([]);
  const [kids, setKids] = useState([]);   // boards whose parent is this one
  const [status, setStatus] = useState('');
  const [api, setApi] = useState(null);
  const [sel, setSel] = useState({ count: 0, oneImage: null, busy: false, notes: false });
  const [panel, setPanel] = useState(null);       // 'note' | 'arrange' | 'board' | 'link'
  const [tools, setTools] = useState(false);       // phone: the Add sheet is open
  const [dropping, setDropping] = useState(false); // something is being dragged over the board
  const [stackOn, setStackOn] = useState(null);    // { id, armed }: what a picture is held over
  const [asking, setAsking] = useState(null);       // { title, initial, done } for the name box
  const askName = (title, initial) => new Promise(done => setAsking({ title, initial, done }));
  const [finding, setFinding] = useState(false);   // the Find panel
  const [undoStack, setUndoStack] = useState(null);// { text, undo } after a stack
  const [ghosts, setGhosts] = useState(null);      // pictures flying into a new board card
  const [cardInfo, setCardInfo] = useState({});    // board id -> { title, count, thumb }
  const [naming, setNaming] = useState(null);      // a board just made: name it, or undo
  const [drawing, setDrawing] = useState(false);   // the drawing tools are showing (hidden until you ask)
  const [backHot, setBackHot] = useState(false);   // something is held over the back arrow
  const [moving, setMoving] = useState(false);     // the Move to… list is open
  const [fmt, setFmt] = useState(null);            // a note open for typing: { id, mode: 'plain' | 'rich' }
  const [fmtOn, setFmtOn] = useState({});          // which styles the cursor is in (styled notes)
  const backRef = useRef(null);
  const doDeleteRef = useRef(() => {});
  const copyCardsRef = useRef(() => {});
  const selbarRef = useRef(null);
  // keep the selection bar whole on screen, however near the edge the selection is
  useLayoutEffect(() => {
    const b = selbarRef.current; if (!b || !b.parentElement) return;
    const W = b.parentElement.clientWidth, w = b.offsetWidth, c = parseFloat(b.style.left) || 0;
    const fixed = Math.max(w / 2 + 8, Math.min(c, W - w / 2 - 8));
    if (Math.abs(fixed - c) > 0.5) b.style.left = fixed + 'px';
  });
  const [busy, setBusy] = useState('');
  const [missing, setMissing] = useState(false);
  const [rows, setRows] = useState([]);           // comments, flat
  const [adding, setAdding] = useState(false);    // placing a new comment
  const [openId, setOpenId] = useState(null);     // the open thread
  const [showResolved, setShowResolved] = useState(false);
  const [people, setPeople] = useState([]);
  const [view, setView] = useState(0);            // bumps when the canvas moves, to move the pins
  // Every board card this canvas already knows about: what it opened with,
  // what we placed ourselves, what arrived from someone else. A card that
  // turns up without being any of those was pasted or duplicated.
  const knownCards = useRef(new Set());
  const noteCards = (els) => { (els || []).forEach(e => { if (e && e.customData && e.customData.kind === 'board') knownCards.current.add(e.id); }); };
  const R = useRef({ rev: 0, savedVersion: -1, timer: null, saving: false, again: false, uploaded: new Set(), uploading: new Set(), thumbAt: 0, thumbVersion: -1, bg: BG, binned: new Map() });
  // The drawing tools show only while you ask for them. Hiding them puts you
  // back to selecting, so no drawing tool is left switched on out of sight.
  useEffect(() => {
    R.current.drawingOn = drawing;
    if (!drawing && api) { try { const t = api.getAppState().activeTool; if (t && !['selection', 'hand'].includes(t.type)) api.setActiveTool({ type: 'selection' }); } catch (e) {} }
  }, [drawing, api]);
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
        noteCards(elements);
        R.current.savedVersion = getSceneVersion(elements);
        R.current.thumbVersion = R.current.savedVersion;
        R.current.openVersion = R.current.savedVersion;
        R.current.legacyPending = (row.scene && row.scene.legacyPending) || [];
        R.current.bg = (row.scene && row.scene.appState && row.scene.appState.viewBackgroundColor) || BG;
        R.current.openBg = R.current.bg;
        setMeta(row);
        setInitial({
          elements,
          files,
          appState: { ...DEFAULTS, ...(row.scene && row.scene.appState || {}) },
          scrollToContent: true,
          libraryItems: loadLibrary(),
        });
        // breadcrumb
        const list = await store.listBoards();
        const by = Object.fromEntries(list.map(b => [b.id, b]));
        const t = []; let p = row.parent_id; let guard = 0;
        while (p && by[p] && guard++ < 12) { t.unshift(by[p]); p = by[p].parent_id; }
        setTrail(t);
        if (!dead) { setKids(list.filter(b => b.parent_id === boardId && !b.trashed_at)); }
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
      extra: { search_text: (meta ? meta.title + ' ' : '') + words, item_count: countItems(live), cover_file: firstImage ? firstImage.fileId : null },
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
      catch (e) { R.current.filesOwed = true; setStatus('An image didn\'t upload; will retry'); }
      finally { R.current.uploading.delete(id); }
    }
  }, [boardId]);

  const mergeRemote = useCallback(async (a, remote) => {
    const remoteEls = restoreElements(remote.scene && remote.scene.elements || [], null);
    const merged = reconcileElements(a.getSceneElementsIncludingDeleted(), remoteEls, a.getAppState());
    const have = new Set(Object.keys(a.getFiles()));
    const need = merged.filter(e => e.type === 'image' && e.fileId && !have.has(e.fileId)).map(e => e.fileId);
    if (need.length) a.addFiles(await store.loadFiles(boardId, need));
    noteCards(merged);
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
      // An image that didn't upload last time is retried even when nothing else changed.
      if (version === R.current.savedVersion && R.current.bg === scene.appState.viewBackgroundColor && !R.current.filesOwed) return;
      R.current.filesOwed = false;
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
      if (R.current.filesOwed && !R.current.dead) { clearTimeout(R.current.fileTimer); R.current.fileTimer = setTimeout(save, 15000); }
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
      // the same picture as the card on a board above, so the two never differ
      const blob = await previewBlob(all, snap && snap.files ? snap.files : a.getFiles(),
        snap && snap.scene ? snap.scene.appState.viewBackgroundColor : a.getAppState().viewBackgroundColor);
      if (!blob) return;
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
  const live = useLive({ api, boardId, onFilesNeeded: fetchMissing, onCommentsChanged: loadComments, onRemoteElements: noteCards });
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
      return true;
    } catch (e) { setStatus('Couldn\'t add the comment: ' + (e.message || e) + '. Your words are still in the box.'); return false; }
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
        // the card is already back on this board; don't let a save still on its way make a second one
        for (const id of job.movedBoards) await store.moveInto(id, boardId, boardCard, { addCard: false }).catch(() => {});
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
      const count = countItems(next);
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
      // The board you just came back from may still be saving: look again once
      // it has had time to land, and once more a little later.
      let left = null, changed = false;
      try {
        const raw = sessionStorage.getItem('boards:left'); sessionStorage.removeItem('boards:left');
        if (raw) { try { const o = JSON.parse(raw); left = o.id; changed = !!o.changed; } catch (e) { left = raw; changed = true; } }
      } catch (e) {}
      const back = left && ids.includes(left);
      const handed = left ? leaving.get(left) : null; if (left) leaving.delete(left);
      if (back && changed) {
        // The card you came back from animates only while its new picture is
        // being drawn, and stops the moment it shows.
        setCardInfo(ci => ({ ...ci, [left]: { ...(ci[left] || {}), updating: true } }));
        const done = (blob, bg, count) => {
          setCardInfo(ci => ({ ...ci, [left]: { ...(ci[left] || {}),
            ...(blob ? { thumb: URL.createObjectURL(blob), bg } : {}), ...(count === 0 ? { thumb: null } : count != null ? { count } : {}), updating: false } }));
          if (blob && store.canEdit) store.saveThumb(left, blob).catch(() => {});
        };
        if (handed) Promise.race([handed.p, new Promise(r => setTimeout(() => r(undefined), 4000))])
          .then(blob => blob === undefined ? freshenPreviews([left], left, true) : done(blob, handed.bg, handed.count));
        else freshenPreviews([left], left, true);
      }
      // Then quietly check every card against what's saved, once the save has
      // had time to land and once more a little later.
      // A picture handed over on the way out is already the newest one, so only
      // redraw it again if what's saved turns out newer; without one, redraw it.
      const force = back && changed && !handed ? left : null;
      setTimeout(() => freshenPreviews(ids, force), 1500);
      if (back && changed) setTimeout(() => freshenPreviews([left], force), 6000);
    } catch (e) {}
  }, []);

  // A board card shows a picture of what's on that board, scaled to fill the
  // card. The picture is redrawn here whenever that board has changed since
  // this device last drew it, so it never lags behind what's inside.
  // `left` is redrawn whatever its stamp says (its save may land after the
  // stamp). `animate` shows the loading animation on it until its picture is in.
  async function freshenPreviews(ids, left, animate) {
    const stop = (id) => setCardInfo(ci => ({ ...ci, [id]: { ...(ci[id] || {}), updating: false } }));
    let by = {};
    try { by = Object.fromEntries((await store.listBoards()).map(b => [b.id, b])); }
    catch (e) { if (animate && left) stop(left); return; }
    for (const id of ids.slice(0, 16)) {
      try {
        const b = by[id]; if (!b) continue;
        // the count always follows what's saved now
        setCardInfo(ci => ({ ...ci, [id]: { ...(ci[id] || {}), title: b.title, count: b.item_count, ...(b.item_count === 0 ? { thumb: null } : {}) } }));
        if (!(b.item_count > 0)) continue;
        const at = await store.thumbAt(id);
        const changed = Date.parse(b.updated_at) || 0;
        if (id !== left && at && at >= changed) continue;
        const row = await store.loadBoard(id);
        const all = (row && row.scene && row.scene.elements) || [];
        const need = [...new Set(all.filter(e => e && !e.isDeleted && e.type === 'image' && e.fileId).map(e => e.fileId))];
        const files = need.length ? Object.fromEntries((await store.loadFiles(id, need)).map(f => [f.id, f])) : {};
        const bg = (row.scene.appState && row.scene.appState.viewBackgroundColor) || BG;
        const blob = await previewBlob(all, files, bg);
        if (!blob) continue;
        setCardInfo(ci => ({ ...ci, [id]: { ...(ci[id] || {}), thumb: URL.createObjectURL(blob), bg, updating: false } }));
        if (store.canEdit) await store.saveThumb(id, blob);
      } catch (e) { /* one board's picture never blocks the others */ }
      finally { if (animate && id === left) stop(id); }
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
    if (store.canEdit) {
      const fresh = elements.filter(e => !e.isDeleted && e.customData && e.customData.kind === 'board' && e.customData.boardId && !knownCards.current.has(e.id));
      if (fresh.length) { noteCards(fresh); const copies = fresh.filter(e => !e.customData.linked); if (copies.length) setTimeout(() => copyCardsRef.current(copies), 0); }
      // A card brought back with Undo (keys or button) brings its board back
      // out of Trash, the same as the Undo on the toast.
      if (R.current.binned.size) {
        for (const id of cardIds) {
          const b = R.current.binned.get(id); if (!b) continue;
          R.current.binned.delete(id);
          store.restore(id).catch(() => setStatus('Couldn\u2019t take \u201c' + (b.title || 'Untitled board') + '\u201d out of Trash'));
          setKids(k => k.some(x => x.id === id) ? k : [...k, b]);
          setUndoStack(null);
        }
      }
    }
    const ck = cardIds.join(',');
    if (ck !== R.current.cardKey) { R.current.cardKey = ck; const fresh = cardIds.filter(id => !R.current.cardSeen || !R.current.cardSeen.has(id));
      R.current.cardSeen = new Set(cardIds); if (fresh.length) loadCardInfo(fresh); }
    const oneImage = picked.length === 1 && picked[0].type === 'image' ? picked[0] : null;
    const busy = !!(appState.selectedElementsAreBeingDragged || appState.resizingElement || appState.newElement || appState.editingTextElement || appState.isRotating);
    // typing in a plain note shows the B I U S bar over it
    const et = appState.editingTextElement;
    const box = et && et.containerId ? elements.find(e => e.id === et.containerId) : null;
    const plainId = box && !box.isDeleted && box.type === 'rectangle' && box.customData && box.customData.kind === 'note' ? box.id : null;
    setFmt(f => plainId ? (f && f.id === plainId && f.mode === 'plain' ? f : { id: plainId, mode: 'plain' }) : (f && f.mode === 'plain' ? null : f));
    const notes = picked.length > 0 && picked.every(e => e.customData && e.customData.kind === 'note');
    const units = new Set(picked.filter(e => !e.containerId).map(e => e.groupIds && e.groupIds.length ? 'g' + e.groupIds[e.groupIds.length - 1] : e.id)).size;
    const tops = picked.filter(e => !e.containerId);
    const card = tops.length === 1 && tops[0].customData && tops[0].customData.kind === 'board' ? tops[0].customData.boardId || null : null;
    const styleIds = [...new Set(picked.map(e => e.customData && e.customData.styleId).filter(Boolean))];
    const style = units === 1 && styleIds.length === 1 ? styleIds[0] : null;
    setSel(s => (s.count === picked.length && s.oneImage === oneImage && s.busy === busy && s.notes === notes && s.units === units && s.card === card && s.style === style) ? s : { count: picked.length, oneImage, busy, notes, units, card, style });
    // picking a drawing tool by its key shows the drawing tools, so it's never a hidden mode
    const tool = appState.activeTool && appState.activeTool.type;
    if (tool && !['selection', 'hand', 'laser'].includes(tool) && !R.current.drawingOn) { R.current.drawingOn = true; setDrawing(true); }
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
    clearTimeout(R.current.timer); clearTimeout(R.current.fileTimer);
    let snap = null;
    try { if (a && store.canEdit) snap = sf(a); } catch (e) {}
    R.current.dead = true;
    // Tell the board you go back to which one you left, and whether anything
    // on it changed while you were here. Only a changed board gets the loading
    // animation, and its new picture is drawn right now from this copy.
    const changed = !!(snap && R.current.openVersion != null && (snap.version !== R.current.openVersion || snap.scene.appState.viewBackgroundColor !== R.current.openBg));
    if (changed) {
      const p = previewBlob(snap.scene.elements, snap.files, snap.scene.appState.viewBackgroundColor).catch(() => null);
      leaving.set(boardId, { p, bg: snap.scene.appState.viewBackgroundColor, count: snap.extra.item_count });
    }
    try { sessionStorage.setItem('boards:left', JSON.stringify({ id: boardId, changed })); } catch (e) {}
    if (snap) { sv(snap); th(snap); }
  }, []);

  // Open on the whole board with a little room round it, never zoomed in past
  // 100%. Or, coming from a search, on the thing that matched.
  useEffect(() => {
    if (!api) return;
    // fit these on screen with room round them, but never larger than life
    const fitView = (els, room) => {
      const st = api.getAppState();
      const xs = els.flatMap(e => [e.x, e.x + e.width]), ys = els.flatMap(e => [e.y, e.y + e.height]);
      const bw = Math.max(1, Math.max(...xs) - Math.min(...xs)), bh = Math.max(1, Math.max(...ys) - Math.min(...ys));
      const z = Math.min(1, room * Math.min(st.width / bw, st.height / bh));
      if (z >= 1) { api.updateScene({ appState: { zoom: { value: 1 } } }); api.scrollToContent(els); }
      else api.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: room });
    };
    const fit = () => {
      try {
        const els = api.getSceneElements(); if (!els.length) return;
        const term = String(find || '').trim().toLowerCase();
        if (term) {
          const hit = els.find(e => (e.type === 'text' && String(e.text || '').toLowerCase().includes(term))
            || (e.type === 'frame' && String(e.name || '').toLowerCase().includes(term))
            || (e.type === 'embeddable' && cardWords(e).toLowerCase().includes(term)));
          if (hit) {
            const target = hit.containerId ? els.find(e => e.id === hit.containerId) || hit : hit;
            fitView([target], 0.35);
            api.updateScene({ appState: { selectedElementIds: { [target.id]: true } } });
            return;
          }
        }
        fitView(els, 0.9);
      } catch (e) {}
    };
    const t = setTimeout(fit, 60);
    return () => clearTimeout(t);
  }, [api]);

  // ── styles and photos sent from the line list (Build 650) ──────────────
  // VENIA OS hands them over in this tab's sessionStorage; each style lands as
  // a photo with its name, colourway, price and stage under it, grouped into
  // sections. Linked cards keep the style's id and update when the board opens.
  useEffect(() => {
    if (!api || !initial || !store.canEdit) return;
    let job = null;
    try { job = JSON.parse(sessionStorage.getItem(pendingKey(boardId)) || 'null'); sessionStorage.removeItem(pendingKey(boardId)); } catch (e) {}
    if (!job || !Array.isArray(job.items) || !job.items.length) return;
    (async () => {
      const items = job.items.slice(0, 300);
      setBusy(items.length > 1 ? `Adding ${items.length} to the board…` : 'Adding it to the board…');
      try {
        // the photos, four at a time
        const pics = new Array(items.length).fill(null);
        let next = 0;
        await Promise.all([0, 1, 2, 3].map(async () => {
          while (next < items.length) {
            const i = next++; const it = items[i];
            if (!it.image) continue;
            try { const blob = await fetchImage(it.image); if (blob) pics[i] = await prepareImage(blob); } catch (e) {}
          }
        }));
        const CW = 260, IH = 320, CAP = 64, G = 28, P = 32, COLS = 4;
        const groups = new Map();
        items.forEach((it, i) => { const k = groupName(it, job.groupBy || 'none'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
        const live = api.getSceneElements();
        let x0 = 0, y0 = 0;
        if (live.length) { x0 = Math.max(...live.map(e => e.x + (e.width || 0))) + 160; y0 = Math.min(...live.map(e => e.y)); }
        const add = [], files = [];
        let failed = 0;
        let sx = x0;
        for (const [name, idx] of groups) {
          const cols = Math.min(COLS, idx.length), rows = Math.ceil(idx.length / cols);
          const fw = P * 2 + cols * CW + (cols - 1) * G, fh = P * 2 + rows * (IH + CAP) + (rows - 1) * G;
          let frame = null;
          if (name) { [frame] = convertToExcalidrawElements([{ type: 'frame', x: sx || 0.5, y: y0 || 0.5, width: fw, height: fh, name, children: [] }]); add.push(frame); }
          idx.forEach((i, k) => {
            const it = items[i];
            const cx = sx + P + (k % cols) * (CW + G), cy = y0 + P + Math.floor(k / cols) * (IH + CAP + G);
            const tag = { styleId: it.styleId || undefined, linked: !!(job.linked && it.styleId) || undefined };
            const g = 'g' + Math.random().toString(36).slice(2, 10);
            const fid = frame ? { frameId: frame.id } : {};
            const img = pics[i];
            if (img) {
              const id = uid('f');
              files.push({ id, dataURL: img.dataURL, mimeType: img.mimeType, created: Date.now() });
              const sc = Math.min(CW / img.width, IH / img.height);
              const w = Math.round(img.width * sc), h = Math.round(img.height * sc);
              const [pic] = convertToExcalidrawElements([{ type: 'image', fileId: id, x: cx + (CW - w) / 2, y: cy + (IH - h), width: w, height: h,
                customData: { kind: 'style', source: it.image, ...tag } }]);
              const [cap] = convertToExcalidrawElements([{ type: 'text', x: cx, y: cy + IH + 12, text: it.styleId ? styleCaption(it) : (it.name || ''),
                fontSize: 18, fontFamily: FONT_FAMILY.Helvetica, strokeColor: '#111111', customData: { kind: 'style-caption', ...tag } }]);
              add.push({ ...pic, groupIds: [g], ...fid }, ...(cap.text ? [{ ...cap, groupIds: [g], ...fid }] : []));
            } else {
              if (it.image) failed++;
              const els = note(cx, cy + IH - 170, it.styleId ? styleCaption(it) : (it.name || 'Photo'), NOTE_COLOURS[1].hex, CW, 170);
              add.push(...els.map(e => ({ ...e, ...fid, ...(e.type === 'rectangle' ? { customData: { ...(e.customData || {}), ...tag } } : {}) })));
            }
          });
          sx += fw + 80;
        }
        if (files.length) api.addFiles(files);
        noteCards(add);
        api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...add], appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        try { api.scrollToContent(add.filter(e => !e.containerId), { fitToViewport: true, viewportZoomFactor: 0.9, animate: true }); } catch (e) {}
        setStatus(failed ? failed + (failed === 1 ? ' photo' : ' photos') + ' couldn\u2019t be loaded, so ' + (failed === 1 ? 'it is' : 'they are') + ' a note' : (job.linked ? 'Added. The cards stay in step with the line list' : 'Added'));
        save();
      } catch (e) { setStatus('Couldn\u2019t add them all: ' + (e.message || e)); }
      finally { setBusy(''); }
    })();
  }, [api, initial]);

  // Linked style cards ask VENIA OS for the style as it is now, and take its
  // name, colourway, price and stage. Nothing else on the card changes, and the
  // line list is never changed from here.
  useEffect(() => {
    if (!api || !initial || !inHost || !store.canEdit) return;
    const ids = [...new Set(api.getSceneElements().filter(e => e.customData && e.customData.linked && e.customData.styleId).map(e => e.customData.styleId))];
    if (!ids.length) return;
    const got = (ev) => {
      if (ev.origin !== window.location.origin || !ev.data || ev.data.source !== 'venia-host' || ev.data.type !== 'boards:style-info') return;
      const by = Object.fromEntries(((ev.data.payload && ev.data.payload.styles) || []).map(x => [x.styleId, x]));
      const all = api.getSceneElementsIncludingDeleted();
      const linkedRect = new Map(all.filter(e => !e.isDeleted && e.type === 'rectangle' && e.customData && e.customData.linked && e.customData.styleId).map(e => [e.id, e.customData.styleId]));
      let changed = false;
      const next = all.map(e => {
        if (e.isDeleted || e.type !== 'text') return e;
        const sid = (e.customData && e.customData.linked && e.customData.kind === 'style-caption' && e.customData.styleId) || (e.containerId && linkedRect.get(e.containerId));
        const st = sid && by[sid]; if (!st) return e;
        const t = styleCaption(st);
        if (e.originalText === t || e.text === t) return e;
        changed = true;
        return newElementWith(e, { text: t, originalText: t });
      });
      if (changed) { api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.EVENTUALLY }); setStatus('Updated from the line list'); }
    };
    window.addEventListener('message', got);
    tellHost('boards:style-info', { ids });
    const t = setTimeout(() => window.removeEventListener('message', got), 8000);
    return () => { clearTimeout(t); window.removeEventListener('message', got); };
  }, [api, initial]);

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
  const box = (els) => {
    const xs = els.flatMap(e => [e.x, e.x + e.width]), ys = els.flatMap(e => [e.y, e.y + e.height]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };
  // The section you're working in: the one you've selected, or the one in the
  // middle of the screen. Things you add go in it, the way a template means.
  const workingFrame = () => {
    const st = api.getAppState();
    const live = api.getSceneElements();
    const picked = live.filter(e => st.selectedElementIds && st.selectedElementIds[e.id]);
    if (picked.length === 1 && picked[0].type === 'frame') return picked[0];
    const c = center();
    const under = live.filter(e => e.type === 'frame' && c.x >= e.x && c.x <= e.x + e.width && c.y >= e.y && c.y <= e.y + e.height);
    return under.sort((a, b) => a.width * a.height - b.width * b.height)[0] || null;
  };
  // A free spot for something w × h. Inside a section it fills from the top
  // left, row by row; otherwise near the middle of the screen. Never on top of
  // something already there, including what's being added with it.
  const spotFor = (w, h, frame = null, extra = []) => {
    // Everything on the board counts, not only what's in the section: when the
    // section is full the spot is found outside it, and must not land on
    // something there (a new note used to land on a palette).
    const live = [...api.getSceneElements().filter(e => !e.containerId && e.type !== 'frame'), ...extra];
    const hits = (x, y) => live.some(e => x < e.x + e.width + 16 && x + w + 16 > e.x && y < e.y + e.height + 16 && y + h + 16 > e.y);
    if (frame) {
      const P = 20;
      for (let y = frame.y + P; y + h <= frame.y + frame.height - P + 0.5; y += 24) {
        for (let x = frame.x + P; x + w <= frame.x + frame.width - P + 0.5; x += 24) if (!hits(x, y)) return { x, y, frame };
      }
    }
    const c = center();
    let x = c.x - w / 2, y = c.y - h / 2;
    for (let i = 0; i < 24 && hits(x, y); i++) {
      // walk right along the row, then start a row below
      x += w + 24;
      if (i % 6 === 5) { x = c.x - w / 2; y += h + 24; }
    }
    return { x, y, frame: null };
  };
  const overlaps = (e, f) => e.x < f.x + f.width && e.x + e.width > f.x && e.y < f.y + f.height && e.y + e.height > f.y;
  // Put a set of elements (built anywhere) at a free spot, in the section
  // you're working in when there's room there.
  const placeEls = (els, { frame = workingFrame(), extra = [] } = {}) => {
    const top = els.filter(e => !e.containerId);
    const b = box(top.length ? top : els);
    const p = spotFor(b.w, b.h, frame, extra);
    const fid = p.frame ? p.frame.id : null;
    return els.map(e => ({ ...e, x: e.x - b.x + p.x, y: e.y - b.y + p.y, ...(fid ? { frameId: fid } : {}) }));
  };
  // Show what was added only if it isn't on screen already, so the view
  // doesn't jump about while you work.
  const bringIntoView = (els) => {
    const st = api.getAppState();
    const top = els.filter(e => !e.containerId); if (!top.length) return;
    const r = top.map(e => rectOf(e));
    const inView = r.every(q => q.left >= 0 && q.top >= 0 && q.left + q.width <= st.width && q.top + q.height <= st.height);
    if (!inView) { try { api.scrollToContent(top, { animate: true }); } catch (e) {} }
  };
  const addEls = (els, select = true) => {
    noteCards(els);
    setTools(false);   // on a phone, the Add sheet steps aside once something lands
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), ...els],
      appState: select ? { selectedElementIds: Object.fromEntries(els.filter(e => !e.containerId).map(e => [e.id, true])), selectedGroupIds: {} } : undefined,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    bringIntoView(els);
  };

  // Start typing straight into a note, its words selected so typing replaces them.
  const editNote = (rect) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        const canvas = wrapRef.current && wrapRef.current.querySelector('canvas.interactive');
        if (!canvas) return;
        const st = api.getAppState();
        const p = sceneCoordsToViewportCoords({ sceneX: rect.x + rect.width / 2, sceneY: rect.y + rect.height / 2 }, st);
        canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, view: window }));
        setTimeout(() => { const t = wrapRef.current && wrapRef.current.querySelector('textarea.excalidraw-wysiwyg'); if (t) { t.focus(); t.select(); } }, 30);
      } catch (e) {}
    }));
  };

  function addNote(colour = NOTE_COLOURS[0].hex) {
    const els = placeEls(note(0, 0, 'New note', colour));
    addEls(els);
    setPanel(null);
    const rect = els.find(e => !e.containerId);
    if (rect) editNote(rect);
  }

  // Photos: any number at once, laid out as a moodboard where they land.
  async function addImages(blobs, at, sources = []) {
    if (!blobs.length) return;
    setBusy(blobs.length > 1 ? `Adding ${blobs.length} images…` : 'Adding image…');
    try {
      // dropped on a spot: there; otherwise in the section you're working in
      const frame = at ? null : workingFrame();
      const placed = [];
      let x = at ? at.x : 0, y = at ? at.y : 0;
      for (let i = 0; i < blobs.length; i++) {
        const img = await prepareImage(blobs[i]);
        const id = uid('f');
        api.addFiles([{ id, dataURL: img.dataURL, mimeType: img.mimeType, created: Date.now() }]);
        // a picture fits inside the section it goes in
        const side = frame ? Math.min(IMG_SIDE, frame.width - 40, frame.height - 40) : IMG_SIDE;
        const s = Math.min(1, Math.max(80, side) / Math.max(img.width, img.height));
        const w = Math.round(img.width * s), h = Math.round(img.height * s);
        let [el] = convertToExcalidrawElements([{ type: 'image', fileId: id, x, y, width: w, height: h, customData: sources[i] ? { source: sources[i] } : undefined }]);
        if (!at) [el] = placeEls([el], { frame, extra: placed });
        placed.push(el);
        x += w + 24;
      }
      addEls(placed);
      if (placed.length > 1 && at) {
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
      const [r] = convertToExcalidrawElements([{ type: 'rectangle', x: 0, y: 0, width: 480, height: 270 }]);
      addEls(placeEls(restoreElements([{ ...r, type: 'embeddable', link: url, strokeColor: 'transparent', backgroundColor: 'transparent' }], null)));
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
      addEls(placeEls(linkCard(0, 0, { url, ...(info || {}), site: (info && info.site) || hostOf(url) })));
      if (!info) setStatus(store.mode === 'cloud' ? 'Couldn\'t read that page, so it\'s a plain link card' : 'Saved as a link card');
    } finally { setBusy(''); }
  }

  function addTodo() {
    addEls(placeEls(todoCard(0, 0)));
    setStatus('Click the list to tick things off or add to it');
  }

  // A column: wraps what's selected, or starts empty in the middle.
  async function addColumn() {
    const name = await askName('Name this column', 'Column'); if (name === null) return;
    const st = api.getAppState();
    const units = selectionUnits(api.getSceneElementsIncludingDeleted(), st.selectedElementIds);
    const members = units.flatMap(u => u.members).filter(m => m.type !== 'frame');
    let col;
    if (members.length) {
      const [x1, y1] = [Math.min(...members.map(m => m.x)), Math.min(...members.map(m => m.y))];
      col = { ...newColumn(x1 - 16, y1 - 16, name || 'Column') };
      const ids = new Set(members.map(m => m.id));
      const rest = api.getSceneElementsIncludingDeleted().map(e => ids.has(e.id) ? newElementWith(e, { frameId: col.id }) : e);
      api.updateScene({ elements: [col, ...rest], appState: { selectedElementIds: { [col.id]: true } }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    } else {
      const p = spotFor(300, 120, null);
      col = newColumn(p.x, p.y, name || 'Column');
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

  function recolourNotes(hex) {
    const st = api.getAppState();
    const ids = new Set(Object.keys(st.selectedElementIds || {}).filter(k => st.selectedElementIds[k]));
    const next = api.getSceneElementsIncludingDeleted().map(e => {
      if (ids.has(e.id) && e.customData && e.customData.kind === 'note') return newElementWith(e, { backgroundColor: hex, strokeColor: hex === '#161616' ? '#161616' : '#d9d3c7' });
      if (e.containerId && ids.has(e.containerId) && e.type === 'text') return newElementWith(e, { strokeColor: readableOn(hex) });
      return e;
    });
    api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }

  // ── bold, italic, underline, strikethrough ─────────────────────────────
  // A note becomes a styled note the first time something in it is styled;
  // until then it stays exactly as it was.
  const CMD = { b: 'bold', i: 'italic', u: 'underline', s: 'strikeThrough' };
  const openRich = (id, range, then) => window.dispatchEvent(new CustomEvent(RICH_EDIT, { detail: { id, range, then } }));

  // Make plain notes styled ones (same id, same spot). Returns the new scene.
  function convertNotes(all, ids, parasOf) {
    const gone = new Set();
    const next = all.map(e => {
      if (!ids.has(e.id) || e.isDeleted || e.type !== 'rectangle' || !e.customData || e.customData.kind !== 'note') return e;
      const t = all.find(x => x.containerId === e.id && x.type === 'text' && !x.isDeleted);
      if (t) gone.add(t.id);
      return richFrom(e, parasOf(e, t));
    });
    return next.map(e => gone.has(e.id) ? newElementWith(e, { isDeleted: true }) : e);
  }

  // While typing in a plain note: keep its words, style what's selected, and
  // carry on typing in the styled note.
  function styleWhileTyping(k) {
    const ta = wrapRef.current && wrapRef.current.querySelector('textarea.excalidraw-wysiwyg');
    const f = fmt; if (!ta || !f || f.mode !== 'plain') return;
    const value = ta.value, a = ta.selectionStart, b = ta.selectionEnd, id = f.id;
    ta.blur();     // the board saves the words as they are
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const all = api.getSceneElementsIncludingDeleted();
      if (!all.some(e => e.id === id && !e.isDeleted)) return;
      api.updateScene({ elements: convertNotes(all, new Set([id]), () => parasFromText(value)), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      setTimeout(() => openRich(id, [a, b], CMD[k]), 30);
    }));
  }

  // The bar's buttons with nothing open: the whole of each selected note.
  function styleNotes(k) {
    const st = api.getAppState();
    const ids = new Set(Object.keys(st.selectedElementIds || {}).filter(x => st.selectedElementIds[x]));
    const all = api.getSceneElementsIncludingDeleted();
    const picked = all.filter(e => ids.has(e.id) && !e.isDeleted && e.customData && e.customData.kind === 'note');
    if (!picked.length) return;
    const parasOf = (e) => {
      if (isRich(e)) return e.customData.paras || [[]];
      const t = all.find(x => x.containerId === e.id && x.type === 'text' && !x.isDeleted);
      return parasFromText(t ? (t.originalText != null ? t.originalText : t.text) : '');
    };
    const on = !picked.every(e => isRich(e) && allHave(parasOf(e), k));
    const styled = new Set(picked.filter(isRich).map(e => e.id));
    const next = convertNotes(all, new Set(picked.filter(e => !isRich(e)).map(e => e.id)), (e) => setAll(parasOf(e), k, on))
      .map(e => styled.has(e.id) ? newElementWith(e, { customData: { ...e.customData, paras: setAll(parasOf(e), k, on) } }) : e);
    api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }

  // Aa on a phone: open the selected note for typing, where its bar has B I U S.
  function typeInNote() {
    const st = api.getAppState();
    const n = api.getSceneElements().find(e => st.selectedElementIds && st.selectedElementIds[e.id] && e.customData && e.customData.kind === 'note');
    if (!n) return;
    if (isRich(n)) openRich(n.id); else editNote(n);
  }

  // A button on the bar over an open note
  function fmtPress(k) {
    if (!fmt) return;
    if (fmt.mode === 'plain') { styleWhileTyping(k); return; }
    try { document.execCommand(CMD[k]); } catch (e) {}
    readFmtOn();
  }
  function fmtDone() {
    if (fmt && fmt.mode === 'plain') { const ta = wrapRef.current && wrapRef.current.querySelector('textarea.excalidraw-wysiwyg'); if (ta) ta.blur(); }
    else if (document.activeElement && document.activeElement.isContentEditable) document.activeElement.blur();
  }
  const readFmtOn = () => {
    const q = (c) => { try { return document.queryCommandState(c); } catch (e) { return false; } };
    const next = { b: q('bold'), i: q('italic'), u: q('underline'), s: q('strikeThrough') };
    setFmtOn(o => (o.b === next.b && o.i === next.i && o.u === next.u && o.s === next.s) ? o : next);
  };

  // Delete what's selected, with an Undo. A section takes what's in it along.
  function doDelete() {
    const st = api.getAppState();
    const all = api.getSceneElementsIncludingDeleted();
    const ids = new Set(Object.keys(st.selectedElementIds || {}).filter(k => st.selectedElementIds[k]));
    all.forEach(e => { if (e.frameId && ids.has(e.frameId)) ids.add(e.id); });
    all.forEach(e => { if (e.containerId && ids.has(e.containerId)) ids.add(e.id); });
    const gone = all.filter(e => ids.has(e.id) && !e.isDeleted);
    if (!gone.length) return;
    const n = gone.filter(e => !e.containerId).length;
    // A board made inside this one goes to Trash with its card (restorable
    // there, and Undo here brings both back). A linked board that lives
    // elsewhere only loses its card. A board still shown by another card stays.
    const kept = new Set(all.filter(e => !e.isDeleted && !ids.has(e.id) && e.customData && e.customData.kind === 'board').map(e => e.customData.boardId));
    const binned = [...new Set(gone.filter(e => e.customData && e.customData.kind === 'board' && e.customData.boardId).map(e => e.customData.boardId))]
      .map(id => kids.find(b => b.id === id)).filter(b => b && !kept.has(b.id));
    api.updateScene({ elements: all.map(e => ids.has(e.id) && !e.isDeleted ? newElementWith(e, { isDeleted: true }) : e), appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    if (binned.length) {
      setKids(k => k.filter(b => !binned.some(x => x.id === b.id)));
      binned.forEach(b => { R.current.binned.set(b.id, b); store.trash(b.id).catch(() => setStatus('Couldn\u2019t move \u201c' + (b.title || 'Untitled board') + '\u201d to Trash')); });
    }
    const back = new Set(gone.map(e => e.id));
    const text = binned.length === 1 && n === 1 ? 'Moved \u201c' + (binned[0].title || 'Untitled board') + '\u201d to Trash'
      : binned.length ? 'Deleted ' + n + ' things; ' + binned.length + (binned.length === 1 ? ' board' : ' boards') + ' moved to Trash'
      : n === 1 ? 'Deleted' : 'Deleted ' + n + ' things';
    setUndoStack({ text, undo: () => {
      api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map(e => back.has(e.id) && e.isDeleted ? newElementWith(e, { isDeleted: false }) : e), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      if (binned.length) {
        setKids(k => [...k, ...binned.filter(b => !k.some(x => x.id === b.id))]);
        binned.forEach(b => { R.current.binned.delete(b.id); store.restore(b.id).catch(() => {}); });
      }
    } });
  }
  doDeleteRef.current = doDelete;
  // Backspace and Delete do exactly what the bin button does, so a board
  // inside this one is never left behind with no card.
  useEffect(() => {
    if (!api || !store.canEdit) return;
    const key = (e) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"], .pop, .side-panel'))) return;
      const st = api.getAppState();
      if (st.editingTextElement || st.newElement || st.openDialog) return;
      if (document.querySelector('.modal-wrap')) return;   // a dialog is open: the key is for it
      if (!Object.values(st.selectedElementIds || {}).some(Boolean)) return;
      e.preventDefault(); e.stopPropagation();
      doDeleteRef.current();
    };
    // The canvas's own Delete buttons (the phone's bottom bar, the right-click
    // menu) go the same way, so they never leave a board without its card.
    const click = (e) => {
      const t = e.target; if (!t || !t.closest) return;
      const hit = t.closest('.excalidraw button[aria-label="Delete"], .excalidraw .context-menu-item.dangerous');
      if (!hit) return;
      const st = api.getAppState();
      if (st.editingLinearElement || !Object.values(st.selectedElementIds || {}).some(Boolean)) return;
      if (hit.tagName === 'BUTTON') { e.preventDefault(); e.stopPropagation(); }
      doDeleteRef.current();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('click', click, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('click', click, true); };
  }, [api]);

  async function doFrame() {
    const st = api.getAppState();
    const units = selectionUnits(api.getSceneElementsIncludingDeleted(), st.selectedElementIds);
    const members = units.flatMap(u => u.members);
    if (!members.length) return;
    const name = await askName('Name this group', 'Group');
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
      const colour = api.getSceneElements().find(e => e.type === 'frame' && /^(colou?rs?|palette)$/i.test(String(e.name || '').trim()));
      addEls(colour ? placeEls(paletteRow(0, 0, cols), { frame: colour }) : paletteRow(el.x, el.y + el.height + 18, cols));
    } finally { setBusy(''); }
  }

  // A board inside this one whose card was removed from the canvas still
  // exists (removing a card never trashes the board). Offer it back.
  const shownKids = new Set((api ? api.getSceneElements() : []).filter(e => e.customData && e.customData.kind === 'board').map(e => e.customData.boardId));
  const hiddenKids = kids.filter(b => !shownKids.has(b.id));
  // How many cards on this canvas show each board (more than one = linked).
  const cardCount = {};
  (api ? api.getSceneElements() : []).forEach(x => { if (x.customData && x.customData.kind === 'board' && x.customData.boardId) cardCount[x.customData.boardId] = (cardCount[x.customData.boardId] || 0) + 1; });
  function showKids() {
    const els = [];
    hiddenKids.forEach((b) => { els.push(...placeEls(boardCard(0, 0, b), { frame: null, extra: els.filter(e => !e.containerId) })); });
    if (els.length) addEls(els);
  }

  function placeBoardCard(b) {
    // An existing board placed here is the same board, shown in two places.
    const els = placeEls(boardCard(0, 0, b)).map(e => (e.customData && e.customData.kind === 'board') ? { ...e, customData: { ...e.customData, linked: true } } : e);
    addEls(els);
    setPanel(null);
  }

  // A board just made inside this one: its card is the board's home, not a link.
  function placeNewKid(b) {
    setKids(k => k.some(x => x.id === b.id) ? k : [...k, b]);
    addEls(placeEls(boardCard(0, 0, b)));
    setPanel(null);
  }

  // A pasted or duplicated board card becomes its own board: a full copy,
  // pictures and inner boards included, so changing one never changes the
  // other. (A card copied with "Copy link" stays a link.)
  async function copyCards(cards) {
    for (const card of cards) {
      const srcId = card.customData.boardId;
      const srcTitle = (cardInfo[srcId] && cardInfo[srcId].title) || card.customData.title || 'Untitled board';
      const title = srcTitle + ' copy';
      setBusy('Copying \u201c' + srcTitle + '\u201d\u2026');
      try {
        const newId = await store.copyBoard(srcId, { parent_id: boardId, title });
        if (!newId) throw new Error('the original isn\u2019t here any more');
        const all = api.getSceneElementsIncludingDeleted();
        api.updateScene({ elements: all.map(e => e.id === card.id ? newElementWith(e, { customData: { ...e.customData, boardId: newId, title, linked: undefined } })
          : (e.containerId === card.id && e.type === 'text') ? newElementWith(e, { text: '\u25a6  ' + title, originalText: '\u25a6  ' + title }) : e),
          captureUpdate: CaptureUpdateAction.NEVER });
        setKids(k => [...k, { id: newId, title, parent_id: boardId }]);
        R.current.cardKey = null; // look the new card's picture and count up
        setStatus('Made \u201c' + title + '\u201d');
        save();
      } catch (e) {
        // Couldn't copy: the card stays, showing the original, and says so.
        const all = api.getSceneElementsIncludingDeleted();
        api.updateScene({ elements: all.map(x => x.id === card.id ? newElementWith(x, { customData: { ...x.customData, linked: true } }) : x), captureUpdate: CaptureUpdateAction.NEVER });
        setStatus('Couldn\u2019t copy \u201c' + srcTitle + '\u201d (' + (e.message || e) + '); this card links to the original');
      } finally { setBusy(''); }
    }
  }
  copyCardsRef.current = copyCards;

  // Copy a link to the selected board: pasting it on any board shows this
  // same board there (a linked card), instead of making a copy.
  async function copyLink() {
    const st = api.getAppState();
    const card = api.getSceneElements().find(e => st.selectedElementIds && st.selectedElementIds[e.id] && e.customData && e.customData.kind === 'board');
    if (!card) return;
    const els = api.getSceneElements().filter(e => e.id === card.id || e.containerId === card.id)
      .map(e => e.id === card.id ? { ...e, customData: { ...e.customData, linked: true } } : e);
    const text = JSON.stringify({ type: 'excalidraw/clipboard', elements: els, files: {} });
    try { await navigator.clipboard.writeText(text); setUndoStack({ text: 'Link copied. Paste it on any board to show this same board there.' }); }
    catch (e) { setStatus('Couldn\u2019t copy the link here'); }
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
    addEls(placeEls(note(0, 0, text.slice(0, 2000), NOTE_COLOURS[0].hex, 260, 160)));
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
      const hits = api.getSceneElements().filter(x => x.customData && (x.customData.kind === 'board' || (store.canEdit && isRich(x)))
        && p.x >= x.x && p.x <= x.x + x.width && p.y >= x.y && p.y <= x.y + x.height);
      return hits.length ? hits[hits.length - 1] : null;
    };
    // a board card opens the board; a styled note opens for typing
    const open = (c) => { if (isRich(c)) openRich(c.id); else openCard(c.customData.boardId); };
    const down = (e) => {
      if (e.button > 0 || !e.target || !e.target.closest('.excalidraw canvas, .bcard')) return;
      const c = cardAt(e);
      const last = R.current.lastTap;
      const now = Date.now();
      if (c && last && last.id === c.id && now - last.t < 380 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) {
        R.current.lastTap = null;
        e.preventDefault(); e.stopPropagation();
        open(c);
        return;
      }
      R.current.lastTap = c ? { id: c.id, t: now, x: e.clientX, y: e.clientY } : null;
    };
    const dbl = (e) => { const c = cardAt(e); if (c && !(e.target && e.target.isContentEditable)) { e.preventDefault(); e.stopPropagation(); } };
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
      const st0 = api.getAppState();
      if (st0.editingTextElement || st0.openDialog || e.repeat || document.querySelector('.modal-wrap')) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); addNote(NOTE_COLOURS[0].hex); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [api]);

  // A styled note open for typing: show the bar over it, and keep the bar's
  // buttons lit for the words the cursor is in.
  useEffect(() => {
    const on = (e) => { const id = e.detail && e.detail.id; setFmt(f => id ? { id, mode: 'rich' } : (f && f.mode === 'rich' ? null : f)); if (id) readFmtOn(); else setFmtOn({}); };
    const sc = () => { const a = document.activeElement; if (a && a.isContentEditable && a.closest('.card-rich')) readFmtOn(); };
    window.addEventListener(RICH_EDITING, on);
    document.addEventListener('selectionchange', sc);
    return () => { window.removeEventListener(RICH_EDITING, on); document.removeEventListener('selectionchange', sc); };
  }, []);

  // Cmd/Ctrl+B, I, U and Shift+X while typing in a plain note; Enter on a
  // selected styled note opens it for typing.
  const fmtRef = useRef(null); fmtRef.current = { fmt, styleWhileTyping };
  useEffect(() => {
    if (!api || !store.canEdit) return;
    const k = (e) => {
      const t = e.target;
      if (t && t.tagName === 'TEXTAREA' && t.classList.contains('excalidraw-wysiwyg') && (e.metaKey || e.ctrlKey) && !e.altKey) {
        const f = fmtRef.current.fmt; if (!f || f.mode !== 'plain') return;
        const key = e.key.toLowerCase();
        const which = !e.shiftKey && (key === 'b' || key === 'i' || key === 'u') ? key : (e.shiftKey && (key === 'x' || key === 's') ? 's' : null);
        if (!which) return;
        e.preventDefault(); e.stopPropagation();
        fmtRef.current.styleWhileTyping(which);
        return;
      }
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.closest('button'))) return;
      const st = api.getAppState();
      if (st.editingTextElement || st.openDialog || document.querySelector('.modal-wrap')) return;
      const ids = Object.keys(st.selectedElementIds || {}).filter(x => st.selectedElementIds[x]);
      if (ids.length !== 1) return;
      const el = api.getSceneElements().find(x => x.id === ids[0]);
      if (!isRich(el)) return;
      e.preventDefault(); e.stopPropagation();
      openRich(el.id);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [api]);

  // Ctrl/Cmd+F opens Find on this board, which also looks in to-dos, link
  // cards and board names (the canvas's own search sees drawn text only).
  useEffect(() => {
    if (!api) return;
    const k = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key !== 'f' && e.key !== 'F')) return;
      e.preventDefault(); e.stopPropagation();
      setFinding(true);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
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
    const was = meta.title;
    setMeta(m => ({ ...m, title: t }));
    try { await store.rename(boardId, t); }
    catch (e) { setMeta(m => ({ ...m, title: was })); setStatus('Couldn\u2019t rename it: ' + (e.message || 'offline')); return; }
    document.title = t + ' · Boards'; tellHost('boards:title', { title: t });
  }

  const renderCard = React.useMemo(() => makeRenderCard(() => api, store.canEdit), [api]);

  if (missing) return <div className="empty">This board isn't here any more. <button className="link" onClick={() => go('/')}>Back to Boards</button></div>;

  return (
    <div className={'board' + (drawing ? ' drawing' : '')} ref={wrapRef} style={api ? { '--fz': Math.max(0.55, Math.min(1, api.getAppState().zoom.value * 1.6)) } : null}>
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
            <button className="act closes" onClick={() => addNote()} title="Add a note and start typing (N)"><Ico d="M5 4h14v11l-5 5H5z M14 20v-5h5" />Note</button>
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
            <button className="act closes lib-act" onClick={() => { try { api.toggleSidebar({ name: 'default', tab: 'library' }); } catch (e) {} }} title="Notes, sections and layouts to drag in"><Ico d="M4 5h5v14H4z M10 5h4v14h-4z M15 6l4-1 2 13-4 1z" />Library</button>
            <span className="divider" />
            <button className={'act closes draw-toggle' + (drawing ? ' on' : '')} onClick={() => setDrawing(d => !d)} title={drawing ? 'Hide the drawing tools' : 'Shapes, arrows, pen and text tools'}><Ico d="M4.6 19.4v-3.5L15.5 5a2 2 0 0 1 2.83 2.83L7.4 19.4H4.6Z M13.9 6.6l3.5 3.5" />{drawing ? 'Hide tools' : 'Draw'}</button>
          </div>
        )}
        {store.canEdit && api && (
          <div className="actions phone-only">
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
              <Ico d="M3 5h12v8H8l-5 3z M9 16h7l5 3v-9h-3" />{openCount ? <span className="count">{openCount}</span> : null}
            </button>
          </div>
        )}
        {live.on && live.people.length > 0 && (
          <div className="here" title={'Here now: ' + live.people.map(p => p.name).join(', ')}>
            {live.people.slice(0, 4).map(p => <span key={p.key} className="face" style={{ background: p.color }}>{(p.name || '?').slice(0, 1)}</span>)}
          </div>
        )}
        <div className={'status' + (!busy && /^(Not saved|Couldn|An image didn|Someone else)/.test(status || '') ? ' err' : '')}
          onClick={() => { if (!busy && /^(Couldn|An image didn)/.test(status || '')) setStatus(''); }}>{busy || status || (live.on ? 'Live' : '')}</div>
      </header>
      {meta && meta.trashed_at && (
        <div className="note-bar warn">This board is in Trash. <button className="link" onClick={async () => {
          try { await store.restore(boardId); setMeta(m => ({ ...m, trashed_at: null })); } catch (e) { setStatus('Couldn\u2019t restore it: ' + (e.message || 'offline')); }
        }}>Restore it</button></div>
      )}
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
            onLibraryChange={saveLibrary}
            onPointerUpdate={live.pointerMoved}
            isCollaborating={live.on}
            renderEmbeddable={renderCard}
            viewModeEnabled={!store.canEdit}
            langCode="en"
            name={meta ? meta.title : 'Board'}
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, export: { saveFileToDisk: false }, clearCanvas: false, changeViewBackgroundColor: false }, tools: { image: true } }}
            validateEmbeddable={url => (isCardUrl(url) ? true : undefined)}
          >
            <MainMenu>
              <MainMenu.Item onSelect={() => { save(); go('/'); }}>All boards</MainMenu.Item>
              <MainMenu.Separator />
              <MainMenu.Item icon={<Ico d="M4 5h16v14H4z M4 15l5-5 4 4 3-3 4 4 M15 9h.01" />} onSelect={() => { saveImage(api, meta && meta.title).catch(() => setStatus('Couldn\u2019t make the image')); }}>Save as image</MainMenu.Item>
              <MainMenu.Item icon={<Ico d="M7 8V3h10v5 M7 17H4V8h16v9h-3 M7 14h10v7H7z" />} onSelect={() => { printBoard(api, meta && meta.title).catch(() => setStatus('Couldn\u2019t make the PDF')); }}>Print or save as PDF</MainMenu.Item>
              <MainMenu.Item icon={<Ico d="M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M16 16l5 5" />} shortcut="Ctrl+F" onSelect={() => setFinding(true)}>Find on this board</MainMenu.Item>
              <MainMenu.Separator />
              <MainMenu.DefaultItems.Help />
            </MainMenu>
            <WelcomeScreen>
              <WelcomeScreen.Center>
                <WelcomeScreen.Center.Heading>{meta ? meta.title : 'Board'}</WelcomeScreen.Center.Heading>
                <div className="welcome-hints">
                  <p>Drop photos anywhere, or paste an image or a link. Hold one picture over another to make a board.</p>
                  <p>Press N for a note. Press Draw for shapes, arrows and the pen. Library has notes, sections and layouts to drag in.</p>
                  <p>Select something for Move, Group, Palette and Style; select a few to Arrange them.</p>
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
          const bid = e.customData.boardId;
          const linked = !!e.customData.linked || cardCount[bid] > 1;
          return <div key={e.id} className={'bcard' + (linked ? ' linked' : '') + (held ? (stackOn.armed ? ' armed' : ' near') : '')} style={{ left: r.left, top: r.top, width: r.width, height: r.height }}>
            <div className={'bcard-img' + (info.updating ? ' updating' : '')} style={info.thumb ? { backgroundImage: 'url("' + info.thumb.replace(/"/g, '%22') + '")', backgroundColor: (info.bg || BG) } : null}>{!info.thumb && <span>▦</span>}{info.updating && <i className="bcard-loading" aria-label="Updating" />}</div>
            <div className="bcard-foot"><b>{info.title || (e.customData && e.customData.title) || 'Board'}</b>{(info.count != null || linked) && <small>{linked && <span className="bcard-link" title="A link: the same board also shows somewhere else">Linked</span>}{info.count != null && (info.count + ' ' + (info.count === 1 ? 'item' : 'items'))}</small>}</div>
            {held && <div className="bcard-drop">{stackOn.armed ? 'Let go to put it in' : ''}</div>}
          </div>;
        })}</div>}
        {store.canEdit && api && fmt && (() => {
          // the bar over a note you're typing in: style the words you've selected
          const n = api.getSceneElements().find(e => e.id === fmt.id);
          if (!n) return null;
          const st = api.getAppState();
          const r = rectOf(n);
          const left = Math.max(110, Math.min(r.left + r.width / 2, st.width - 110));
          const top = r.top - 52 > 8 ? r.top - 52 : Math.min(r.top + r.height + 12, st.height - 56);
          const B = (k, label, tip, cls) => <button key={k} className={cls + (fmtOn[k] ? ' on' : '')} title={tip}
            onPointerDown={e => { e.preventDefault(); e.stopPropagation(); }} onMouseDown={e => e.preventDefault()} onClick={() => fmtPress(k)}>{label}</button>;
          return (
            <div className="selbar fmtbar" style={{ left, top }} onPointerDown={e => e.stopPropagation()}>
              {B('b', 'B', 'Bold (Ctrl+B)', 'fmtk fmt-b')}
              {B('i', 'I', 'Italic (Ctrl+I)', 'fmtk fmt-i')}
              {B('u', 'U', 'Underline (Ctrl+U)', 'fmtk fmt-u')}
              {B('s', 'S', 'Strikethrough (Ctrl+Shift+X)', 'fmtk fmt-s')}
              <button className="fmt-done" onPointerDown={e => { e.preventDefault(); e.stopPropagation(); }} onMouseDown={e => e.preventDefault()} onClick={fmtDone}>Done</button>
            </div>
          );
        })()}
        {store.canEdit && api && sel.count > 0 && !sel.busy && !fmt && !moving && !stackOn && !backHot && (() => {
          const st = api.getAppState();
          const picked = api.getSceneElements().filter(e => st.selectedElementIds && st.selectedElementIds[e.id] && !e.containerId);
          if (!picked.length) return null;
          const rs = picked.map(e => rectOf(e));
          // a selected section's own name sits above it, so the bar sits above the name
          const L = Math.min(...rs.map(r => r.left)), T = Math.min(...rs.map((r, i) => r.top - (picked[i].type === 'frame' ? 22 : 0)));
          const Rt = Math.max(...rs.map(r => r.left + r.width)), B = Math.max(...rs.map(r => r.top + r.height));
          const left = Math.max(12, Math.min((L + Rt) / 2, st.width - 12));
          // Above or below, whichever covers less of what's on the board
          // (section names included). Above wins a tie.
          const w = (selbarRef.current && selbarRef.current.offsetWidth) || 360;
          const above = T - 52, below = B + 12;
          const others = api.getSceneElements().filter(e => !e.isDeleted && !e.containerId && !(st.selectedElementIds && st.selectedElementIds[e.id]))
            .map(e => { const r = rectOf(e); return e.type === 'frame' ? { left: r.left, top: r.top - 22, width: Math.min(r.width, 200), height: 22 } : r; });
          const cover = (y) => { const x0 = left - w / 2, x1 = left + w / 2, y1 = y + 40; let a = 0;
            for (const r of others) { const ox = Math.min(x1, r.left + r.width) - Math.max(x0, r.left), oy = Math.min(y1, r.top + r.height) - Math.max(y, r.top); if (ox > 0 && oy > 0) a += ox * oy; }
            return a; };
          const fitsAbove = above > 8, fitsBelow = below + 40 < st.height - 8;
          const top = fitsAbove && (!fitsBelow || cover(above) <= cover(below)) ? above
            : fitsBelow ? below : Math.min(Math.max(below, 8), st.height - 56);
          return (
            <div className="selbar" ref={selbarRef} style={{ left, top }} onPointerDown={e => e.stopPropagation()}>
              {sel.notes && <span className="selbar-swatches">{NOTE_COLOURS.map(c => <button key={c.hex} title={c.name} style={{ background: c.hex }} onClick={() => recolourNotes(c.hex)} />)}</span>}
              {sel.notes && <span className="selbar-fmt" title="Style the whole note. Double-click a note to style single words.">
                <button className="fmtk fmt-b" onClick={() => styleNotes('b')} title="Bold, the whole note">B</button>
                <button className="fmtk fmt-i" onClick={() => styleNotes('i')} title="Italic, the whole note">I</button>
                <button className="fmtk fmt-u" onClick={() => styleNotes('u')} title="Underline, the whole note">U</button>
                <button className="fmtk fmt-s" onClick={() => styleNotes('s')} title="Strikethrough, the whole note">S</button>
              </span>}
              {sel.notes && sel.units === 1 && <button className="fmtk fmt-aa" onClick={typeInNote} title="Type in this note, and style any word">Aa</button>}
              {sel.card && <button className="selbar-open" onClick={() => openCard(sel.card)} title="Open this board (or double-click it)"><Ico d="M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6" />Open</button>}
              {sel.card && <button onClick={copyLink} title="Copy a link to this board: paste it on any board to show the same board there (copy or duplicate makes a separate board)"><Ico d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />Copy link</button>}
              {sel.style && inHost && <button className="selbar-open" onClick={() => tellHost('boards:open-style', { styleId: sel.style })} title="Open this style in the line list"><Ico d="M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6" />Open style</button>}
              <button onClick={() => setMoving(true)} title="Move to another board"><Ico d="M4 7h7l2 2h7v10H4z M12 14h6 M15 11l3 3-3 3" />Move</button>
              {sel.units > 1 && <span className="pop-wrap">
                <button className={panel === 'arrange' ? 'on' : ''} onClick={() => setPanel(panel === 'arrange' ? null : 'arrange')} title="Tidy the selection"><Ico d="M4 4h7v7H4z M13 4h7v4h-7z M13 10h7v10h-7z M4 13h7v7H4z" />Arrange</button>
                {panel === 'arrange' && (
                  <div className="pop list">
                    <button onClick={() => doArrange('masonry')}>Moodboard<small>pictures in even columns</small></button>
                    <button onClick={() => doArrange('grid')}>Grid</button>
                    <button onClick={() => doArrange('column')}>Column</button>
                    <button onClick={() => doArrange('row')}>Row</button>
                  </div>
                )}
              </span>}
              <button onClick={doFrame} title="Group the selection in a named section"><Ico d="M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4" />Group</button>
              {sel.oneImage && <button onClick={doPalette} title="Pull a colour palette from this picture"><Ico d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.6 0-1.3-1-1.4-1-2.6 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z M7.5 11.5h.01 M10 7.5h.01 M14.5 7.5h.01" />Palette</button>}
              <button className={drawing ? 'on' : ''} onClick={() => setDrawing(d => !d)} title={drawing ? 'Hide the style tools' : 'Stroke, fill, text size and layers'}><Ico d="M4 20h16 M7 16l9-9 3 3-9 9H7z" />{drawing ? 'Hide style' : 'Style'}</button>
              <button onClick={doDelete} title="Delete (you can undo)"><Ico d="M5 7h14 M9 7V4h6v3 M7 7l1 13h8l1-13" /></button>
            </div>
          );
        })()}
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
        {finding && api && <FindPanel api={api} onClose={() => setFinding(false)} />}
        {asking && <NameBox title={asking.title} initial={asking.initial} onDone={v => { const d = asking.done; setAsking(null); d(v); }} />}
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
      {panel === 'newboard' && <NewBoard parentId={boardId} onClose={() => setPanel(null)} onCreated={placeNewKid} />}
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
      {list && list.length > 0 && <div className="pop-label">Or link a board (the same board, shown here too)</div>}
      <div className="pop-scroll">{(list || []).map(b => <button key={b.id} onClick={() => onPick(b)}>{b.title}</button>)}</div>
    </div>
  );
}
