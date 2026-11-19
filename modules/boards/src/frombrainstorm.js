// Brainstorm's maps, kept as boards (Build 663).
//
// Brainstorm used to draw three canvases in its own Canvas tab: the
// Everything map of all goals, the old free board, and Enigma's grouping of
// loose notes. The old free board already came across as LEGACY_ID. This
// adds the other two as ordinary boards with fixed ids, so each is made once
// and then belongs to whoever edits it:
//   - b-brainstorm-goals:  a column per open goal, its open steps as notes
//   - b-brainstorm-groups: a column per group, the notes in it
// Each time Boards opens, goals, steps and notes added in Brainstorm since
// are added to the board. Nothing on a board is ever moved out, changed or
// removed by this, and nothing in Brainstorm is touched: Boards only reads it.
import { note, heading, NOTE_COLOURS, countItems } from './elements.js';
import { newColumn, restack } from './columns.js';
import { store } from './store.js';

export const GOALS_ID = 'b-brainstorm-goals';
export const GROUPS_ID = 'b-brainstorm-groups';
export const FROM_BRAINSTORM = [
  { id: GOALS_ID, blurb: 'A column per goal, its open steps as notes' },
  { id: 'b-brainstorm-board', blurb: 'Brainstorm\'s old board, brought across' },
  { id: GROUPS_ID, blurb: 'Enigma\'s grouping of loose notes' },
];

