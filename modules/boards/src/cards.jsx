// Cards that are more than a drawing: to-do lists and link cards.
//
// Both are Excalidraw "embeddable" elements whose look we draw ourselves
// (renderEmbeddable), so they move, resize, group, sit in columns and travel
// with the board like anything else. Their content lives in customData, so it
// saves, syncs and searches with the scene. The link points back at Boards
// itself and is never loaded: it only marks the element as one of ours.
import React, { useEffect, useState } from 'react';
import { convertToExcalidrawElements, newElementWith, restoreElements, CaptureUpdateAction } from '@excalidraw/excalidraw';
import { uid } from './store.js';

const CARD_BASE = '/boards/card/';
export const isCardUrl = (u) => typeof u === 'string' && u.indexOf(CARD_BASE) !== -1;
const cardLink = (kind, id) => (typeof location !== 'undefined' ? location.origin : '') + CARD_BASE + kind + '/' + id;

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

// Words on cards, for search.
export function cardWords(el) {
  const d = el.customData || {};
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
