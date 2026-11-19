// Finger controls on phones and tablets (Build 656), the way Milanote and
// Miro work:
//   one finger on an empty spot drags the board around (not a selection box)
//   two fingers pinch to zoom, wherever they land
//   press and hold an empty spot, then drag, to select everything in a box
//   a tap on an empty spot clears the selection
// A finger that lands on something (a note, a photo, a handle) is left to the
// board as before: tap to select, drag to move, double tap to type.
// Nothing here changes what is on the board; it only moves the view and
// changes what is selected.
import { useEffect } from 'react';
import { getCommonBounds, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';

const HOLD_MS = 450;
const MOVE_PX = 8;

export function useTouchCanvas(api, wrapRef) {
  useEffect(() => {
    const root = wrapRef.current; if (!root || !api) return;
    const g = { pts: new Map(), mode: null, start: null, base: null, timer: 0, box: null };

    const st = () => api.getAppState();
    const scene = (x, y) => viewportCoordsToSceneCoords({ clientX: x, clientY: y }, st());
    const bounds = (e) => { try { return getCommonBounds([e]); } catch (err) { return [e.x, e.y, e.x + e.width, e.y + e.height]; } };

    // Is there something under the finger that the board should handle?
    function hitsSomething(x, y) {
      const s = st(); const z = s.zoom.value; const p = scene(x, y);
      const sel = s.selectedElementIds || {};
      return api.getSceneElements().some(e => {
        if (e.isDeleted) return false;
        const pad = (sel[e.id] ? 22 : 6) / z;   // a selected item's handles sit just outside it
        const [x1, y1, x2, y2] = bounds(e);
        if (e.type === 'frame' || e.type === 'magicframe') {
          // a section is picked by its edge or its name, not its empty inside
          const inBox = p.x >= x1 - pad && p.x <= x2 + pad && p.y >= y1 - pad && p.y <= y2 + pad;
          const edge = inBox && (p.x <= x1 + pad || p.x >= x2 - pad || p.y <= y1 + pad || p.y >= y2 - pad);
          const name = p.x >= x1 && p.x <= x1 + Math.min(x2 - x1, 260 / z) && p.y >= y1 - 30 / z && p.y <= y1;
          return edge || name || (sel[e.id] && inBox);
        }
        return p.x >= x1 - pad && p.x <= x2 + pad && p.y >= y1 - pad && p.y <= y2 + pad;
      });
    }

    const ours = () => g.mode !== null;
    const stop = (e) => { e.stopPropagation(); if (e.cancelable) e.preventDefault(); };
    const two = () => { const [a, b] = [...g.pts.values()]; return { a, b, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; };

    function startPan(x, y) {
      const s = st();
      g.start = { x, y, sx: s.scrollX, sy: s.scrollY, z: s.zoom.value };
    }
    function startPinch() {
      const s = st(); const t = two();
      g.base = { d: t.d, mx: t.mx, my: t.my, z: s.zoom.value, sx: s.scrollX, sy: s.scrollY, ol: s.offsetLeft, ot: s.offsetTop };
    }
    function boxEl() {
      if (!g.box) { g.box = document.createElement('div'); g.box.className = 'touch-box'; root.appendChild(g.box); }
      return g.box;
    }
    function drawBox(x, y) {
      const r = root.getBoundingClientRect(); const b = boxEl();
      const l = Math.min(g.start.x, x) - r.left, t = Math.min(g.start.y, y) - r.top;
      Object.assign(b.style, { left: l + 'px', top: t + 'px', width: Math.abs(x - g.start.x) + 'px', height: Math.abs(y - g.start.y) + 'px' });
    }
    function selectBox(x, y) {
      const a = scene(g.start.x, g.start.y), b = scene(x, y);
      const X1 = Math.min(a.x, b.x), Y1 = Math.min(a.y, b.y), X2 = Math.max(a.x, b.x), Y2 = Math.max(a.y, b.y);
      const all = api.getSceneElements().filter(e => !e.isDeleted);
      const ids = {}, groups = {};
      for (const e of all) {
        if (e.containerId) continue;
        const [x1, y1, x2, y2] = bounds(e);
        if (x1 < X1 || y1 < Y1 || x2 > X2 || y2 > Y2) continue;
        ids[e.id] = true;
        const gid = e.groupIds && e.groupIds.length ? e.groupIds[e.groupIds.length - 1] : null;
        if (gid) { groups[gid] = true; all.forEach(m => { if (m.groupIds && m.groupIds.includes(gid) && !m.containerId) ids[m.id] = true; }); }
      }
      api.updateScene({ appState: { selectedElementIds: ids, selectedGroupIds: groups } });
    }
    function end() {
      clearTimeout(g.timer);
      if (g.box) { g.box.remove(); g.box = null; }
      g.pts.clear(); g.mode = null; g.start = null; g.base = null;
    }

    const down = (e) => {
      if (e.pointerType !== 'touch') return;
      if (ours()) {
        // another finger joins a gesture we already have: pinch
        g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (g.pts.size === 2) { clearTimeout(g.timer); if (g.box) { g.box.remove(); g.box = null; } g.mode = 'pinch'; startPinch(); }
        stop(e); return;
      }
      if (!e.target || !e.target.closest('.excalidraw canvas')) return;
      const s = st();
      if (s.viewModeEnabled || !s.activeTool || s.activeTool.type !== 'selection' || s.editingTextElement || s.newElement) return;
      if (hitsSomething(e.clientX, e.clientY)) return;
      g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      g.mode = 'tap';
      startPan(e.clientX, e.clientY);
      g.timer = setTimeout(() => { if (g.mode === 'tap') { g.mode = 'box'; drawBox(g.start.x, g.start.y); } }, HOLD_MS);
      stop(e);
    };
    const move = (e) => {
      if (!ours() || !g.pts.has(e.pointerId)) return;
      g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g.mode === 'tap' && Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) > MOVE_PX) { clearTimeout(g.timer); g.mode = 'pan'; }
      if (g.mode === 'pan') {
        const k = g.start.z;
        api.updateScene({ appState: { scrollX: g.start.sx + (e.clientX - g.start.x) / k, scrollY: g.start.sy + (e.clientY - g.start.y) / k } });
      } else if (g.mode === 'pinch' && g.pts.size >= 2) {
        const t = two(), b = g.base;
        const z = Math.max(0.1, Math.min(10, b.z * t.d / b.d));
        // keep the point between the fingers under the fingers
        const px = (b.mx - b.ol) / b.z - b.sx, py = (b.my - b.ot) / b.z - b.sy;
        api.updateScene({ appState: { zoom: { value: z }, scrollX: (t.mx - b.ol) / z - px, scrollY: (t.my - b.ot) / z - py } });
      } else if (g.mode === 'box') drawBox(e.clientX, e.clientY);
      stop(e);
    };
    const up = (e) => {
      if (!ours() || !g.pts.has(e.pointerId)) return;
      stop(e);
      const mode = g.mode;
      g.pts.delete(e.pointerId);
      if (mode === 'pinch') {
        if (g.pts.size === 1) { const [p] = [...g.pts.values()]; g.mode = 'pan'; startPan(p.x, p.y); return; }
        if (g.pts.size >= 2) { startPinch(); return; }
      }
      if (g.pts.size) return;
      if (mode === 'tap' && e.type === 'pointerup') api.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} } });
      else if (mode === 'box' && e.type === 'pointerup') selectBox(e.clientX, e.clientY);
      end();
    };
    // The board's own touch handling (double tap makes a text box, a held
    // finger opens its menu) must not run for a gesture that's ours.
    const touch = (e) => { if (ours()) { e.stopPropagation(); if ((e.type === 'touchstart' || e.type === 'contextmenu') && e.cancelable) e.preventDefault(); } };

    root.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    root.addEventListener('touchstart', touch, { capture: true, passive: false });
    root.addEventListener('touchmove', touch, { capture: true, passive: false });
    root.addEventListener('touchend', touch, true);
    root.addEventListener('contextmenu', touch, true);
    return () => {
      end();
      root.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, { capture: true });
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      root.removeEventListener('touchstart', touch, { capture: true });
      root.removeEventListener('touchmove', touch, { capture: true });
      root.removeEventListener('touchend', touch, true);
      root.removeEventListener('contextmenu', touch, true);
    };
  }, [api]);
}
