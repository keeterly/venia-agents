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

const IDLE_MS = 30000;
const COLOURS = ['#C2410C', '#0F766E', '#7C3AED', '#B45309', '#1D4ED8', '#BE185D', '#4D7C0F'];
const colourOf = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLOURS[h % COLOURS.length]; };
// Everyone on the board gets their own colour. A hash alone gave Keeter and
// Christine the same purple, so colours are handed out in order of the people
// actually here (sorted by email), which every browser works out the same way.
function colourMap(emails) {
  const out = new Map();
  [...new Set(emails.filter(Boolean))].sort().forEach((e, i) => out.set(e, COLOURS[i % COLOURS.length]));
  return out;
}

export function useLive({ api, boardId, onFilesNeeded, onCommentsChanged }) {
  const [people, setPeople] = useState([]);
  const [on, setOn] = useState(false);
  const L = useRef({ ch: null, sent: new Map(), collaborators: new Map(), timer: null, lastPointer: 0, applying: false, seen: new Set(), colours: new Map(), welcome: null });

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
        const emails = [me.email];
        let someoneNew = false;
        Object.entries(st).forEach(([key, metas]) => {
          const m = metas && metas[0]; if (!m) return;
          keys.add(key); emails.push(m.email);
          // Your own other tabs and devices on this board aren't someone else
          // here: they keep the board level with you, but get no face and no
          // cursor, or you'd see your own name moving about.
          if (key !== myKey && m.email !== me.email) {
            list.push({ key, ...m });
            if (!L.current.seen.has(key)) { L.current.seen.add(key); someoneNew = true; }
          }
        });
        const colours = colourMap(emails);
        L.current.colours = colours;
        me.color = colours.get(me.email) || me.color;
        list.forEach(p => { p.color = colours.get(p.email) || p.color; });
        // forget cursors of people who left; recolour the ones still here
        for (const [k, c] of [...L.current.collaborators.entries()]) {
          if (!keys.has(k)) { L.current.collaborators.delete(k); L.current.seen.delete(k); continue; }
          const col = colours.get(c.email); if (col) c.color = { background: col, stroke: col };
        }
        redrawCollaborators();
        setPeople(list);
        // Someone just opened the board. They loaded it from the cloud, which
        // can be a second or two behind what's on screen here, so send them
        // the whole board once and they're level straight away.
        if (someoneNew) { clearTimeout(L.current.welcome); L.current.welcome = setTimeout(() => sendAll(), 250 + Math.random() * 500); }
      });
      ch.on('broadcast', { event: 'pointer' }, ({ payload }) => {
        if (!payload || !payload.key || payload.email === me.email) return;
        const col = (payload.email && L.current.colours.get(payload.email)) || payload.color;
        L.current.collaborators.set(payload.key, {
          pointer: { x: payload.x, y: payload.y, tool: 'pointer' }, button: payload.button || 'up',
          username: payload.name, email: payload.email, color: { background: col, stroke: col },
          selectedElementIds: payload.selected || {}, id: payload.key, at: Date.now(),
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
      // A cursor that hasn't moved for a while is someone who stepped away;
      // it goes until they move again, so a still cursor never looks live.
      L.current.idle = setInterval(() => {
        let gone = false;
        for (const [k, c] of [...L.current.collaborators.entries()]) {
          if (Date.now() - (c.at || 0) > IDLE_MS) { L.current.collaborators.delete(k); gone = true; }
        }
        if (gone) redrawCollaborators();
      }, 5000);
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
      clearTimeout(L.current.timer); clearTimeout(L.current.welcome); clearInterval(L.current.idle);
      L.current.seen.clear();
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

  // The whole board, deleted items included so a delete reaches them too.
  function sendAll() {
    const l = L.current;
    if (!l.ch || !api || !store.canEdit) return;
    const els = api.getSceneElementsIncludingDeleted();
    els.forEach(e => l.sent.set(e.id, e.version));
    for (let i = 0; i < els.length; i += 200) {
      l.ch.send({ type: 'broadcast', event: 'scene', payload: { elements: els.slice(i, i + 200) } });
    }
  }

  function pointerMoved({ pointer, button }) {
    const l = L.current;
    if (!l.ch || !l.me) return;
    const t = Date.now(); if (t - l.lastPointer < 60) return; l.lastPointer = t;
    const st = api.getAppState();
    l.ch.send({ type: 'broadcast', event: 'pointer', payload: {
      key: l.myKey, name: l.me.name, email: l.me.email, color: l.me.color, x: pointer.x, y: pointer.y, button, selected: st.selectedElementIds } });
  }

  function commentsChanged() {
    const l = L.current;
    if (l.ch) l.ch.send({ type: 'broadcast', event: 'comments', payload: {} });
  }

  return { on, people, sceneChanged, pointerMoved, commentsChanged };
}
