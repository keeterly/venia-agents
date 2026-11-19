// Building blocks placed on a board: notes, board cards, palettes, frames,
// and the starting layouts (templates).
import { convertToExcalidrawElements, FONT_FAMILY, getCommonBounds } from '@excalidraw/excalidraw';
import { readableOn } from './images.js';

export const NOTE_COLOURS = [
  { name: 'Paper', hex: '#F1ECE2' },
  { name: 'Stone', hex: '#E3E0D9' },
  { name: 'Clay', hex: '#E8D6CB' },
  { name: 'Sage', hex: '#DAE0D3' },
  { name: 'Mist', hex: '#D8DEE4' },
  { name: 'Ink', hex: '#161616' },
];

const SANS = FONT_FAMILY.Helvetica;
const base = { roughness: 0, strokeWidth: 1, roundness: null, fillStyle: 'solid' };
const gid = () => 'g' + Math.random().toString(36).slice(2, 10);

export function note(x, y, text = 'New note', colour = NOTE_COLOURS[0].hex, w = 220, h = 160) {
  return convertToExcalidrawElements([{
    ...base, type: 'rectangle', x, y, width: w, height: h,
    backgroundColor: colour, strokeColor: colour === '#161616' ? '#161616' : '#d9d3c7',
    customData: { kind: 'note' },
    label: { text, fontSize: 16, fontFamily: SANS, textAlign: 'left', verticalAlign: 'top', strokeColor: readableOn(colour) },
  }]);
}

// A card that opens another board. The link is handled inside the module, so
// it works the same in VENIA OS, on its own at /boards, and when licensed.
export function boardCard(x, y, board) {
  return convertToExcalidrawElements([{
    ...base, type: 'rectangle', x, y, width: 240, height: 150,
    backgroundColor: '#161616', strokeColor: '#161616',
    customData: { kind: 'board', boardId: board.id, title: board.title },
    label: { text: '▦  ' + board.title, fontSize: 18, fontFamily: SANS, textAlign: 'left', verticalAlign: 'bottom', strokeColor: '#ffffff' },
  }]);
}

export function heading(x, y, text, size = 36) {
  return convertToExcalidrawElements([{ type: 'text', x, y, text, fontSize: size, fontFamily: SANS, strokeColor: '#111111' }]);
}

// Swatches under (or beside) a picture, grouped so they move as one.
export function paletteRow(x, y, colours) {
  const g = gid(), S = 64, GAP = 10, out = [];
  colours.forEach((hex, i) => {
    const sx = x + i * (S + GAP);
    out.push({ ...base, type: 'rectangle', x: sx, y, width: S, height: S, backgroundColor: hex, strokeColor: '#00000022', groupIds: [g], customData: { kind: 'swatch', hex } });
    out.push({ type: 'text', x: sx, y: y + S + 6, text: hex.toUpperCase(), fontSize: 11, fontFamily: FONT_FAMILY.Cascadia, strokeColor: '#595959', groupIds: [g] });
  });
  return convertToExcalidrawElements(out);
}

// How many things a person would say are on a board: a palette, a group or a
// labelled note is one thing; the sections and title a template starts with
// are the board's layout, not things on it.
export function countItems(elements) {
  const live = elements.filter(e => e && !e.isDeleted && !e.containerId && e.type !== 'frame' && !(e.customData && e.customData.kind === 'title'));
  return new Set(live.map(e => e.groupIds && e.groupIds.length ? 'g' + e.groupIds[e.groupIds.length - 1] : e.id)).size;
}

// A titled frame around whatever is selected.
export function frameAround(members, name = 'Group') {
  const [x1, y1, x2, y2] = getCommonBounds(members);
  const P = 32;
  // Children are attached by the caller (they're already on the canvas; the
  // converter only knows elements passed to it). x/y of exactly 0 would be
  // read as "work it out" by the converter, hence the nudge.
  return convertToExcalidrawElements([{ type: 'frame', x: (x1 - P) || 0.5, y: (y1 - P) || 0.5, width: x2 - x1 + P * 2, height: y2 - y1 + P * 2, name, children: [] }]);
}

// Templates start at (O, O): the converter treats a frame at 0 as "size me
// from my children", which an empty frame can't answer.
const O = 40;
function frame(x, y, w, h, name) {
  return { type: 'frame', x: x + O, y: y + O, width: w, height: h, name, children: [] };
}

