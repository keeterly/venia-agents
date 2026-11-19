// Cards that are more than a drawing: to-do lists and link cards.
//
// Both are Excalidraw "embeddable" elements whose look we draw ourselves
// (renderEmbeddable), so they move, resize, group, sit in columns and travel
// with the board like anything else. Their content lives in customData, so it
// saves, syncs and searches with the scene. The link points back at Boards
// itself and is never loaded: it only marks the element as one of ours.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { convertToExcalidrawElements, newElementWith, restoreElements, CaptureUpdateAction } from '@excalidraw/excalidraw';
import { uid } from './store.js';
import { readableOn } from './images.js';
import { htmlOf, parasFromDom, plainOf, pointAt, heightFor } from './rich.js';

const CARD_BASE = '/boards/card/';
export const isCardUrl = (u) => typeof u === 'string' && u.indexOf(CARD_BASE) !== -1;
export const cardLink = (kind, id) => (typeof location !== 'undefined' ? location.origin : '') + CARD_BASE + kind + '/' + id;

// Excalidraw has no skeleton for embeddables: draw a rectangle and turn it
// into one, then let restore fill in anything missing.
function embeddable(x, y, w, h, kind, data) {
  const [r] = convertToExcalidrawElements([{ type: 'rectangle', x, y, width: w, height: h, roughness: 0, strokeWidth: 1,
    strokeColor: '#cfcac0', backgroundColor: '#ffffff', fillStyle: 'solid', roundness: null }]);
  return restoreElements([{ ...r, type: 'embeddable', link: cardLink(kind, r.id), customData: { kind, ...data } }], null);
}

// Text about the size of a note's, so a list reads at the same zoom.
export const TODO_W = 320;
const todoHeight = (items) => 66 + Math.max(1, items.length) * 40 + 50;

export function todoCard(x, y, title = 'To do', items = []) {
  const list = items.length ? items : [{ id: uid('t'), t: '', done: false }];
  return embeddable(x, y, TODO_W, todoHeight(list), 'todo', { title, items: list });
}

export function linkCard(x, y, info) {
  const h = info.image ? 290 : 128;
  return embeddable(x, y, 300, h, 'link', {
    url: info.url, title: info.title || '', site: info.site || '', description: info.description || '', image: info.image || '',
  });
}

// A note whose words can be styled one by one (Build 651). It is still a
// note (kind 'note', same colours, same place in Find); it just draws its own
// words. Notes only become one when you style something in them.
export const isRich = (el) => !!(el && el.type === 'embeddable' && el.customData && el.customData.kind === 'note' && el.customData.rich);

// A styled note made from a plain one: the same spot, size, colour, group
// and section. It is a new element (so Undo simply brings the plain note
// back) that remembers the old one's id, so comments pinned to it stay.
export function richFrom(rect, paras) {
  const id = uid('n');
  const { index, ...rest } = rect;
  const [r] = restoreElements([{ ...rest, id, type: 'embeddable', link: cardLink('note', id), isDeleted: false,
    boundElements: (rect.boundElements || []).filter(b => b.type !== 'text'),
    customData: { ...(rect.customData || {}), kind: 'note', rich: true, paras, text: plainOf(paras), was: (rect.customData && rect.customData.was) || rect.id },
    height: Math.max(rect.height, heightFor(paras, rect.width)) }], null);
  return r;
}

// Words on cards, for search.
export function cardWords(el) {
  const d = el.customData || {};
  if (d.kind === 'note' && d.rich) return d.text || plainOf(d.paras);
  if (d.kind === 'todo') return [d.title, ...(d.items || []).map(i => i.t)].join(' ');
  if (d.kind === 'link') return [d.title, d.site, d.description].join(' ');
  return '';
}

// Change one card's data (and height, for lists) as an undoable edit.
function patchCard(api, el, data, height) {
  const cur = api.getSceneElementsIncludingDeleted().find(e => e.id === el.id);
  if (!cur) return;
  const next = newElementWith(cur, { customData: { ...cur.customData, ...data }, ...(height ? { height } : {}) });
  api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map(e => e.id === el.id ? next : e), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
}

export function makeRenderCard(getApi, canEdit) {
  return function renderCard(el) {
    const d = el.customData || {};
    if (!isCardUrl(el.link)) return null;
    if (d.kind === 'todo') return <TodoCard el={el} api={getApi()} canEdit={canEdit} />;
    if (d.kind === 'link') return <LinkCardView el={el} />;
    if (d.kind === 'note' && d.rich) return <RichNote el={el} api={getApi()} canEdit={canEdit} />;
    return null;
  };
}

