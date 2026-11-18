// Working on a board together, live.
//
// One private Supabase Realtime channel per board ("board:<id>"; only people
// who can read Boards may join, enforced by policies on realtime.messages).
// Over it go:
//   presence  who's here (name, colour)
//   pointer   where their cursor is, so Excalidraw draws it
//   scene     the elements someone just changed (merged with reconcileElements)
//   comments  "comments changed, re-read them"
// The database stays the record: everyone still saves on their own timer, and
// a save that crossed someone else's merges first. Live only makes the wait
// between seeing each other's work a second instead of twelve.
import { useEffect, useRef, useState } from 'react';
import { reconcileElements, restoreElements, CaptureUpdateAction } from '@excalidraw/excalidraw';
import { store, nameOf } from './store.js';

const COLOURS = ['#C2410C', '#0F766E', '#7C3AED', '#B45309', '#1D4ED8', '#BE185D', '#4D7C0F'];
const colourOf = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLOURS[h % COLOURS.length]; };

export function useLive({ api, boardId, onFilesNeeded, onCommentsChanged }) {
  const [people, setPeople] = useState([]);
  const [on, setOn] = useState(false);
  const L = useRef({ ch: null, sent: new Map(), collaborators: new Map(), timer: null, lastPointer: 0, applying: false });

  useEffect(() => {
    if (!api || store.mode !== 'cloud') return;
    let dead = false;
    const me = { email: store.email, name: nameOf(store.email), color: colourOf(store.email) };
    (async () => {
      const myKey = store.email + ':' + Math.random().toString(36).slice(2, 8);
      const ch = await store.channel(boardId, myKey);
      if (!ch || dead) { store.dropChannel(ch); return; }
      L.current.ch = ch;
      const redrawCollaborators = () => {
        if (dead) return;
        api.updateScene({ collaborators: new Map(L.current.collaborators) });
      };
      ch.on('presence', { event: 'sync' }, () => {
        const st = ch.presenceState();
        const list = [];
        const keys = new Set();
        Object.entries(st).forEach(([key, metas]) => {
          const m = metas && metas[0]; if (!m) return;
          keys.add(key);
          if (key !== myKey) list.push({ key, ...m });
        });
        // forget cursors of people who left
        for (const k of [...L.current.collaborators.keys()]) if (!keys.has(k)) L.current.collaborators.delete(k);
        redrawCollaborators();
        setPeople(list);
      });
      ch.on('broadcast', { event: 'pointer' }, ({ payload }) => {
        if (!payload || !payload.key) return;
        L.current.collaborators.set(payload.key, {
          pointer: { x: payload.x, y: payload.y, tool: 'pointer' }, button: payload.button || 'up',
          username: payload.name, color: { background: payload.color, stroke: payload.color },
          selectedElementIds: payload.selected || {}, id: payload.key,
        });
        redrawCollaborators();
      });
      ch.on('broadcast', { event: 'scene' }, async ({ payload }) => {
        if (!payload || !Array.isArray(payload.elements)) return;
        const remote = restoreElements(payload.elements, null);
        remote.forEach(e => L.current.sent.set(e.id, e.version));
        L.current.applying = true;
        try {
          const merged = reconcileElements(api.getSceneElementsIncludingDeleted(), remote, api.getAppState());
          api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
          const have = new Set(Object.keys(api.getFiles()));
          const need = remote.filter(e => e.type === 'image' && e.fileId && !e.isDeleted && !have.has(e.fileId)).map(e => e.fileId);
          if (need.length && onFilesNeeded) onFilesNeeded(need);
        } finally { L.current.applying = false; }
      });
      ch.on('broadcast', { event: 'comments' }, () => { if (onCommentsChanged) onCommentsChanged(); });
      L.current.myKey = myKey;
      me.key = myKey;
      ch.subscribe(async (status) => {
        if (dead) return;
        if (status === 'SUBSCRIBED') {
          setOn(true);
          try { await ch.track({ email: me.email, name: me.name, color: me.color }); } catch (e) {}
          // what we have now counts as known to everyone (they loaded it too)
          api.getSceneElementsIncludingDeleted().forEach(e => L.current.sent.set(e.id, e.version));
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setOn(false);
      });
      L.current.me = me;
    })();
    return () => {
      dead = true; setOn(false); setPeople([]);
      clearTimeout(L.current.timer);
      store.dropChannel(L.current.ch); L.current.ch = null;
      L.current.collaborators.clear();
    };
  }, [api, boardId]);

  // Send what changed, at most a few times a second.
  function sceneChanged(elements) {
    const l = L.current;
    if (!l.ch || l.applying || !store.canEdit) return;
    if (l.timer) return;
    l.timer = setTimeout(() => {
      l.timer = null;
      if (!l.ch) return;
      const els = api.getSceneElementsIncludingDeleted();
      const changed = els.filter(e => l.sent.get(e.id) !== e.version);
      if (!changed.length) return;
      changed.forEach(e => l.sent.set(e.id, e.version));
      // big pastes go in slices so no one message is too large
      for (let i = 0; i < changed.length; i += 200) {
        l.ch.send({ type: 'broadcast', event: 'scene', payload: { elements: changed.slice(i, i + 200) } });
      }
    }, 120);
  }

  function pointerMoved({ pointer, button }) {
    const l = L.current;
    if (!l.ch || !l.me) return;
    const t = Date.now(); if (t - l.lastPointer < 60) return; l.lastPointer = t;
    const st = api.getAppState();
    l.ch.send({ type: 'broadcast', event: 'pointer', payload: {
      key: l.myKey, name: l.me.name, color: l.me.color, x: pointer.x, y: pointer.y, button, selected: st.selectedElementIds } });
  }

  function commentsChanged() {
    const l = L.current;
    if (l.ch) l.ch.send({ type: 'broadcast', event: 'comments', payload: {} });
  }

  return { on, people, sceneChanged, pointerMoved, commentsChanged };
}