// ── templates ──────────────────────────────────────────────────────────────
export const TEMPLATES = [
  { id: 'blank', name: 'Blank', blurb: 'An empty canvas.' },
  { id: 'moodboard', name: 'Moodboard', blurb: 'Mood, colour, material, silhouette and notes.' },
  { id: 'collection', name: 'Collection plan', blurb: 'A column per category, a row of notes per look.' },
  { id: 'brainstorm', name: 'Brainstorm', blurb: 'A central idea with room to branch.' },
  { id: 'shoot', name: 'Shoot plan', blurb: 'Concept, references, location, casting, shot list.' },
];

export function templateElements(id) {
  if (id === 'moodboard') {
    return convertToExcalidrawElements([
      { type: 'text', customData: { kind: 'title' }, x: 0, y: -90, text: 'Moodboard', fontSize: 40, fontFamily: SANS, strokeColor: '#111111' },
      frame(0, 0, 760, 560, 'Mood'),
      frame(800, 0, 420, 260, 'Colour'),
      frame(800, 300, 420, 260, 'Material'),
      frame(0, 600, 760, 420, 'Silhouette'),
      frame(800, 600, 420, 420, 'Notes'),
      { ...base, type: 'rectangle', x: 830 + O, y: 640 + O, width: 360, height: 140, backgroundColor: '#F1ECE2', strokeColor: '#d9d3c7', label: { text: 'What is this collection about, in one line?', fontSize: 16, fontFamily: SANS, textAlign: 'left', verticalAlign: 'top', strokeColor: '#111111' } },
    ]);
  }
  if (id === 'collection') {
    const cats = ['Outerwear', 'Tops', 'Bottoms', 'Dresses', 'Accessories'];
    const out = [{ type: 'text', customData: { kind: 'title' }, x: 0, y: -90, text: 'Collection plan', fontSize: 40, fontFamily: SANS, strokeColor: '#111111' }];
    cats.forEach((c, i) => {
      out.push(frame(i * 300, 0, 280, 900, c));
      out.push({ ...base, type: 'rectangle', x: i * 300 + 20 + O, y: 30 + O, width: 240, height: 120, backgroundColor: '#F1ECE2', strokeColor: '#d9d3c7', label: { text: 'Look ' + (i + 1), fontSize: 16, fontFamily: SANS, textAlign: 'left', verticalAlign: 'top', strokeColor: '#111111' } });
    });
    return convertToExcalidrawElements(out);
  }
  if (id === 'brainstorm') {
    const out = [{ ...base, type: 'ellipse', id: 'core', x: 0, y: 0, width: 280, height: 160, backgroundColor: '#161616', strokeColor: '#161616', label: { text: 'The idea', fontSize: 22, fontFamily: SANS, strokeColor: '#ffffff' } }];
    const spots = [[-420, -220], [420, -220], [-460, 160], [460, 160], [0, 320]];
    spots.forEach(([dx, dy], i) => {
      const id = 'n' + i;
      out.push({ ...base, type: 'rectangle', id, x: 60 + dx, y: 20 + dy, width: 200, height: 120, backgroundColor: NOTE_COLOURS[i % 4].hex, strokeColor: '#d9d3c7', label: { text: 'Idea', fontSize: 16, fontFamily: SANS, textAlign: 'left', verticalAlign: 'top', strokeColor: '#111111' } });
      out.push({ type: 'arrow', x: 140, y: 80, strokeColor: '#8a8a8a', roughness: 0, start: { id: 'core' }, end: { id } });
    });
    return convertToExcalidrawElements(out);
  }
  if (id === 'shoot') {
    const names = ['Concept', 'References', 'Location', 'Casting', 'Hair & make-up', 'Shot list'];
    const out = [{ type: 'text', customData: { kind: 'title' }, x: 0, y: -90, text: 'Shoot plan', fontSize: 40, fontFamily: SANS, strokeColor: '#111111' }];
    names.forEach((n, i) => out.push(frame((i % 3) * 520, Math.floor(i / 3) * 460, 500, 440, n)));
    return convertToExcalidrawElements(out);
  }
  return [];
}

// ── the old Brainstorm Board, brought across ───────────────────────────────
// Notes stay notes (same colour), goals become dark notes with their title,
// photos are fetched and placed as images by the caller (they need bytes).
export function legacyCardElements(card) {
  const x = Number(card.x) || 0, y = Number(card.y) || 0;
  const tag = { legacyId: card.id };
  let els;
  if (card.kind === 'goal') els = note(x, y, 'Goal: ' + (card.goalTitle || 'untitled'), '#161616', 200, 110);
  else els = note(x, y, String(card.text || ''), card.color || NOTE_COLOURS[0].hex, 200, Math.max(90, 40 + Math.ceil(String(card.text || '').length / 24) * 22));
  return els.map(e => e.type === 'rectangle' ? { ...e, customData: { ...(e.customData || {}), ...tag } } : e);
}
