// Columns, the Milanote way: a named frame that keeps whatever you drop into
// it stacked top to bottom, in the order you put it. Drag a card in and the
// column makes room; drag it out and the gap closes; the column grows and
// shrinks to fit.
//
// A column is an Excalidraw frame with customData.kind = 'column', so
// Excalidraw already does the hard part (an element dropped on a frame joins
// it, one dragged off leaves). We only re-stack once nothing is moving.
import { convertToExcalidrawElements, getCommonBounds, newElementWith } from '@excalidraw/excalidraw';

const PAD = 16, GAP = 14, MIN_W = 300, MIN_H = 120;

export function newColumn(x, y, name = 'Column') {
  const [f] = convertToExcalidrawElements([{ type: 'frame', x: x || 0.5, y: y || 0.5, width: MIN_W, height: MIN_H, name, children: [] }]);
  return { ...f, customData: { kind: 'column' } };
}

export const isColumn = (e) => e && e.type === 'frame' && !e.isDeleted && e.customData && e.customData.kind === 'column';

// What moves as one inside a column: a group, or a shape with its label.
function unitsIn(col, live) {
  const inside = live.filter(e => e.frameId === col.id && !e.containerId);
  const units = new Map();
  for (const e of inside) {
    const key = e.groupIds && e.groupIds.length ? 'g:' + e.groupIds[e.groupIds.length - 1] : 'e:' + e.id;
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(e);
  }
  const byId = new Map(live.map(e => [e.id, e]));
  return [...units.values()].map(members => {
    const all = [...members];
    members.forEach(m => (m.boundElements || []).forEach(b => { if (b.type === 'text' && byId.get(b.id)) all.push(byId.get(b.id)); }));
    const [x1, y1, x2, y2] = getCommonBounds(all);
    return { members: all, x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }).sort((a, b) => a.y - b.y || a.x - b.x);
}

// Returns the new elements array, or null when every column is already tidy.
export function restack(elements) {
  const live = elements.filter(e => !e.isDeleted);
  const cols = live.filter(isColumn);
  if (!cols.length) return null;
  const moves = new Map();   // id -> {x, y} or {width, height}
  for (const col of cols) {
    const units = unitsIn(col, live);
    const w = Math.max(MIN_W, ...units.map(u => u.w + PAD * 2));
    let y = col.y + PAD;   // the column's name sits above it
    for (const u of units) {
      const dx = col.x + PAD - u.x, dy = y - u.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) u.members.forEach(m => moves.set(m.id, { x: m.x + dx, y: m.y + dy }));
      y += u.h + GAP;
    }
    const h = Math.max(MIN_H, y - col.y + PAD - GAP);
    if (Math.abs(col.width - w) > 0.5 || Math.abs(col.height - h) > 0.5) moves.set(col.id, { width: w, height: h });
  }
  if (!moves.size) return null;
  return elements.map(e => moves.has(e.id) ? newElementWith(e, moves.get(e.id)) : e);
}
