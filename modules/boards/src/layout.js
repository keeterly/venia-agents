// Tidy a selection into a grid, a moodboard (masonry), a column or a row.
// A "unit" is whatever moves together: a grouped set, a frame with its
// contents, or a shape with its label.
import { getCommonBounds, newElementWith } from '@excalidraw/excalidraw';

const GAP = 24;

export function selectionUnits(elements, selectedIds) {
  const live = elements.filter(e => !e.isDeleted);
  const byId = new Map(live.map(e => [e.id, e]));
  const picked = live.filter(e => selectedIds[e.id] && !e.containerId);
  const units = new Map();
  for (const e of picked) {
    if (e.frameId && selectedIds[e.frameId]) continue;           // travels with its frame
    const key = e.groupIds && e.groupIds.length ? 'g:' + e.groupIds[e.groupIds.length - 1] : 'e:' + e.id;
    if (!units.has(key)) units.set(key, new Set());
    units.get(key).add(e.id);
  }
  // add labels, and frame contents
  const out = [];
  for (const ids of units.values()) {
    for (const id of [...ids]) {
      const el = byId.get(id);
      (el.boundElements || []).forEach(b => { if (b.type === 'text') ids.add(b.id); });
      if (el.type === 'frame' || el.type === 'magicframe') live.forEach(c => { if (c.frameId === el.id) { ids.add(c.id); (c.boundElements || []).forEach(b => { if (b.type === 'text') ids.add(b.id); }); } });
    }
    const members = [...ids].map(id => byId.get(id)).filter(Boolean);
    if (!members.length) continue;
    const [x1, y1, x2, y2] = getCommonBounds(members);
    out.push({ members, x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
  }
  return out.sort((a, b) => (Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x));
}

// Returns the full elements array with the selection rearranged.
export function arrange(elements, selectedIds, mode) {
  const units = selectionUnits(elements, selectedIds);
  if (units.length < 2) return null;
  const ox = Math.min(...units.map(u => u.x)), oy = Math.min(...units.map(u => u.y));
  const moves = new Map();   // id -> {dx, dy, scale, ux, uy}
  const place = (u, x, y, scale = 1) => u.members.forEach(m => moves.set(m.id, { dx: x - u.x, dy: y - u.y, scale, ux: u.x, uy: u.y }));

  if (mode === 'column' || mode === 'row') {
    let cur = mode === 'column' ? oy : ox;
    for (const u of units) {
      if (mode === 'column') { place(u, ox, cur); cur += u.h + GAP; }
      else { place(u, cur, oy); cur += u.w + GAP; }
    }
  } else if (mode === 'grid') {
    const cols = Math.ceil(Math.sqrt(units.length));
    const cw = Math.max(...units.map(u => u.w));
    let y = oy;
    for (let r = 0; r < units.length; r += cols) {
      const row = units.slice(r, r + cols);
      const rh = Math.max(...row.map(u => u.h));
      row.forEach((u, i) => place(u, ox + i * (cw + GAP) + (cw - u.w) / 2, y + (rh - u.h) / 2));
      y += rh + GAP;
    }
  } else if (mode === 'masonry') {
    // The moodboard look: equal-width columns, pictures scaled to the column,
    // each dropped into whichever column is shortest.
    const cols = Math.max(2, Math.min(5, Math.round(Math.sqrt(units.length * 1.2))));
    const widths = units.map(u => u.w).sort((a, b) => a - b);
    const W = Math.max(160, Math.min(420, widths[Math.floor(widths.length / 2)]));
    const heights = new Array(cols).fill(oy);
    for (const u of units) {
      const lone = u.members.length === 1 && u.members[0].type === 'image';
      const s = lone ? W / u.w : 1;
      const h = u.h * s;
      let c = 0; for (let i = 1; i < cols; i++) if (heights[i] < heights[c] - 1) c = i;
      const colX = ox + c * (W + GAP);
      place(u, colX + (lone ? 0 : Math.max(0, (W - u.w) / 2)), heights[c], s);
      heights[c] += h + GAP;
    }
  }
  return elements.map(e => {
    const m = moves.get(e.id);
    if (!m) return e;
    if (m.scale !== 1) {
      return newElementWith(e, { x: m.ux + m.dx, y: m.uy + m.dy, width: e.width * m.scale, height: e.height * m.scale });
    }
    return newElementWith(e, { x: e.x + m.dx, y: e.y + m.dy });
  });
}