function TodoCard({ el, api, canEdit }) {
  const d = el.customData;
  const items = d.items || [];
  const [draft, setDraft] = useState('');
  const save = (nextItems, title = d.title) => patchCard(api, el, { items: nextItems, title }, todoHeight(nextItems));
  const done = items.filter(i => i.done && i.t).length, total = items.filter(i => i.t).length;
  // A list made before the text grew is made taller once, so nothing is cut off.
  useEffect(() => {
    if (!api || !canEdit) return;
    const need = todoHeight(items);
    if (el.height + 1 >= need) return;
    const cur = api.getSceneElementsIncludingDeleted().find(e => e.id === el.id);
    if (!cur || cur.isDeleted) return;
    api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map(e => e.id === el.id ? newElementWith(e, { height: need }) : e), captureUpdate: CaptureUpdateAction.NEVER });
  }, [el.id, el.height, items.length]);
  return (
    <div className="card-todo">
      <div className="todo-head">
        <input className="todo-title" onPointerDown={e => e.stopPropagation()} defaultValue={d.title} readOnly={!canEdit} key={d.title}
          onBlur={e => { if (e.target.value !== d.title) save(items, e.target.value); }} onKeyDown={e => e.key === 'Enter' && e.target.blur()} />
        <span className="todo-count">{total ? `${done}/${total}` : ''}</span>
      </div>
      {items.map((it, i) => (
        <label key={it.id} className={'todo-item' + (it.done ? ' done' : '')}>
          <input type="checkbox" checked={!!it.done} disabled={!canEdit} onPointerDown={e => e.stopPropagation()}
            onChange={() => save(items.map(x => x.id === it.id ? { ...x, done: !x.done } : x))} />
          <input className="todo-text" onPointerDown={e => e.stopPropagation()} defaultValue={it.t} readOnly={!canEdit} key={it.id + ':' + it.t} placeholder="Something to do"
            onBlur={e => {
              const t = e.target.value;
              if (t === it.t) return;
              save(t ? items.map(x => x.id === it.id ? { ...x, t } : x) : items.filter(x => x.id !== it.id));
            }}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }} />
        </label>
      ))}
      {canEdit && (
        <input className="todo-add" onPointerDown={e => e.stopPropagation()} placeholder="+ Add an item" value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Enter' || !draft.trim()) return;
            const keep = items.filter(x => x.t);
            save([...keep, { id: uid('t'), t: draft.trim(), done: false }]); setDraft('');
          }} />
      )}
    </div>
  );
}

// A styled note. Shown, it is only a picture of its words (clicks go through
// to the board, so it moves and selects like any note). Double-click, double
// tap or Enter opens it for typing: a small editor where any word can be
// bold, italic, underlined or struck through.
export const RICH_EDIT = 'boards:rich-edit';       // { id, range?, then? }  open a note for typing
export const RICH_EDITING = 'boards:rich-editing'; // { id | null }          which note is open
const KEYS = { b: 'bold', i: 'italic', u: 'underline' };

