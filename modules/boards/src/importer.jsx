// Things sent to Boards from another part of VENIA OS (Build 650): styles from
// the line list, or one photo. The shell hands over a plain list through this
// tab's sessionStorage ('boards:import') and opens #/import; nothing here
// reads Product's data. You pick the board, how to group the cards, and
// whether they stay linked to the style or are a one-time copy.
import React, { useEffect, useState } from 'react';
import { store } from './store.js';
import { templateElements } from './elements.js';
import { tellHost } from './host.js';

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
  // (a line sheet's title is its name, e.g. "FW26 · v2 line sheet")
  const [groupBy, setGroupBy] = useState('category');
  // A line sheet (Build 658) arrives linked when it's the live sheet and as a
  // copy when it's a frozen one, since a frozen sheet keeps the prices it sent.
  const [mode, setMode] = useState(() => { const d = readImport(); return d && d.layout === 'linesheet' && d.linkedDefault === false ? 'copy' : 'linked'; });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { store.listBoards().then(setBoards).catch(() => setBoards([])); }, []);

  if (!data) return (
    <div className="empty">Nothing waiting to be added. <button className="link" onClick={() => go('/')}>Back to Boards</button></div>
  );
  const ls = data.layout === 'linesheet';
  const sheet = data.sheet || {};
  const styles = data.items.filter(i => i.styleId);
  const n = data.items.length;
  const pages = ls ? Math.max(1, Math.ceil(n / Math.max(1, Number(sheet.perPage) || 3))) : 0;
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
      sessionStorage.setItem(pendingKey(id), JSON.stringify(ls
        ? { items: data.items, groupBy: 'none', linked: mode === 'linked' && styles.length > 0, layout: 'linesheet', sheet }
        : { items: data.items, groupBy: styles.length > 1 ? groupBy : 'none', linked: mode === 'linked' && styles.length > 0 }));
      sessionStorage.removeItem(KEY);
      // The line sheet keeps a link to its board, so it can open it again.
      if (ls && sheet.key) tellHost('boards:linesheet-board', { key: sheet.key, boardId: id, title: target === 'new' ? (title.trim() || 'Line sheet') : ((boards || []).find(b => b.id === id) || {}).title || '' });
      go('/b/' + id);
    } catch (e) { setErr('Couldn’t make the board: ' + (e.message || e)); setBusy(false); }
  }

  return (
    <div className="home">
      <div className="modal import-sheet">
        {ls ? <h2>Edit {sheet.name || 'this line sheet'} in Boards</h2> : <h2>Add {what} to a board</h2>}
        {ls && <p className="import-note">Each page becomes an A4 landscape slide, {pages === 1 ? 'one page' : pages + ' pages'} with {Number(sheet.perPage) || 3} styles each. Move things around and add images and words; Present or Save as PDF gives you the finished sheet.</p>}
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
            <button className={mode === 'linked' ? 'on' : ''} onClick={() => setMode('linked')}>Linked<small>{ls ? 'Prices, colours and sizes stay in step with Product' : 'Stays in step with the style: name, price, stage'}</small></button>
            <button className={mode === 'copy' ? 'on' : ''} onClick={() => setMode('copy')}>Copy<small>{ls ? (sheet.frozen ? 'Prices as frozen on this sheet, yours to change' : 'As the sheet is now, yours to change') : 'A one-time copy, yours to change'}</small></button>
          </div>
        </>)}

        {styles.length > 1 && !ls && (<>
          <div className="import-label">Sections by</div>
          <div className="seg">
            {GROUPS.map(g => <button key={g.id} className={groupBy === g.id ? 'on' : ''} onClick={() => setGroupBy(g.id)}>{g.label}</button>)}
          </div>
        </>)}

        {err && <div className="note-bar warn">{err}</div>}
        <div className="modal-foot">
          <button className="ghost" onClick={() => { try { sessionStorage.removeItem(KEY); } catch (e) {} go('/'); }}>Cancel</button>
          <button className="solid" disabled={busy || (target === 'new' && !boards)} onClick={send}>{busy ? 'Adding…' : ls ? 'Make the board' : 'Add to board'}</button>
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

// The words under a style on a line-sheet board (Build 658): name, code and
// colours, sizes, then the prices. Linked cards refresh these from Product.
const CUR = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', AUD: 'A$', CAD: 'C$' };
const money = (v, cur) => {
  const n = Number(v); if (!(n > 0)) return '';
  const c = String(cur || 'USD').toUpperCase(), sym = CUR[c];
  const t = (c === 'JPY' ? Math.round(n) : Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: c === 'JPY' || Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  return sym ? sym + t : c + ' ' + t;
};
export const lineSheetCaption = (it, cur) => {
  const sizes = String(it.sizes || '').split(/[,/]/).map(x => x.trim()).filter(Boolean);
  const range = sizes.length > 2 ? sizes[0] + '–' + sizes[sizes.length - 1] : sizes.join(', ');
  const ws = money(it.wholesale, cur), rt = money(it.retail, cur);
  return [it.name || 'Untitled style',
    [it.code, it.colors].filter(Boolean).join(' · '),
    range ? 'Sizes ' + range : '',
    [ws ? 'Wholesale ' + ws : '', rt ? 'Retail ' + rt : ''].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
};
