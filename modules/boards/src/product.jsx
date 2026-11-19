// Add from VENIA (Build 657): pick styles or materials from Product and put
// them on this board, the other way round from Send to Board. VENIA OS hands
// over a plain list when asked (askHost 'boards:catalog'); nothing here reads
// Product's data itself. Shown only while Product and Boards are both on.
import React, { useEffect, useMemo, useState } from 'react';
import { askHost, inHost } from './host.js';
import { styleCaption, materialCaption } from './importer.jsx';

// Is the link on? Asked once; false when Boards runs on its own.
export function useProductLink() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!inHost) return;
    let live = true;
    askHost('boards:link', {}, 4000).then(r => { if (live) setOn(!!(r && r.on)); });
    return () => { live = false; };
  }, []);
  return on;
}

const stage = (v) => { v = String(v || ''); return v === 'sms' ? 'SMS' : v.charAt(0).toUpperCase() + v.slice(1); };
const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));

export function ProductPicker({ onClose, onAdd }) {
  const [tab, setTab] = useState('styles');
  const [data, setData] = useState({});       // kind -> items | 'off' | 'none'
  const [q, setQ] = useState('');
  const [season, setSeason] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [mode, setMode] = useState('linked');

  useEffect(() => {
    if (data[tab]) return;
    let live = true;
    askHost('boards:catalog', { kind: tab }, 8000).then(r => {
      if (!live) return;
      setData(d => ({ ...d, [tab]: !r ? 'none' : !r.on ? 'off' : (r.items || []) }));
    });
    return () => { live = false; };
  }, [tab]);

  const list = Array.isArray(data[tab]) ? data[tab] : [];
  const idOf = (it) => (tab === 'styles' ? 's:' + it.styleId : 'm:' + it.materialId);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return list.filter(it => {
      if (tab === 'styles') {
        if (season && it.season !== season) return false;
        if (category && it.category !== category) return false;
        if (status && it.status !== status) return false;
      } else if (type && it.type !== type) return false;
      if (!t) return true;
      return [it.name, it.code, it.colors, it.content, it.supplier, it.category, it.season, it.type].some(v => String(v || '').toLowerCase().includes(t));
    });
  }, [list, q, season, category, status, type, tab]);

  const toggle = (it) => setPicked(p => { const n = new Set(p); const k = idOf(it); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allOn = shown.length > 0 && shown.every(it => picked.has(idOf(it)));
  const toggleAll = () => setPicked(p => { const n = new Set(p); shown.forEach(it => (allOn ? n.delete(idOf(it)) : n.add(idOf(it)))); return n; });
  const chosen = [
    ...(Array.isArray(data.styles) ? data.styles.filter(it => picked.has('s:' + it.styleId)) : []),
    ...(Array.isArray(data.materials) ? data.materials.filter(it => picked.has('m:' + it.materialId)) : []),
  ];
  const nS = chosen.filter(i => i.styleId).length, nM = chosen.length - nS;
  const what = [nS ? nS + (nS === 1 ? ' style' : ' styles') : '', nM ? nM + (nM === 1 ? ' material' : ' materials') : ''].filter(Boolean).join(' and ');

  const state = data[tab];
  return (
    <div className="modal-wrap" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal vp-modal" role="dialog" aria-label="Add from VENIA">
        <div className="vp-head">
          <h2>Add from VENIA</h2>
          <button className="link" onClick={onClose}>Close</button>
        </div>
        <div className="vp-tabs">
          <button className={tab === 'styles' ? 'on' : ''} onClick={() => setTab('styles')}>Styles</button>
          <button className={tab === 'materials' ? 'on' : ''} onClick={() => setTab('materials')}>Materials</button>
        </div>
        <div className="vp-filters">
          <input className="field" placeholder={tab === 'styles' ? 'Search name, code, colour' : 'Search name, content, supplier'} value={q} onChange={e => setQ(e.target.value)} />
          {tab === 'styles' ? (
            <>
              <select value={season} onChange={e => setSeason(e.target.value)} aria-label="Season"><option value="">All seasons</option>{uniq(list.map(i => i.season)).map(v => <option key={v} value={v}>{v}</option>)}</select>
              <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Category"><option value="">All categories</option>{uniq(list.map(i => i.category)).map(v => <option key={v} value={v}>{v}</option>)}</select>
              <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Stage"><option value="">All stages</option>{uniq(list.map(i => i.status)).map(v => <option key={v} value={v}>{stage(v)}</option>)}</select>
            </>
          ) : (
            <select value={type} onChange={e => setType(e.target.value)} aria-label="Type"><option value="">All types</option>{uniq(list.map(i => i.type)).map(v => <option key={v} value={v}>{v}</option>)}</select>
          )}
        </div>
        <div className="vp-list">
          {!state && <div className="side-empty">Getting the {tab}…</div>}
          {state === 'off' && <div className="side-empty">Product isn’t switched on for this workspace.</div>}
          {state === 'none' && <div className="side-empty">VENIA OS didn’t answer. Open Boards from VENIA OS and try again.</div>}
          {Array.isArray(state) && !shown.length && <div className="side-empty">{list.length ? 'Nothing matches.' : 'There are no ' + tab + ' yet.'}</div>}
          {shown.length > 0 && (
            <label className="vp-all"><input type="checkbox" checked={allOn} onChange={toggleAll} />Select all {shown.length}</label>
          )}
          {shown.slice(0, 400).map(it => {
            const k = idOf(it);
            const cap = (tab === 'styles' ? styleCaption(it) : materialCaption(it)).split('\n');
            return (
              <label key={k} className={'vp-row' + (picked.has(k) ? ' on' : '')}>
                <input type="checkbox" checked={picked.has(k)} onChange={() => toggle(it)} />
                <span className="vp-thumb">{it.image ? <img src={it.image} alt="" loading="lazy" /> : null}</span>
                <span className="vp-words"><b>{cap[0]}</b><small>{[it.code, cap[1]].filter(Boolean).join(' · ')}</small></span>
              </label>
            );
          })}
        </div>
        <div className="vp-foot">
          <div className="vp-mode">
            <label><input type="radio" name="pmode" checked={mode === 'linked'} onChange={() => setMode('linked')} />Linked<small>stays in step with Product</small></label>
            <label><input type="radio" name="pmode" checked={mode === 'copy'} onChange={() => setMode('copy')} />Copy<small>a one-time copy</small></label>
          </div>
          <button className="solid" disabled={!chosen.length} onClick={() => onAdd({ items: chosen, linked: mode === 'linked', groupBy: nS > 1 && !nM ? 'category' : 'none' })}>
            {chosen.length ? 'Add ' + what : 'Pick what to add'}
          </button>
        </div>
      </div>
    </div>
  );
}