function RichNote({ el, api, canEdit }) {
  const d = el.customData;
  const box = useRef(null);
  const [editing, setEditing] = useState(null);   // null, or how to start: { range, then }
  const bg = el.backgroundColor || '#F1ECE2';
  const parasKey = JSON.stringify(d.paras || []);
  const shown = useRef(null);     // the words the box shows now
  const pending = useRef(null);   // words just saved, until the board catches up

  // shown words follow the saved ones, except while you type
  useLayoutEffect(() => {
    if (editing || !box.current) return;
    if (pending.current) { if (parasKey !== pending.current) return; pending.current = null; }
    if (shown.current !== parasKey) { box.current.innerHTML = htmlOf(d.paras); shown.current = parasKey; }
  }, [parasKey, !!editing]);

  // the note grows to fit its words, as a plain note does
  useLayoutEffect(() => {
    if (!api || !canEdit || !box.current) return;
    const need = Math.ceil(box.current.offsetHeight);
    if (need <= el.height + 1) return;
    grow(api, el.id, need, CaptureUpdateAction.NEVER);
  });

  useEffect(() => {
    if (!canEdit) return;
    const on = (e) => { if (e.detail && e.detail.id === el.id) setEditing({ range: e.detail.range, then: e.detail.then, ready: e.detail.ready }); };
    window.addEventListener(RICH_EDIT, on);
    return () => window.removeEventListener(RICH_EDIT, on);
  }, [el.id, canEdit]);

  useEffect(() => {
    const ed = box.current; if (!editing || !ed) return;
    // already focused and placed by focusRichNow (a tap on a phone): keep it
    if (!(editing.ready && document.activeElement === ed)) startTyping(ed, editing.range, editing.then);
    window.dispatchEvent(new CustomEvent(RICH_EDITING, { detail: { id: el.id } }));
  }, [editing]);

  const save = (how) => {
    if (!api || !box.current) return null;
    const paras = parasFromDom(box.current);
    const cur = api.getSceneElementsIncludingDeleted().find(e => e.id === el.id);
    if (!cur || cur.isDeleted) return null;
    const need = Math.max(cur.height, Math.ceil(box.current.offsetHeight));
    const same = JSON.stringify(paras) === JSON.stringify(cur.customData.paras || []);
    if (same && need === cur.height) return paras;
    const next = newElementWith(cur, { height: need, ...(same ? {} : { customData: { ...cur.customData, paras, text: plainOf(paras) } }) });
    api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map(e => e.id === el.id ? next : e), captureUpdate: how });
    return paras;
  };
  const done = () => {
    const paras = save(CaptureUpdateAction.IMMEDIATELY);
    // show exactly what was saved (the browser's own editing leaves extra
    // empty lines and wrappers behind)
    if (paras && box.current) { box.current.innerHTML = htmlOf(paras); shown.current = pending.current = JSON.stringify(paras); }
    setEditing(null);
    window.dispatchEvent(new CustomEvent(RICH_EDITING, { detail: { id: null, was: el.id } }));
  };

  return (
    <div className={'card-rich' + (editing ? ' editing' : '')} style={{ background: bg, color: readableOn(bg) }}>
      <div ref={box} className="rich-words" data-note={el.id} contentEditable={!!editing} suppressContentEditableWarning spellCheck={!!editing}
        onPointerDown={e => { if (editing) e.stopPropagation(); }}
        onInput={() => { if (box.current && box.current.offsetHeight > el.height + 1) grow(api, el.id, Math.ceil(box.current.offsetHeight), CaptureUpdateAction.EVENTUALLY); }}
        onBlur={() => { if (editing) done(); }}
        onPaste={e => {   // words only: a pasted style or picture would not save
          e.preventDefault();
          const t = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
          document.execCommand('insertText', false, t);
        }}
        onDrop={e => e.preventDefault()}
        onKeyDown={e => {
          if (!editing) return;
          e.stopPropagation();
          if (e.key === 'Escape') { e.preventDefault(); box.current.blur(); return; }
          const mod = e.metaKey || e.ctrlKey;
          if (!mod) return;
          const k = e.key.toLowerCase();
          if (!e.shiftKey && KEYS[k]) { e.preventDefault(); document.execCommand(KEYS[k]); }
          else if (e.shiftKey && (k === 'x' || k === 's')) { e.preventDefault(); document.execCommand('strikeThrough'); }
        }} />
    </div>
  );
}

// Put the cursor in a styled note: the words in range selected (or the end),
// then one style switched on if asked.
function startTyping(ed, range, then) {
  try { document.execCommand('styleWithCSS', false, false); document.execCommand('defaultParagraphSeparator', false, 'div'); } catch (e) {}
  ed.focus();
  const s = window.getSelection();
  const r = document.createRange();
  if (range) { r.setStart(...pointAt(ed, range[0])); r.setEnd(...pointAt(ed, range[1])); }
  else { r.selectNodeContents(ed); r.collapse(false); }
  s.removeAllRanges(); s.addRange(r);
  if (then) { try { document.execCommand(then); } catch (e) {} }
}

// Open a styled note for typing right now, inside the tap that asked for it.
// Phones only show the keyboard for a box focused during the tap itself, not
// a moment later, so this focuses the note before anything re-renders, then
// tells the note it is open. Returns false if the note isn't on screen.
export function focusRichNow(id, range, then) {
  const ed = typeof document !== 'undefined' && document.querySelector('.rich-words[data-note="' + String(id).replace(/"/g, '') + '"]');
  if (!ed) return false;
  ed.contentEditable = 'true';
  ed.closest('.card-rich') && ed.closest('.card-rich').classList.add('editing');
  startTyping(ed, range, then);
  window.dispatchEvent(new CustomEvent(RICH_EDIT, { detail: { id, ready: true } }));
  return true;
}

function grow(api, id, height, how) {
  if (!api) return;
  const cur = api.getSceneElementsIncludingDeleted().find(e => e.id === id);
  if (!cur || cur.isDeleted || cur.height + 1 >= height) return;
  api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map(e => e.id === id ? newElementWith(e, { height }) : e), captureUpdate: how });
}

// The card itself moves like anything else on the board; only "Open" opens.
function LinkCardView({ el }) {
  const d = el.customData;
  return (
    <div className="card-link">
      {d.image ? <div className="link-img"><img src={d.image} alt="" referrerPolicy="no-referrer" onError={e => { e.currentTarget.parentNode.style.display = 'none'; }} /></div> : null}
      <div className="link-body">
        <div className="link-site">{d.site || hostOf(d.url)}<a className="link-open" href={d.url} target="_blank" rel="noopener noreferrer" onPointerDown={e => e.stopPropagation()}>Open ↗</a></div>
        <div className="link-title">{d.title || d.url}</div>
        {d.description && !d.image ? <div className="link-desc">{d.description}</div> : null}
      </div>
    </div>
  );
}

export function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } }
