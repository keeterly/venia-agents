// Things sent to Boards from another part of VENIA OS (Build 650): styles from
// the line list, or one photo. The shell hands over a plain list through this
// tab's sessionStorage ('boards:import') and opens #/import; nothing here
// reads Product's data. You pick the board, how to group the cards, and
// whether they stay linked to the style or are a one-time copy.
import React, { useEffect, useState } from 'react';
import { store } from './store.js';
import { templateElements } from './elements.js';

const KEY = 'boards:import';
export const pendingKey = (boardId) => 'boards:pending:' + boardId;

export function readImport() {
  try { const v = JSON.parse(sessionStorage.getItem(KEY) || 'null'); return v && Array.isArray(v.items) && v.items.length ? v : null; }
  catch (e) { return null; }
}

const GROUPS = [
  { id: 'category', label: 'Category' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'status', label: 'Stage' },
  { id: 'none', label: 'No sections' },
];

export function ImportSheet({ go }) {
  const [data] = useState(readImport);
  const [boards, setBoards] = useState(null);
  const [target, setTarget] = useState('new');
  const [title, setTitle] = useState(() => (readImport() || {}).title || 'Line list');
  const [groupBy, setGroupBy] = useState('category');
  const [mode, setMode] = useState('linked');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { store.listBoards().then(setBoards).catch(() => setBoards([])); }, []);

  if (!data) return (
    <div className="empty">Nothing waiting to be added. <button className="link" onClick={() => go('/')}>Back to Boards</button></div>
  );
  const styles = data.items.filter(i => i.styleId);
  const n = data.items.length;
  const what = styles.length === n ? (n === 1 ? '1 style' : n + ' styles') : (n === 1 ? '1 photo' : n + ' photos');
  const noPhoto = data.items.filter(i => !i.image).length;

  async function send() {
    if (busy) return;
    if (!store.canEdit) { setErr('You can look at boards here but not change them.'); return; }
    setBusy(true); setErr('');
    try {
      let id = target;
      if (target === 'new') {
        const name = title.trim() || 'Line list';
        const row = await store.createBoard({ title: name, scene: { elements: templateElements('blank', name), appState: {} } });
        id = row.id;
      }
      sessionStorage.setItem(pendingKey(id), JSON.stringify({ items: data.items, groupBy: styles.length > 1 ? groupBy : 'none', linked: mode === 'linked' && styles.length > 0 }));
      sessionStorage.removeItem(KEY);
      go('/b/' + id);
    } catch (e) { setErr('Couldn’t make the board: ' + (e.message || e)); setBusy(false); }
  }

  return (
    <div className="home">
      <div className="modal import-sheet">
        <h2>Add {what} to a board</h2>
        {noPhoto > 0 && <p className="import-note">{noPhoto === 1 ? 'One has' : noPhoto + ' have'} no photo yet, so {noPhoto === 1 ? 'it lands' : 'they land'} as a note.</p>}

        <div className="import-label">Board</div>
        <div className="pick-list import-boards">
          <button className={target === 'new' ? 'on' : ''} onClick={() => setTarget('new')}>
            <b>New board</b>
            {target === 'new' && <input className="field" value={title} onClick={e => e.stopPropagation()} onChange={e => setTitle(e.target.value)} placeholder="Name it" />}
          </button>
          {(boards || []).map(b => (
            <button key={b.id} className={target === b.id ? 'on' : ''} onClick={() => setTarget(b.id)}><b>{b.title || 'Untitled board'}</b></button>
          ))}
          {boards === null && <div className="side-empty">Loading boards…</div>}
        </div>

        {styles.length > 0 && (<>
          <div className="import-label">Cards</div>
          <div className="seg">
            <button className={mode === 'linked' ? 'on' : ''} onClick={() => setMode('linked')}>Linked<small>Stays in step with the style: name, price, stage</small></button>
            <button className={mode === 'copy' ? 'on' : ''} onClick={() => setMode('copy')}>Copy<small>A one-time copy, yours to change</small></button>
          </div>
        </>)}

        {styles.length > 1 && (<>
          <div className="import-label">Sections by</div>
          <div className="seg">
            {GROUPS.map(g => <button key={g.id} className={groupBy === g.id ? 'on' : ''} onClick={() => setGroupBy(g.id)}>{g.label}</button>)}
          </div>
        </>)}

        {err && <div className="note-bar warn">{err}</div>}
        <div className="modal-foot">
          <button className="ghost" onClick={() => { try { sessionStorage.removeItem(KEY); } catch (e) {} go('/'); }}>Cancel</button>
          <button className="solid" disabled={busy || (target === 'new' && !boards)} onClick={send}>{busy ? 'Adding…' : 'Add to board'}</button>
        </div>
      </div>
    </div>
  );
}

const stage = (v) => { v = String(v || ''); return v === 'sms' ? 'SMS' : v.charAt(0).toUpperCase() + v.slice(1); };
// The words on a style's card.
export const styleCaption = (it) => {
  const price = Number(it.retail) > 0 ? '$' + Math.round(Number(it.retail)).toLocaleString('en-US') : '';
  const line2 = [it.colors, price, it.status ? stage(it.status) : ''].filter(Boolean).join(' · ');
  return (it.name || 'Untitled style') + (line2 ? '\n' + line2 : '');
};
export const groupName = (it, by) => {
  if (by === 'none') return '';
  const v = String(it[by] || '').trim();
  if (by === 'status') return v ? stage(v) : 'No stage';
  return v || (by === 'category' ? 'No category' : 'No delivery');
};
// The words on a material's card.
export const materialCaption = (it) => {
  const price = Number(it.cost) > 0 ? '$' + (Math.round(Number(it.cost) * 100) / 100).toLocaleString('en-US') + (it.unit ? '/' + it.unit : '') : '';
  const line2 = [it.content, it.supplier, price].filter(Boolean).join(' · ');
  return (it.name || 'Untitled material') + (line2 ? '\n' + line2 : '');
};