const DARK = '#161616';
const firstLine = (t) => String(t || '').split('\n')[0].trim();
const isGoal = (d) => d && Array.isArray(d.children);
const fmtDue = (d) => { try { return new Date(d + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch (e) { return d; } };

// Tag every element of a note so the next sync knows it's there.
function tagged(els, bs) { return els.map(e => ({ ...e, customData: { ...(e.customData || {}), bs } })); }
function inColumn(els, col) { return els.map(e => ({ ...e, frameId: col.id })); }
function colWith(x, name, bs) { const c = newColumn(x, 0.5, name.slice(0, 60)); return { ...c, customData: { ...c.customData, bs } }; }
function noteH(text) { return Math.max(70, 34 + Math.ceil(String(text).length / 22) * 24); }

// What a board should hold: [{ bs, column: {bs, name} | null, text, colour }]
function goalsPlan(dump) {
  const out = [];
  dump.filter(d => isGoal(d) && !d.done).forEach(g => {
    const name = firstLine(g.t) || 'Goal';
    const col = { bs: 'goal:' + g.id, name: name + (g.due ? ' · due ' + fmtDue(g.due) : '') };
    const open = g.children.filter(c => c && !c.done && String(c.t || '').trim());
    if (!open.length) out.push({ bs: 'goal-done:' + g.id, column: col, text: 'Every step is done', colour: NOTE_COLOURS[1].hex });
    open.forEach(c => out.push({ bs: 'step:' + g.id + ':' + c.id, column: col, text: String(c.t).trim(), colour: NOTE_COLOURS[0].hex }));
  });
  return out;
}
function groupsPlan(dump, map) {
  const byId = new Map(dump.filter(d => d && !isGoal(d)).map(d => [d.id, d]));
  const seen = new Set(), out = [];
  (map && Array.isArray(map.groups) ? map.groups : []).forEach((g) => {
    // Keyed by the group's name, so Enigma regrouping or reordering doesn't
    // make a second column; only a renamed group gets a new one.
    const col = { bs: 'group:' + String(g.title || 'Notes').trim().toLowerCase(), name: String(g.title || 'Notes') };
    (g.ids || []).forEach(id => {
      const d = byId.get(id); if (!d || d.done || seen.has(id)) return;
      seen.add(id);
      out.push({ bs: 'note:' + id, column: col, text: String(d.t || '').trim(), colour: d.color || NOTE_COLOURS[0].hex });
    });
  });
  const loose = [...byId.values()].filter(d => !d.done && !seen.has(d.id) && String(d.t || '').trim());
  loose.forEach(d => out.push({ bs: 'note:' + d.id, column: { bs: 'ungrouped', name: 'Not grouped yet' }, text: String(d.t).trim(), colour: d.color || NOTE_COLOURS[0].hex }));
  return out;
}

// Add whatever in the plan isn't on the board yet. Returns null when nothing
// is missing, or the new elements array.
export function addMissing(elements, plan, title) {
  const live = (elements || []).filter(e => !e.isDeleted);
  const have = new Set();
  // A tag counts as there even if someone deleted it on the board: what they
  // took off stays off.
  (elements || []).forEach(e => { if (e.customData && e.customData.bs) have.add(e.customData.bs); });
  const missing = plan.filter(p => !have.has(p.bs));
  if (!missing.length) return null;
  const add = [], newCols = [];
  if (!live.length && title) add.push(...heading(0.5, -110, title, 40).map(e => ({ ...e, customData: { kind: 'title', bs: 'title' } })));
  // Columns sit side by side; a new one goes to the right of everything.
  const cols = new Map(live.filter(e => e.type === 'frame' && e.customData && e.customData.bs).map(e => [e.customData.bs, e]));
  let right = live.length ? Math.max(...live.map(e => e.x + (e.width || 0))) + 40 : 0.5;
  for (const p of missing) {
    let col = p.column ? cols.get(p.column.bs) : null;
    if (p.column && !col && !have.has(p.column.bs)) {
      col = colWith(right, p.column.name, p.column.bs);
      right += 340;
      cols.set(p.column.bs, col);
      newCols.push(col);   // frames go before what's in them, as Board does
    }
    // A column someone deleted: its new notes go loose beside the board.
    const y = col ? col.y + col.height + 20 : 0.5;
    const els = tagged(note(col ? col.x + 16 : right, y, p.text.slice(0, 400), p.colour, 268, noteH(p.text)), p.bs);
    add.push(...(col ? inColumn(els, col) : els));
    if (!col) right += 300;
  }
  const all = [...newCols, ...(elements || []), ...add];
  return restack(all) || all;
}

export function planFor(id, data) {
  const dump = Array.isArray(data && data.dump) ? data.dump : [];
  if (id === GOALS_ID) return { title: 'Everything: all goals', plan: goalsPlan(dump) };
  if (id === GROUPS_ID) return { title: 'Loose notes, grouped', plan: groupsPlan(dump, data && data.dumpMap) };
  return null;
}

// Make the two boards the first time, and add what's new to them after.
// Only for people who can edit Boards; never for a board in the Trash or one
// deleted for good. Runs at most once per tab.
let ran = false;
export async function syncFromBrainstorm(boards) {
  if (ran || store.mode !== 'cloud' || store.role === 'viewer') return false;
  ran = true;
  let data;
  try { data = await store.brainstormData(); } catch (e) { return false; }
  if (!data) return false;
  let changed = false;
  let trashed = null;
  for (const id of [GOALS_ID, GROUPS_ID]) {
    try {
      const { title, plan } = planFor(id, data);
      const there = boards.find(b => b.id === id);
      if (!there) {
        if (!plan.length) continue;
        // Grouped notes come from Enigma's grouping; without one there's nothing to map.
        if (id === GROUPS_ID && !(data.dumpMap && Array.isArray(data.dumpMap.groups) && data.dumpMap.groups.length)) continue;
        if (!trashed) trashed = await store.listBoards({ trash: true });
        if (trashed.some(b => b.id === id)) continue;
        if (await store.wasPurged(id)) continue;
        const elements = addMissing([], plan, title);
        // Brainstorm is shared across the brand, so these start shared too.
        await store.createBoard({ id, title, scene: { elements, appState: {} }, everyone: 'edit' });
        changed = true;
      } else {
        const row = await store.loadBoard(id);
        if (!row || !row.scene) continue;
        const next = addMissing(row.scene.elements || [], plan, null);
        if (!next) continue;
        const res = await store.saveScene(id, { ...row.scene, elements: next }, row.rev || 0, { item_count: countItems(next) });
        if (!res.conflict) changed = true;   // someone saved meanwhile: try next time
      }
    } catch (e) { /* a board that can't be made or saved now is tried next time */ }
  }
  return changed;
}
